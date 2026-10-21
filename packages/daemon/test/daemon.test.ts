import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema, type Config } from '../src/config.js';
import { createDaemon, mergePlatformsPatch, type Daemon } from '../src/daemon.js';
import { openDb, type Db } from '../src/db/open.js';
import { createRepos } from '../src/db/repos.js';
import { ApprovalRequestResponse, ApprovalStatusResponse, ConnectionsResponse, ContentListResponse, DraftResponse, ErrorBody } from '../src/http/api.js';
import { createFileLogger } from '../src/log.js';
import { isEntryPoint, samePath } from '../src/main.js';
import { AssistLinkedinRoute } from '../src/routes/assist-linkedin.js';
import type { GitRunner } from '../src/site/git.js';
import { issueApiToken, MASTER_KEY_NAME, MemoryKeyStore } from '../src/secrets/keystore.js';
import { SecretStore } from '../src/secrets/secret-store.js';
import { FakeBuffer } from './helpers/fake-buffer.js';
import { FakeNotifier } from './helpers/fake-notifier.js';
import { FakePresence } from './helpers/fake-presence.js';
import { goodLinkedinText, loadItem } from './helpers/service-rig.js';

/** CPU-heavy tests (long loops, simulated days) get room on a loaded machine; the default 5 s stays for the rest. */
const HEAVY_TEST_MS = 60_000;

const FIXTURES = fileURLToPath(new URL('../../core/test/fixtures/', import.meta.url));
const SLUG = 'prometheus-cardinality-explained';
const TITLE = 'How High Cardinality Hurts Prometheus';
const HOST = '127.0.0.1:4646';
const FAKE_BUFFER_KEY = 'not-a-real-buffer-key-0123456789abcdef';

let root: string;
let site: string;
let state: string;
let db: Db;
let clock: { now: Date };
let fetched: string[];
let buffer: FakeBuffer;
let daemons: Daemon[];

const postPath = (): string => join(site, 'content', 'posts', `${SLUG}.mdx`);
const fakeGit: GitRunner = (args) => Promise.resolve({ stdout: args.includes('rev-parse') ? 'abc1234\n' : '' });

beforeEach(() => {
  // Spaces in every path, like the real ones.
  root = mkdtempSync(join(tmpdir(), 'cph daemon '));
  site = join(root, 'site repo');
  state = join(root, 'state dir');
  mkdirSync(join(site, 'content', 'posts'), { recursive: true });
  mkdirSync(join(site, 'content', 'publishing-notes'), { recursive: true });
  mkdirSync(state, { recursive: true });
  copyFileSync(join(FIXTURES, 'sample-post.mdx'), postPath());
  copyFileSync(join(FIXTURES, 'sample-notes.md'), join(site, 'content', 'publishing-notes', `${SLUG}.md`));
  db = openDb(':memory:');
  clock = { now: new Date('2026-10-20T10:00:00.000Z') };
  fetched = [];
  buffer = new FakeBuffer(FAKE_BUFFER_KEY);
  daemons = [];
});

afterEach(() => {
  for (const d of daemons) d.stop();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** The site's own pages are live with the right title; Buffer is the scripted fake; anything else fails loudly. */
const fetchFn: typeof fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  fetched.push(url);
  if (url.startsWith('https://api.buffer.com')) return buffer.fetchFn(input, init);
  if (url.startsWith('https://www.example-blog.dev/blog/')) {
    const res = new Response(`<html><head><title>${TITLE}</title></head><body><h1>${TITLE}</h1></body></html>`, { status: 200 });
    Object.defineProperty(res, 'url', { value: url });
    return Promise.resolve(res);
  }
  return Promise.reject(new Error(`unexpected fetch ${url}`));
};

interface Built {
  daemon: Daemon;
  mcp: string;
  cli: string;
  ks: MemoryKeyStore;
  opened: string[];
  notifier: FakeNotifier;
  logs: string[];
  call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: unknown; text: string }>;
}

function build(options: { config?: unknown; masterKey?: boolean; presence?: FakePresence } = {}): Built {
  const config: Config = ConfigSchema.parse({ site: { repoPath: site, timeZone: 'UTC' }, ...(options.config as object) });
  const ks = new MemoryKeyStore();
  if (options.masterKey !== false) ks.set(MASTER_KEY_NAME, randomBytes(32).toString('base64'));
  const mcp = issueApiToken(ks, 'mcp');
  const cli = issueApiToken(ks, 'cli');
  const opened: string[] = [];
  const notifier = new FakeNotifier();
  const logs: string[] = [];
  const opener = (url: string): Promise<void> => {
    opened.push(url);
    return Promise.resolve();
  };
  const daemon = createDaemon({
    config,
    stateDir: state,
    db,
    keystore: ks,
    fetchFn,
    presence: options.presence ?? new FakePresence('verified'),
    notifier,
    opener,
    now: () => clock.now,
    gitRunner: fakeGit,
    assistLinkedin: new AssistLinkedinRoute({ clipboard: { write: () => Promise.resolve() }, opener }),
    log: (level, message) => logs.push(`${level} ${message}`),
  });
  daemons.push(daemon);
  const call = async (method: string, path: string, body?: unknown, token = mcp) => {
    const res = await daemon.app.request(path, {
      method,
      headers: { host: HOST, authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, json: text === '' ? undefined : (JSON.parse(text) as unknown), text };
  };
  return { daemon, mcp, cli, ks, opened, notifier, logs, call };
}

describe('createDaemon: the whole daemon over app.request()', { timeout: HEAVY_TEST_MS }, () => {
  it('sweeps, syncs, drafts, requests an approval and opens the dashboard', async () => {
    // A publish cut off by a crash before this start.
    const repos = createRepos(db, { now: () => clock.now.toISOString() });
    const item = loadItem();
    repos.content.upsert({
      slug: SLUG,
      canonicalUrl: item.canonicalUrl,
      title: TITLE,
      date: item.frontmatter.date,
      mdxSha256: item.source.mdxSha256,
      repoCommit: 'abc1234',
      dirty: false,
      published: true,
    });
    repos.drafts.insert({
      id: 'crashed',
      slug: SLUG,
      platform: 'linkedin',
      account: 'default',
      route: 'assist',
      kind: 'post',
      status: 'publishing',
      payload: { text: 'x' },
      payloadSha256: 'a'.repeat(64),
      authorship: 'reformatted',
      lint: [],
    });

    const b = build();
    const report = await b.daemon.startup();
    expect(report.recovered).toEqual(['crashed']);
    expect(repos.drafts.get('crashed')?.status).toBe('unknown');
    expect(b.notifier.toasts.map((t) => t.title)).toContain('Publish results need checking');

    const sync = await b.call('POST', '/api/sync');
    expect(sync.status).toBe(200);
    expect(sync.json).toMatchObject({ upserted: 1, errors: [] });
    expect(fetched).toEqual([`https://www.example-blog.dev/blog/${SLUG}`]);

    const content = ContentListResponse.parse((await b.call('GET', '/api/content')).json);
    expect(content.content.map((c) => c.slug)).toEqual([SLUG]);
    expect(content.content[0]?.canonicalLiveAt).toBe(clock.now.toISOString());

    // No LinkedIn config: the assist route (never posts by itself).
    const created = await b.call('POST', '/api/drafts', { slug: SLUG, platform: 'linkedin', payload: { text: goodLinkedinText(loadItem()) } });
    expect(created.status).toBe(201);
    const draft = DraftResponse.parse(created.json);
    expect(draft).toMatchObject({ route: 'assist', status: 'draft' });

    const requested = await b.call('POST', '/api/approvals', { draftId: draft.id });
    expect(requested.status).toBe(201);
    const { approvalId } = ApprovalRequestResponse.parse(requested.json);
    expect(ApprovalStatusResponse.parse((await b.call('GET', `/api/approvals/${approvalId}`)).json).status).toBe('pending');

    const connections = ConnectionsResponse.parse((await b.call('GET', '/api/connections')).json);
    expect(connections.secretsReady).toBe(true);
    expect(connections.connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ platform: 'linkedin', route: 'assist', active: true, state: 'manual_only' }),
        expect.objectContaining({ platform: 'linkedin', route: 'buffer', active: false }),
        expect.objectContaining({ platform: 'devto', route: 'direct', active: true }),
      ]),
    );

    const opened = await b.call('POST', '/api/open-dashboard', { page: `approvals/${approvalId}` });
    expect(opened.json).toEqual({ opened: true, page: `approvals/${approvalId}` });
    expect(b.opened).toHaveLength(1);
    const nonce = new URL(b.opened[0] as string).searchParams.get('nonce') as string;
    expect(b.daemon.nonces.consume(nonce)).toBe(true);

    // Publishing is off by default; the API cannot change that.
    expect((await b.call('POST', '/api/publish', { draftId: draft.id, approvalId })).status).toBe(409);
    expect(fetched.filter((u) => !u.startsWith('https://www.example-blog.dev/'))).toEqual([]);
  });

  it('signs in to the wired dashboard through open-dashboard and shows the approval card', async () => {
    const b = build();
    await b.daemon.startup();
    await b.call('POST', '/api/sync');
    const draft = DraftResponse.parse((await b.call('POST', '/api/drafts', { slug: SLUG, platform: 'linkedin', payload: { text: goodLinkedinText(loadItem()) } })).json);
    const { approvalId } = ApprovalRequestResponse.parse((await b.call('POST', '/api/approvals', { draftId: draft.id })).json);
    await b.call('POST', '/api/open-dashboard', { page: `approvals/${approvalId}` });
    const url = new URL(b.opened[0] as string);

    const login = await b.daemon.app.request(`${url.pathname}${url.search}`, { headers: { host: HOST } });
    expect(login.status).toBe(303);
    expect(login.headers.get('location')).toBe(`/approvals/${approvalId}`);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] as string;
    const page = await b.daemon.app.request(`/approvals/${approvalId}`, { headers: { host: HOST, cookie } });
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain(`data-approval-id="${approvalId}"`);
    expect(text).toContain('Approve &amp; hand off');
    // The nonce is spent, and the log never saw it.
    expect((await b.daemon.app.request(`${url.pathname}${url.search}`, { headers: { host: HOST } })).status).toBe(403);
    expect(b.logs.join(' | ')).not.toContain(url.searchParams.get('nonce') as string);
  });

  it('checks the post on disk freshly at approval time (never a cache)', async () => {
    const b = build();
    await b.daemon.startup();
    await b.call('POST', '/api/sync');
    const draft = DraftResponse.parse((await b.call('POST', '/api/drafts', { slug: SLUG, platform: 'linkedin', payload: { text: goodLinkedinText(loadItem()) } })).json);

    // Edited on disk after the sync, before the next one.
    writeFileSync(postPath(), `${readFileSync(postPath(), 'utf8')}\nOne more paragraph.\n`);
    const res = await b.call('POST', '/api/approvals', { draftId: draft.id });
    expect(res.status).toBe(409);
    expect(ErrorBody.parse(res.json).code).toBe('SOURCE_CHANGED');
  });

  it('starts degraded without a master key: connections say not_configured, stage refuses clearly', async () => {
    const b = build({ masterKey: false });
    await b.daemon.startup();
    const connections = ConnectionsResponse.parse((await b.call('GET', '/api/connections')).json);
    expect(connections.secretsReady).toBe(false);
    expect(connections.connections.find((c) => c.platform === 'devto')).toMatchObject({ state: 'not_configured' });
    await b.call('POST', '/api/sync');
    const draft = DraftResponse.parse((await b.call('POST', '/api/drafts', { slug: SLUG, platform: 'devto' })).json);
    const staged = await b.call('POST', `/api/drafts/${draft.id}/stage`);
    expect(staged.status).toBe(503);
    expect(ErrorBody.parse(staged.json).message).toMatch(/cph install/);
  });

  it('probes Buffer (metered) once at startup and then at most once a day', async () => {
    const config = { platforms: { linkedin: { route: 'buffer', bufferChannelId: 'chan-linkedin-0001' }, buffer: { organizationId: 'org-1' } } };
    const b = build({ config });
    new SecretStore(b.ks, createRepos(db, { now: () => clock.now.toISOString() })).put('linkedin', 'default', { apiKey: FAKE_BUFFER_KEY });

    await b.daemon.startup();
    await b.daemon.tick();
    const probes = (): number => buffer.requests.filter((r) => r.op === 'Channels').length;
    expect(probes()).toBe(1);
    for (let i = 0; i < 4; i++) {
      clock.now = new Date(clock.now.getTime() + 15 * 60_000);
      await b.daemon.tick();
    }
    expect(probes()).toBe(1);
    clock.now = new Date(clock.now.getTime() + 24 * 60 * 60_000);
    await b.daemon.tick();
    expect(probes()).toBe(2);

    const connections = ConnectionsResponse.parse((await b.call('GET', '/api/connections')).json);
    expect(connections.connections.find((c) => c.route === 'buffer')).toMatchObject({ active: true, state: 'connected' });
    expect(JSON.stringify(connections)).not.toContain(FAKE_BUFFER_KEY);
  });

  it('a failing dev.to health step does not skip the Buffer probe in the same tick', async () => {
    const config = { platforms: { linkedin: { route: 'buffer', bufferChannelId: 'chan-linkedin-0001' }, buffer: { organizationId: 'org-1' } } };
    const b = build({ config });
    new SecretStore(b.ks, createRepos(db, { now: () => clock.now.toISOString() })).put('linkedin', 'default', { apiKey: FAKE_BUFFER_KEY });
    await b.daemon.startup();
    vi.spyOn(b.daemon.connections, 'gateHealth').mockRejectedValue(new Error('database is locked'));
    await expect(b.daemon.tick()).resolves.toBeUndefined();
    expect(b.logs).toContain('error dev.to health failed: database is locked');
    expect(buffer.requests.filter((r) => r.op === 'Channels')).toHaveLength(1);
  });

  it("saves Buffer's config patches into config.json, deep-merged", () => {
    writeFileSync(join(state, 'config.json'), `${JSON.stringify({ site: { repoPath: site }, platforms: { devto: { tagPreference: ['sre'] } } })}\n`);
    const b = build();
    b.daemon.saveConfig({ buffer: { organizationId: 'org-9' } });
    b.daemon.saveConfig({ linkedin: { bufferChannelId: 'chan-1' } });
    const written = JSON.parse(readFileSync(join(state, 'config.json'), 'utf8')) as Record<string, unknown>;
    expect(written).toEqual({
      site: { repoPath: site },
      platforms: { devto: { tagPreference: ['sre'] }, buffer: { organizationId: 'org-9' }, linkedin: { route: 'buffer', bufferChannelId: 'chan-1' } },
    });
    expect(b.daemon.config().platforms.linkedin).toEqual({ route: 'buffer', bufferChannelId: 'chan-1', linkCard: false });
    expect(existsSync(join(state, 'config.json.tmp'))).toBe(false);
  });
});

describe('approval mode', () => {
  /** Signs in like open-dashboard does and returns the card page and a poster for dashboard forms. */
  async function dashboard(b: Built, approvalId: string) {
    await b.call('POST', '/api/open-dashboard', { page: `approvals/${approvalId}` });
    const url = new URL(b.opened.at(-1) as string);
    const login = await b.daemon.app.request(`${url.pathname}${url.search}`, { headers: { host: HOST } });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] as string;
    const page = await (await b.daemon.app.request(`/approvals/${approvalId}`, { headers: { host: HOST, cookie } })).text();
    const csrf = /<meta name="csrf-token" content="([^"]+)">/.exec(page)?.[1] as string;
    // The card's HTML escapes the boxes; the chat card route lists them verbatim.
    const checklist = ((await b.call('GET', `/api/approvals/${approvalId}/card`)).json as { checklist: string[] }).checklist;
    const post = async (path: string, fields: Record<string, string | string[]>) => {
      const params = new URLSearchParams({ _csrf: csrf });
      for (const [k, v] of Object.entries(fields)) for (const item of Array.isArray(v) ? v : [v]) params.append(k, item);
      const res = await b.daemon.app.request(path, {
        method: 'POST',
        headers: { host: HOST, cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      return { status: res.status, text: await res.text() };
    };
    return { page, checklist, post };
  }

  async function pendingApproval(b: Built): Promise<string> {
    await b.daemon.startup();
    await b.call('POST', '/api/sync');
    const draft = DraftResponse.parse((await b.call('POST', '/api/drafts', { slug: SLUG, platform: 'linkedin', payload: { text: goodLinkedinText(loadItem()) } })).json);
    return ApprovalRequestResponse.parse((await b.call('POST', '/api/approvals', { draftId: draft.id })).json).approvalId;
  }

  it('defaults to click mode', () => {
    expect(ConfigSchema.parse({}).approval.mode).toBe('click');
  });

  it('click mode: a dashboard click approves with no Hello prompt, and the approval records dashboard_click', async () => {
    const presence = new FakePresence(new Error('Windows Hello must not be asked in click mode'));
    const b = build({ presence });
    const approvalId = await pendingApproval(b);
    const dash = await dashboard(b, approvalId);
    expect(dash.page).toContain('Your click is the confirmation');
    expect(dash.page).not.toContain('Windows Hello will name');
    expect(dash.checklist.length).toBeGreaterThanOrEqual(2);

    const res = await dash.post(`/approvals/${approvalId}/approve`, { action: 'only', checked: dash.checklist });
    expect(res.status).toBe(200);
    expect(b.daemon.repos.approvals.get(approvalId)).toMatchObject({ status: 'approved', channel: 'dashboard_click', mode: 'approve_only' });
    expect(presence.prompts).toEqual([]);
    expect(b.daemon.repos.audit.list({ limit: 50 }).find((row) => row.action === 'approved')).toMatchObject({ actorChannel: 'dashboard_click' });
  });

  it('click mode: enabling publishing is click-confirmed and audited as dashboard_click', async () => {
    const presence = new FakePresence(new Error('Windows Hello must not be asked in click mode'));
    const b = build({ presence });
    const approvalId = await pendingApproval(b);
    const dash = await dashboard(b, approvalId);
    const res = await dash.post('/settings/publishing', { enabled: 'true' });
    expect(res.status).toBe(200);
    expect(b.daemon.repos.settings.get('publishing_enabled')).toBe('true');
    expect(presence.prompts).toEqual([]);
    expect(b.daemon.repos.audit.list({ limit: 50 }).find((row) => row.action === 'publishing_enabled')).toMatchObject({ actorChannel: 'dashboard_click' });
  });

  it('hello mode: the injected presence is asked, a cancel leaves the approval pending, and the channel is dashboard_hello', async () => {
    const presence = new FakePresence('canceled');
    const b = build({ config: { approval: { mode: 'hello' } }, presence });
    const approvalId = await pendingApproval(b);
    const dash = await dashboard(b, approvalId);
    expect(dash.page).toContain('Windows Hello will name');

    const canceled = await dash.post(`/approvals/${approvalId}/approve`, { action: 'only', checked: dash.checklist });
    expect(canceled.status).toBe(409);
    expect(canceled.text).toContain('PRESENCE_FAILED');
    expect(presence.prompts).toHaveLength(1);
    expect(b.daemon.repos.approvals.get(approvalId)?.status).toBe('pending');

    presence.set('verified');
    expect((await dash.post(`/approvals/${approvalId}/approve`, { action: 'only', checked: dash.checklist })).status).toBe(200);
    expect(b.daemon.repos.approvals.get(approvalId)).toMatchObject({ status: 'approved', channel: 'dashboard_hello' });
  });

  it('chat approval works in either mode and never asks Windows Hello', async () => {
    for (const mode of ['click', 'hello'] as const) {
      const presence = new FakePresence(new Error('Windows Hello must not be asked for a chat approval'));
      const b = build({ config: { approval: { mode } }, presence });
      const approvalId = await pendingApproval(b);
      const card = (await b.call('GET', `/api/approvals/${approvalId}/card`)).json as { checklist: string[]; payloadText: string };
      expect(card.payloadText).toBe(goodLinkedinText(loadItem()));
      const path = `/api/approvals/${approvalId}/approve-chat`;
      expect((await b.call('POST', path, { checked: card.checklist, mode: 'approve_only' }, b.cli)).status).toBe(403);
      expect((await b.call('POST', path, { checked: card.checklist, mode: 'approve_only' })).status).toBe(200);
      expect(b.daemon.repos.approvals.get(approvalId)).toMatchObject({ status: 'approved', channel: 'chat_elicitation', mode: 'approve_only' });
      expect(presence.prompts).toEqual([]);
    }
  });
});

describe('mergePlatformsPatch', () => {
  it('creates LinkedIn config with route buffer, but keeps an existing route choice', () => {
    expect(mergePlatformsPatch({}, { linkedin: { bufferChannelId: 'c' } })).toEqual({ platforms: { linkedin: { route: 'buffer', bufferChannelId: 'c' } } });
    expect(mergePlatformsPatch({ platforms: { linkedin: { route: 'assist', linkCard: true } } }, { linkedin: { bufferChannelId: 'c' } })).toEqual({
      platforms: { linkedin: { route: 'assist', linkCard: true, bufferChannelId: 'c' } },
    });
    expect(mergePlatformsPatch({ daemon: { port: 4646 }, platforms: { buffer: { organizationId: 'a' } } }, { buffer: { organizationId: 'b' } })).toEqual({
      daemon: { port: 4646 },
      platforms: { buffer: { organizationId: 'b' } },
    });
  });
});

describe('logging and the entry point', () => {
  it('writes redacted lines to the log file', () => {
    const file = join(root, 'logs dir', 'daemon.log');
    const log = createFileLogger(file, { now: () => clock.now });
    const token = `cph_cli_${'Ab1'.repeat(14)}A`;
    log('error', `failed with Authorization: Bearer ${token}`);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('2026-10-20T10:00:00.000Z error failed with Authorization: Bearer [REDACTED]');
    expect(text).not.toContain(token);
  });

  it('main.ts runs only as the entry point', () => {
    const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
    expect(isEntryPoint(pathToFileURL(main).href, main)).toBe(true);
    expect(isEntryPoint(pathToFileURL(main).href, main.toUpperCase())).toBe(process.platform === 'win32');
    expect(isEntryPoint(pathToFileURL(main).href, join(root, 'other.js'))).toBe(false);
    expect(isEntryPoint(pathToFileURL(main).href, undefined)).toBe(false);
  });

  it('starts when launched through a junction or symlink (pnpm link)', () => {
    const real = join(root, 'real dir');
    mkdirSync(real);
    const file = join(real, 'main.js');
    writeFileSync(file, '');
    const linked = join(root, 'linked dir');
    // A junction needs no admin rights on Windows; elsewhere a directory symlink.
    symlinkSync(real, linked, process.platform === 'win32' ? 'junction' : 'dir');
    expect(isEntryPoint(pathToFileURL(file).href, join(linked, 'main.js'))).toBe(true);
    expect(isEntryPoint(pathToFileURL(join(linked, 'main.js')).href, file)).toBe(true);
    expect(isEntryPoint(pathToFileURL(file).href, join(linked, 'other.js'))).toBe(false);
  });

  it('samePath compares case-insensitively only on win32', () => {
    expect(samePath('C:\\A\\b.js', 'c:\\a\\B.js', 'win32')).toBe(true);
    expect(samePath('/a/b.js', '/a/B.js', 'linux')).toBe(false);
    expect(samePath('/a/b.js', '/a/b.js', 'linux')).toBe(true);
  });

  it('a timer tick never rejects, even when the database fails', async () => {
    const b = build();
    await b.daemon.startup();
    db.close();
    await expect(b.daemon.tick()).resolves.toBeUndefined();
    expect(b.logs.some((line) => line.startsWith('error '))).toBe(true);
  });

  it('the request log never contains a query string (no login nonce)', async () => {
    const b = build();
    const nonce = 'not-a-real-nonce-0123456789abcdef';
    await b.daemon.app.request(`/login?nonce=${nonce}&next=/approvals`, { headers: { host: HOST } });
    await b.call('GET', `/api/drafts?slug=${nonce}`);
    expect(b.logs.length).toBeGreaterThanOrEqual(2);
    for (const line of b.logs) {
      expect(line).not.toContain('?');
      expect(line).not.toContain(nonce);
    }
  });
});
