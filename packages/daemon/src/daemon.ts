import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildContentItem, type ContentItem, type Draft, type PlatformId } from '@cph/core';
import type { Hono } from 'hono';
import { createAudit, errorText } from './audit.js';
import { ConfigError, ConfigSchema, type Config } from './config.js';
import type { Db } from './db/open.js';
import { createRepos, type Repos } from './db/repos.js';
import { ApprovalGate } from './gate/approval-gate.js';
import { ClickPresence, type PresenceVerifier } from './gate/presence.js';
import { createApp } from './http/app.js';
import { createTokenVerifier, DEFAULT_DAEMON_PORT, LoginNonceStore, SessionStore } from './http/auth.js';
import { createDashboardRouter } from './http/dashboard.js';
import { silentLogger, type Logger } from './log.js';
import { bufferAlertNotifier, type Notifier } from './notify.js';
import { configPath } from './paths.js';
import { createAssistLinkedinRoute, type AssistLinkedinRoute } from './routes/assist-linkedin.js';
import { BufferRoute, type PlatformsConfigPatch } from './routes/buffer.js';
import { DevtoRoute } from './routes/devto.js';
import { RouteRegistry } from './routes/registry.js';
import { MASTER_KEY_NAME, type KeyStore } from './secrets/keystore.js';
import { SecretStore } from './secrets/secret-store.js';
import { ApiBudget } from './services/api-budget.js';
import { ConnectionsService } from './services/connections.js';
import { DraftsService, lintDraftFor } from './services/drafts.js';
import { createHealthScheduler, settingsMemory, type HealthScheduler } from './services/health-scheduler.js';
import { markFailedIn, PublishService } from './services/publish.js';
import { RecoveryService, type SweepReport } from './services/recovery.js';
import type { GitRunner } from './site/git.js';
import { guardedFs } from './site/guarded-fs.js';
import { SiteReader } from './site/site-reader.js';
import { syncContent, type SyncResult } from './sync.js';

/** Content sync and the free health probes run this often; the metered Buffer probe at most daily. */
export const TICK_MS = 15 * 60_000;
const ACCOUNT = 'default';
const BUFFER_PROBE_MEMORY_KEY = `health_probe_at:buffer:${ACCOUNT}`;

export interface DaemonDeps {
  /** Loaded and validated by the caller (main.ts), after `configureSiteGuard`. */
  config: Config;
  /** Holds config.json (written when Buffer saves its organization or channel). */
  stateDir: string;
  /** Opened by the caller (main.ts: `stateDir()/cph.db`; tests: `:memory:`). */
  db: Db;
  keystore: KeyStore;
  fetchFn: typeof fetch;
  presence: PresenceVerifier;
  notifier: Notifier;
  /** Opens the default browser at a URL (open-dashboard). */
  opener: (url: string) => Promise<void>;
  now?: () => Date;
  log?: Logger;
  /** The site repo's git (tests pass a fake). */
  gitRunner?: GitRunner;
  /** Default: `createAssistLinkedinRoute()` (the real clipboard and browser). */
  assistLinkedin?: AssistLinkedinRoute;
}

export interface Daemon {
  app: Hono;
  repos: Repos;
  /** The live config (Buffer's saves update it). */
  config(): Config;
  nonces: LoginNonceStore;
  /** Dashboard sessions (in memory; minted by GET /login). */
  sessions: SessionStore;
  routes: RouteRegistry;
  gate: ApprovalGate;
  drafts: DraftsService;
  publish: PublishService;
  recovery: RecoveryService;
  connections: ConnectionsService;
  bufferHealth: HealthScheduler;
  /** Buffer's `saveConfig`: deep-merges into config.json and the live config. */
  saveConfig(patch: PlatformsConfigPatch): void;
  /** One content sync; concurrent callers share the run in flight. */
  runSync(): Promise<SyncResult>;
  /** Before the server accepts requests: the recovery sweep ('publishing' -> 'unknown', then check). */
  startup(): Promise<SweepReport>;
  /** One timer cycle: sync, free health probes, Buffer's daily metered probe. Never throws. */
  tick(): Promise<void>;
  /** Runs `tick` now and every 15 minutes. */
  startTimers(): void;
  stop(): void;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Applies a route's config patch to the raw config.json object. Nested objects are merged, never
 * replaced. LinkedIn config created by this patch gets `route: 'buffer'` (Buffer is what is being
 * set up); an existing route choice is kept.
 */
export function mergePlatformsPatch(raw: Json, patch: PlatformsConfigPatch): Json {
  const platforms: Json = isObject(raw['platforms']) ? { ...raw['platforms'] } : {};
  if (patch.buffer !== undefined) {
    platforms['buffer'] = { ...(isObject(platforms['buffer']) ? platforms['buffer'] : {}), ...patch.buffer };
  }
  if (patch.linkedin !== undefined) {
    const existing = platforms['linkedin'];
    platforms['linkedin'] = isObject(existing) ? { ...existing, ...patch.linkedin } : { route: 'buffer', ...patch.linkedin };
  }
  return { ...raw, platforms };
}

function readRawConfig(file: string): Json {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new ConfigError(`cannot read ${file}: ${(err as Error).message}`);
  }
  const parsed: unknown = JSON.parse(text.replace(/^﻿/, ''));
  if (!isObject(parsed)) throw new ConfigError(`${file} is not a JSON object`);
  return parsed;
}

/** True when the master key exists and is 32 bytes of base64. Never throws, never returns the key. */
function masterKeyPresent(keystore: KeyStore): boolean {
  try {
    const encoded = keystore.get(MASTER_KEY_NAME);
    return encoded !== null && Buffer.from(encoded, 'base64').length === 32;
  } catch {
    return false;
  }
}

/**
 * The gate's and the drafts' `loadContentItem`: the post and its notes read from disk NOW,
 * synchronously, and built exactly as sync builds them. Never a cache: the gate compares these
 * hashes with the last sync to catch an edit that sync has not seen yet (Review Focus #1).
 */
export function createContentLoader(reader: SiteReader, repos: Repos, config: () => Config): (slug: string) => ContentItem | undefined {
  return (slug) => {
    try {
      const mdxRaw = reader.readPostSync(slug);
      const notesRaw = reader.readNotesSync(slug);
      const row = repos.content.get(slug);
      return buildContentItem({
        slug,
        mdxRaw,
        ...(notesRaw === null ? {} : { notesRaw }),
        repoCommit: row?.repoCommit ?? 'unknown',
        dirty: row?.dirty ?? false,
        baseUrl: config().site.baseUrl,
      });
    } catch {
      return undefined;
    }
  };
}

/**
 * Builds the whole daemon from its dependencies, without binding a port, starting a timer or
 * touching anything outside `deps` (main.ts supplies the real ones). The order follows the T0.18
 * rulings: repos, keystore-backed secrets, routes, connections, gate, services, HTTP app.
 */
export function createDaemon(deps: DaemonDeps): Daemon {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? silentLogger;
  const configFile = configPath(deps.stateDir);
  let config = deps.config;
  const getConfig = (): Config => config;

  const repos = createRepos(deps.db, { now: () => now().toISOString() });
  const audit = createAudit(repos);
  // No ensureMasterKey here: only `cph install` creates it. Without one the daemon runs degraded.
  const secrets = new SecretStore(deps.keystore, repos);
  const secretsReady = (): boolean => masterKeyPresent(deps.keystore);
  if (!secretsReady()) log('warn', 'master key missing: running degraded (no connect, stage or publish) until `cph install` creates it');

  const saveConfig = (patch: PlatformsConfigPatch): void => {
    const merged = mergePlatformsPatch(readRawConfig(configFile), patch);
    const parsed = ConfigSchema.safeParse(merged);
    if (!parsed.success) throw new ConfigError(`refusing to write an invalid config: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    guardedFs.mkdirSync(dirname(configFile), { recursive: true });
    const tmp = `${configFile}.tmp`;
    guardedFs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    guardedFs.renameSync(tmp, configFile);
    config = parsed.data;
    log('info', `config.json updated (${Object.keys(patch).join(', ')})`);
  };

  // ---- routes ----
  const markFailed = markFailedIn(repos, audit);
  const budget = new ApiBudget(repos, now);
  const devto = new DevtoRoute({ secrets, fetchFn: deps.fetchFn, now, markFailed });
  const buffer = new BufferRoute({
    secrets,
    fetchFn: deps.fetchFn,
    now,
    budget,
    config: getConfig,
    saveConfig,
    markFailed,
    audit,
    alert: bufferAlertNotifier(deps.notifier),
    store: repos.settings,
  });
  const assist = deps.assistLinkedin ?? createAssistLinkedinRoute();
  const routes = new RouteRegistry([devto, buffer, assist]);

  // ---- site, services, gate ----
  const reader = new SiteReader(config.site.repoPath, deps.gitRunner);
  const loadContentItem = createContentLoader(reader, repos, getConfig);
  const connections = new ConnectionsService({ repos, routes, config: getConfig, audit, now });
  // Click mode (the default; for PCs without Windows Hello): the dashboard POST is the human action.
  // Hello mode keeps the injected presence (Windows Hello in main.ts). The mode is read once at startup.
  const clickMode = config.approval.mode === 'click';
  const presence: PresenceVerifier = clickMode ? new ClickPresence() : deps.presence;
  const dashboardChannel = clickMode ? 'dashboard_click' : 'dashboard_hello';
  const gateDeps = {
    repos,
    now,
    health: (platform: PlatformId, account: string) => connections.gateHealth(platform, account),
    loadContentItem,
    // Built per call, so a config change (the LinkedIn link card) is linted the way drafts are.
    lintDraft: (draft: Draft, item: ContentItem) => lintDraftFor(getConfig())(draft, item),
  };
  const gate = new ApprovalGate({ ...gateDeps, presence });
  // The chat approval path: the human check already happened in Claude Code (the MCP server's elicitation).
  const chatGate = new ApprovalGate({ ...gateDeps, presence: new ClickPresence() });
  const drafts = new DraftsService({ repos, routes, config: getConfig, loadContentItem, audit, notifier: deps.notifier });
  const publish = new PublishService({ repos, gate, routes, config: getConfig, audit, notifier: deps.notifier, now, dashboardChannel });
  const recovery = new RecoveryService({ repos, routes, audit, notifier: deps.notifier, now });

  let inflight: Promise<SyncResult> | undefined;
  const runSync = (): Promise<SyncResult> => {
    inflight ??= syncContent({
      reader,
      repos,
      fetchFn: deps.fetchFn,
      now,
      timeZone: config.site.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      baseUrl: config.site.baseUrl,
    }).finally(() => {
      inflight = undefined;
    });
    return inflight;
  };

  // The only timer-driven call of Buffer's metered health(): at most once a day, remembered across restarts.
  const bufferHealth = createHealthScheduler({
    route: buffer,
    account: ACCOUNT,
    now,
    memory: settingsMemory(repos, BUFFER_PROBE_MEMORY_KEY),
    onError: (error) => log('warn', `buffer health probe failed: ${errorText(error)}`),
  });

  const nonces = new LoginNonceStore({ now });
  const sessions = new SessionStore({ now });
  const dashboard = createDashboardRouter({
    sessions,
    nonces,
    repos,
    gate,
    publish,
    drafts,
    recovery,
    connections,
    presence,
    channel: dashboardChannel,
    routes,
    bufferChannels: buffer,
    budget,
    config: getConfig,
    secretsReady,
    audit,
    now,
    log,
  });
  const app = createApp({
    port: config.daemon.port ?? DEFAULT_DAEMON_PORT,
    tokens: createTokenVerifier(deps.keystore),
    nonces,
    opener: deps.opener,
    repos,
    drafts,
    publish,
    recovery,
    gate,
    chatGate,
    connections,
    sync: runSync,
    loadContentItem,
    secretsReady,
    now,
    log,
    dashboard,
  });

  // Runs on a timer with nobody awaiting it: a rejection would be unhandled, and Node 22 ends the
  // process on one. So each step is caught and logged on its own (through the redacting logger),
  // and a failure in one step never skips the next.
  const step = async (name: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      log('error', `${name} failed: ${errorText(error)}`);
    }
  };
  const tick = async (): Promise<void> => {
    await step('sync', async () => {
      const result = await runSync();
      if (result.errors.length > 0 || result.changed.length > 0) {
        log('info', `sync: ${result.upserted} posts, changed [${result.changed.join(', ')}], ${result.errors.length} errors`);
      }
    });
    // dev.to's probe is free: refresh its cached health (storing it can still hit a DB error).
    await step('dev.to health', () => connections.gateHealth('devto', ACCOUNT));
    await step('buffer health', () => bufferHealth.tick());
  };

  let timer: NodeJS.Timeout | undefined;
  return {
    app,
    repos,
    config: getConfig,
    nonces,
    sessions,
    routes,
    gate,
    drafts,
    publish,
    recovery,
    connections,
    bufferHealth,
    saveConfig,
    runSync,
    startup: () => recovery.sweepOnStartup(),
    tick,
    startTimers() {
      if (timer !== undefined) return;
      void tick();
      timer = setInterval(() => void tick(), TICK_MS);
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
