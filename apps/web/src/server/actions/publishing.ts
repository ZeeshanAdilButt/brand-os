import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PLATFORM_IDS, PLATFORMS, isPlatformId, isPublishable, isSyndication } from '../../lib/catalog';
import {
  APPROVAL_TTL_MS,
  STAGEABLE_STATUSES,
  approvalChecklist,
  approvalTag,
  type ConnectionDTO,
  type DestinationDTO,
  type DraftExtras,
  type DraftPayload,
  type DraftStatus,
  type PlatformDraftDTO,
  type PlatformId,
} from '../../lib/publishing';
import { defaultSiteSettings, resolvePathTemplate, slugForPath, type SiteDraftOptions, type SiteSettingsDTO } from '../../lib/site-export';
import { redactSecrets } from '../ai/redact';
import { encryptKey, masterKey, SecretUnavailableError } from '../ai/crypto';
import { PublishRefusal } from '../data/tenant';
import type { Article, PlatformDraft, SiteSettings } from '../db/schema';
import { checkCanonicalPage } from '../publishing/canonical';
import { PlatformError } from '../publishing/errors';
import { adapterFor, contextFor, contextWith, KeyUnreadableError, plainSecret, type PublishEnv } from '../publishing/registry';
import { payloadHashOf, sourceHashOf } from '../publishing/source';
import { describeFailure, toConnectionDTO, toDraftDTO } from '../publishing/views';
import { ActionError, parseId, parseInput, type OwnerContext } from './owner';

/*
 * Publishing actions: connections, platform drafts, staging, approval requests, the one approved publish,
 * and the recovery paths for an unknown result. The browser, the agent API and the MCP server all come
 * through here, and the rules that matter live here and in the data layer, not in the callers:
 *
 *  - only a signed-in person (actor "owner") can connect, approve, decline or resolve by hand;
 *  - an agent can prepare drafts, stage private copies and REQUEST approval, nothing else;
 *  - `approveAndPublish` is the only code that can make anything public, and it calls the adapter once;
 *  - a destination without a connector (`isPublishable` false) can be prepared, previewed, edited and posted by
 *    hand, and can never be staged, approved for publishing or published, by any route.
 */

const STAGE_ATTEMPTS = 3;
const STAGE_BACKOFF_MS = [1000, 3000];
const STAGE_MAX_WAIT_MS = 10_000;

export function requireOwnerActor(owner: OwnerContext, what: string): void {
  if (owner.actor !== 'owner') throw new ActionError('forbidden', `${what} can only be done by signing in. Agents and AI cannot do this.`);
}

const platformSchema = z.enum(PLATFORM_IDS);

/** A destination the app can send to. Everything else is preview and posting by hand. */
export function requirePublishable(platform: PlatformId, doing: string): void {
  if (isPublishable(platform)) return;
  const info = PLATFORMS[platform];
  throw new ActionError('conflict', `${info.name} cannot be ${doing} by this app. ${info.reason}`, {}, { code: 'NOT_PUBLISHABLE' });
}

// ---- connections -------------------------------------------------------------------------------------

export interface ConnectionView {
  platform: PlatformId;
  info: (typeof PLATFORMS)[PlatformId];
  connection: ConnectionDTO | null;
}

/** One view for every catalog entry. Only those with a connector can hold a connection. */
export async function listConnections(owner: OwnerContext): Promise<ConnectionView[]> {
  const rows = await owner.data.connections.list();
  return PLATFORM_IDS.map((platform) => {
    const row = rows.find((r) => r.platform === platform);
    return { platform, info: PLATFORMS[platform], connection: row ? toConnectionDTO(row) : null };
  });
}

const secretSchema = z
  .string({ error: 'Paste the key.' })
  .trim()
  .min(8, 'That key looks too short.')
  .max(300, 'That key looks too long.')
  .refine((v) => !/\s/.test(v), 'A key has no spaces. Paste only the key.');

const connectSchema = z.object({ platform: platformSchema, secret: secretSchema });

function sealSecret(env: PublishEnv, secret: string, ownerId: string, connectionId: string): string {
  try {
    return encryptKey(secret, masterKey(env.config), ownerId, connectionId);
  } catch (err) {
    if (err instanceof SecretUnavailableError) throw new ActionError('unavailable', err.message, { secret: err.message });
    throw err;
  }
}

/** A failed probe in words that never contain the key. */
function probeProblem(platform: PlatformId, err: unknown, secret: string): string {
  if (err instanceof PlatformError) return redactSecrets(describeFailure(platform, err, 'health').message, [secret]);
  return 'The connection could not be checked.';
}

export function toSiteSettingsDTO(row: SiteSettings | null): SiteSettingsDTO {
  if (!row) return defaultSiteSettings();
  return { siteUrl: row.siteUrl, repo: row.repo, baseBranch: row.baseBranch, pathTemplate: row.pathTemplate, mapping: row.mapping, updatedAt: row.updatedAt.toISOString() };
}

/** The host of the site's public address, for checks that something is "on the site". */
export function siteHostOf(settings: SiteSettingsDTO): string | null {
  if (!settings.siteUrl) return null;
  try {
    return new URL(settings.siteUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Save a key. It is checked against the platform first with a read-only call; a key the platform refuses is
 * not stored. The key is encrypted with the owner and row bound in, and is never returned or logged.
 */
export async function connectPlatform(owner: OwnerContext, env: PublishEnv, input: unknown): Promise<ConnectionDTO> {
  requireOwnerActor(owner, 'Connecting a platform');
  const { platform, secret } = parseInput(connectSchema, input);
  if (!isPublishable(platform)) {
    const info = PLATFORMS[platform];
    throw new ActionError('conflict', `${info.name} cannot be connected yet. ${info.reason}`, {}, { code: 'NOT_PUBLISHABLE' });
  }
  const settings = platform === 'site' ? toSiteSettingsDTO(await owner.data.siteSettings.get()) : null;
  if (platform === 'site' && !settings?.repo) {
    throw new ActionError('conflict', 'Save the repository (owner/name) first, then connect the GitHub token.', { secret: 'Save the repository first.' }, { code: 'NO_REPO' });
  }
  const existing = await owner.data.connections.getByPlatform(platform);
  const id = existing?.id ?? randomUUID();
  const sealed = sealSecret(env, secret, owner.ownerId, id);

  const { adapter, ctx } = contextWith(env, platform, existing?.config ?? {}, secret, settings?.repo ? { repo: settings.repo, baseBranch: settings.baseBranch } : undefined);
  let health;
  try {
    health = await adapter.health(ctx);
  } catch (err) {
    const message = probeProblem(platform, err, secret);
    await owner.data.audit.record({ actor: owner.actor, action: 'platform.connect_failed', entityType: 'platform_connection', entityId: id, metadata: { platform, kind: err instanceof PlatformError ? err.kind : 'unknown' } });
    throw new ActionError(err instanceof PlatformError && err.kind === 'auth' ? 'invalid' : 'unavailable', message, { secret: message });
  }
  const saved = await owner.data.connections.save({
    id,
    platform,
    encryptedKey: sealed,
    keyLast4: secret.slice(-4),
    status: 'connected',
    who: health.who,
    config: health.config ?? {},
    message: null,
  });
  await owner.data.audit.record({ actor: owner.actor, action: 'platform.connected', entityType: 'platform_connection', entityId: saved.id, metadata: { platform, who: health.who, replaced: Boolean(existing) } });
  return toConnectionDTO(saved);
}

/** Re-check a connection with the read-only probe and record what came back. */
export async function testConnection(owner: OwnerContext, env: PublishEnv, id: unknown): Promise<{ connection: ConnectionDTO; ok: boolean; message: string }> {
  requireOwnerActor(owner, 'Testing a connection');
  const connectionId = parseId(id, 'Connection');
  const row = await owner.data.connections.getWithKey(connectionId);
  if (!row) throw new ActionError('not_found', 'Connection not found');
  if (!isPlatformId(row.platform)) throw new ActionError('conflict', 'This connection is tested from the Integrations screen.', {}, { code: 'USE_CONNECT' });
  let secret: string;
  try {
    secret = plainSecret(env, row);
  } catch (err) {
    const message = err instanceof KeyUnreadableError ? err.message : 'The saved key could not be read.';
    const updated = await owner.data.connections.recordCheck(row.id, { status: 'needs_reconnect', message });
    return { connection: toConnectionDTO(updated), ok: false, message };
  }
  const settings = row.platform === 'site' ? toSiteSettingsDTO(await owner.data.siteSettings.get()) : null;
  const { adapter, ctx } = contextFor(env, row, secret, settings?.repo ? { repo: settings.repo, baseBranch: settings.baseBranch } : undefined);
  try {
    const health = await adapter.health(ctx);
    const updated = await owner.data.connections.recordCheck(row.id, { status: 'connected', who: health.who, config: health.config ?? row.config, message: null });
    await owner.data.audit.record({ actor: owner.actor, action: 'platform.tested', entityType: 'platform_connection', entityId: row.id, metadata: { platform: row.platform, ok: true } });
    return { connection: toConnectionDTO(updated), ok: true, message: `Connected as ${health.who}.` };
  } catch (err) {
    const message = probeProblem(row.platform, err, secret);
    const status = err instanceof PlatformError && (err.kind === 'auth' || err.kind === 'forbidden_plan') ? 'needs_reconnect' : 'error';
    const updated = await owner.data.connections.recordCheck(row.id, { status, message });
    await owner.data.audit.record({ actor: owner.actor, action: 'platform.tested', entityType: 'platform_connection', entityId: row.id, metadata: { platform: row.platform, ok: false, kind: err instanceof PlatformError ? err.kind : 'unknown' } });
    return { connection: toConnectionDTO(updated), ok: false, message };
  }
}

/** Choose which Hashnode publication to publish to, from the ones the token can reach. */
export async function selectPublication(owner: OwnerContext, id: unknown, input: unknown): Promise<ConnectionDTO> {
  requireOwnerActor(owner, 'Choosing a publication');
  const connectionId = parseId(id, 'Connection');
  const { publicationId } = parseInput(z.object({ publicationId: z.string().min(1).max(64) }), input);
  const row = await owner.data.connections.get(connectionId);
  if (!row) throw new ActionError('not_found', 'Connection not found');
  const choice = row.config.publications?.find((p) => p.id === publicationId);
  if (!choice) throw new ActionError('invalid', 'That publication is not one this token can reach.', { publicationId: 'Choose one from the list.' });
  const updated = await owner.data.connections.recordCheck(row.id, { status: row.status, config: { ...row.config, publicationId: choice.id, publicationTitle: choice.title }, message: row.lastCheckMessage });
  await owner.data.audit.record({ actor: owner.actor, action: 'platform.publication_selected', entityType: 'platform_connection', entityId: row.id, metadata: { platform: row.platform } });
  return toConnectionDTO(updated);
}

/** Remove a connection and its stored key. Drafts keep their payloads but lose the link. */
export async function disconnectPlatform(owner: OwnerContext, id: unknown): Promise<void> {
  requireOwnerActor(owner, 'Disconnecting a platform');
  const connectionId = parseId(id, 'Connection');
  const row = await owner.data.connections.get(connectionId);
  if (!row) throw new ActionError('not_found', 'Connection not found');
  await owner.data.connections.remove(connectionId);
  await owner.data.audit.record({ actor: owner.actor, action: 'platform.disconnected', entityType: 'platform_connection', entityId: connectionId, metadata: { platform: row.platform } });
}

// ---- drafts ------------------------------------------------------------------------------------------

/** Housekeeping that must run before any draft is shown or acted on. */
export async function refresh(owner: OwnerContext, env: Pick<PublishEnv, 'now'>, articleId?: string): Promise<void> {
  const now = (env.now ?? (() => new Date()))();
  await owner.data.platformDrafts.expireApprovals(now);
  const swept = await owner.data.platformDrafts.sweepStalePublishing(now);
  for (const draft of swept) {
    await owner.data.audit.record({ actor: 'system', action: 'platform.publish_unknown', entityType: 'platform_draft', entityId: draft.id, metadata: { reason: 'no answer recorded' } });
  }
  if (articleId) await syncArticleDrafts(owner, articleId);
}

/**
 * Call after any change to an article: drafts built from the old text are flagged and their approvals void.
 * It is also run whenever drafts are read, so a change made by any route is seen before anything is shown.
 */
export async function syncArticleDrafts(owner: OwnerContext, articleId: string): Promise<number> {
  const changed = await owner.data.platformDrafts.syncSource(articleId);
  for (const draft of changed) {
    await owner.data.audit.record({ actor: 'system', action: 'platform.source_changed', entityType: 'platform_draft', entityId: draft.id, metadata: { platform: draft.platform } });
  }
  return changed.length;
}

/** The boxes the owner ticks for this draft's open approval. Computed here so the screen and the check agree. */
export async function checklistFor(owner: OwnerContext, draft: PlatformDraft, kind: 'publish' | 'manual'): Promise<string[]> {
  const name = PLATFORMS[draft.platform].name;
  const hasCanonical = draft.payload.canonicalUrl !== null && draft.payload.canonicalUrl !== '';
  if (kind === 'manual') return approvalChecklist(name, hasCanonical, { kind: 'manual' });
  if (draft.platform === 'site') return approvalChecklist(name, hasCanonical, { kind: 'pull_request' });
  let canonicalNotLive = false;
  if (hasCanonical && isSyndication(draft.platform)) {
    const check = await owner.data.canonicalChecks.get(draft.articleId, draft.payload.canonicalUrl!);
    canonicalNotLive = check?.state !== 'live';
  }
  return approvalChecklist(name, hasCanonical, { kind: 'publish', canonicalNotLive });
}

export function adaptInputOf(article: Pick<Article, 'title' | 'description' | 'tags' | 'canonicalUrl' | 'bodyMarkdown'>, cover: string | null, series: string | null) {
  return {
    title: article.title,
    description: article.description,
    tags: article.tags,
    canonicalUrl: article.canonicalUrl,
    coverImageUrl: cover,
    series,
    bodyMarkdown: article.bodyMarkdown,
  };
}

export async function draftView(owner: OwnerContext, row: PlatformDraft): Promise<PlatformDraftDTO> {
  const [approval, attempts, connection, article] = await Promise.all([
    owner.data.platformDrafts.latestApproval(row.id),
    owner.data.platformDrafts.listAttempts(row.id),
    owner.data.connections.getByPlatform(row.platform),
    owner.data.articles.get(row.articleId),
  ]);
  const adapter = adapterFor(row.platform);
  const generated = row.generatedPayload && Object.keys(row.generatedPayload).length > 0 ? row.generatedPayload : row.payload;
  const fresh = article ? adapter.adapt(adaptInputOf(article, generated.coverImageUrl, generated.series)).payload : null;
  const canonical = row.payload.canonicalUrl ? await owner.data.canonicalChecks.get(row.articleId, row.payload.canonicalUrl) : null;
  const checklist = approval ? await checklistFor(owner, row, approval.kind) : [];
  return toDraftDTO(row, { approval, attempts, adapter, config: connection?.config ?? {}, fresh, canonical, checklist });
}

export async function loadDraft(owner: OwnerContext, id: unknown): Promise<PlatformDraft> {
  const draftId = parseId(id, 'Draft');
  const row = await owner.data.platformDrafts.get(draftId);
  if (!row) throw new ActionError('not_found', 'Draft not found');
  return row;
}

export async function getDraft(owner: OwnerContext, env: Pick<PublishEnv, 'now'>, id: unknown): Promise<PlatformDraftDTO> {
  const draftId = parseId(id, 'Draft');
  const first = await owner.data.platformDrafts.get(draftId);
  if (!first) throw new ActionError('not_found', 'Draft not found');
  await refresh(owner, env, first.articleId);
  return draftView(owner, await loadDraft(owner, draftId));
}

const listSchema = z.object({
  articleId: z.uuid().optional(),
  status: z.enum(['draft', 'staged', 'pending_approval', 'approved', 'publishing', 'published', 'failed', 'unknown', 'source_changed']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export async function listDrafts(owner: OwnerContext, env: Pick<PublishEnv, 'now'>, input: unknown = {}): Promise<PlatformDraftDTO[]> {
  const { articleId, status, limit } = parseInput(listSchema, input);
  await refresh(owner, env, articleId);
  const rows = await owner.data.platformDrafts.list({
    ...(articleId ? { articleId } : {}),
    ...(status ? { statuses: [status] } : {}),
    ...(limit ? { limit } : {}),
  });
  return Promise.all(rows.map((row) => draftView(owner, row)));
}

/**
 * For the composer and the studio: a card for every catalog entry, in the owner's order for the ones they
 * added, then the rest. Each carries its capabilities, the connection and the draft, if any.
 */
export async function listDestinations(owner: OwnerContext, env: Pick<PublishEnv, 'now'>, articleId: unknown): Promise<DestinationDTO[]> {
  const id = parseId(articleId, 'Article');
  if (!(await owner.data.articles.get(id))) throw new ActionError('not_found', 'Article not found');
  await refresh(owner, env, id);
  await owner.data.destinations.ensureForDrafts(id);
  const [connections, added, settings] = await Promise.all([owner.data.connections.list(), owner.data.destinations.list(id), owner.data.siteSettings.get()]);
  const site = toSiteSettingsDTO(settings);
  const out: DestinationDTO[] = [];
  for (const platform of PLATFORM_IDS) {
    const connection = connections.find((c) => c.platform === platform);
    const row = await owner.data.platformDrafts.current(id, platform);
    const entry = added.find((d) => d.platform === platform);
    out.push({
      platform,
      info: PLATFORMS[platform],
      connection: connection ? toConnectionDTO(connection) : null,
      draft: row ? await draftView(owner, row) : null,
      added: Boolean(entry),
      position: entry?.position ?? 1000 + PLATFORM_IDS.indexOf(platform),
      siteReady: platform === 'site' ? Boolean(site.repo) : null,
    });
  }
  return out.sort((a, b) => a.position - b.position);
}

const prepareSchema = z.object({
  articleId: z.uuid({ error: 'Choose an article.' }),
  platform: platformSchema,
  /** A public https address for the cover. The article's own cover image only exists in this app and cannot be sent. */
  coverImageUrl: z.string().trim().max(2000).nullable().optional(),
  series: z.string().trim().max(100).nullable().optional(),
  /** Rebuild even though the owner has edited the draft: the edits are replaced by a fresh adaptation. */
  discardEdits: z.boolean().optional(),
});

const COVER_KEYS = ['cover_image', 'coverImage', 'cover', 'main_image', 'image'] as const;

/** A cover address the article already carries in its imported front matter. */
function coverFromMetadata(extra: Record<string, unknown>): string | null {
  for (const key of COVER_KEYS) {
    const value = extra[key];
    if (typeof value === 'string' && /^https:\/\//i.test(value.trim())) return value.trim();
  }
  return null;
}

/** Who a draft will be posted as: the connected account, the repository for the site, or nobody (hand posting). */
function accountFor(platform: PlatformId, who: string | null, site: SiteSettingsDTO): string | null {
  if (platform === 'site') return site.repo ? `${site.repo}@${site.baseBranch}` : 'Markdown export';
  return who;
}

/** The options that belong to the personal site's draft, kept across rebuilds where they still apply. */
function siteOptionsFor(article: Pick<Article, 'slug' | 'title'>, site: SiteSettingsDTO, previous: SiteDraftOptions | undefined, nowIso: string): SiteDraftOptions {
  const slug = slugForPath(article.slug) || slugForPath(article.title);
  const dateIso = previous?.dateIso ?? nowIso;
  const resolved = resolvePathTemplate(site.pathTemplate, { slug, dateIso, extension: site.mapping.extension });
  const path = resolved.ok ? resolved.path : site.pathTemplate;
  // An "update existing" choice belongs to one path: a different path starts over.
  const keep = previous && previous.path === path;
  return {
    slug,
    dateIso,
    path,
    repo: site.repo,
    baseBranch: site.baseBranch,
    mapping: site.mapping,
    updateExisting: keep ? previous.updateExisting : false,
    expectedSha: keep ? previous.expectedSha : null,
  };
}

export interface BuiltDraft {
  payload: DraftPayload;
  tagReport: PlatformDraft['tagReport'];
  lint: PlatformDraft['lint'];
  extras: DraftExtras;
  account: string | null;
  payloadSha256: string;
}

/** Lint that depends on the surroundings, not just the payload: the article's local cover, a missing publication. */
export function contextLint(platform: PlatformId, article: Pick<Article, 'coverAssetId'>, payload: DraftPayload, config: { publicationId?: string } | null): PlatformDraft['lint'] {
  const issues: PlatformDraft['lint'] = [];
  if (article.coverAssetId && !payload.coverImageUrl && PLATFORMS[platform].kind === 'long_form') {
    issues.push({ code: 'cover_local_only', severity: 'warning', message: 'The article’s cover image only exists in this app, so no cover will be sent. Add a public https URL for the cover to include one.' });
  }
  // Without a connection there is no publication to choose yet; the review says to connect first.
  if (platform === 'hashnode' && config && !config.publicationId) {
    issues.push({ code: 'publication_missing', severity: 'error', message: 'No Hashnode publication is selected. Choose one in Platforms > Integrations.' });
  }
  return issues;
}

/** Build a draft's payload, checks and hash from the article. Nothing is stored or sent. */
export function buildDraft(input: {
  article: Article;
  platform: PlatformId;
  who: string | null;
  config: { publicationId?: string } | null;
  site: SiteSettingsDTO;
  previous: PlatformDraft | null;
  cover: string | null;
  series: string | null;
  now: Date;
}): BuiltDraft {
  const adapter = adapterFor(input.platform);
  const { payload, tagReport } = adapter.adapt(adaptInputOf(input.article, input.cover, input.series));
  const extras: DraftExtras = {};
  if (input.platform === 'site') extras.site = siteOptionsFor(input.article, input.site, input.previous?.extras.site, input.now.toISOString());
  if (input.previous?.extras.options && Object.keys(input.previous.extras.options).length > 0) extras.options = input.previous.extras.options;
  const lint = [...adapter.validate(payload, extras), ...contextLint(input.platform, input.article, payload, input.config)];
  const account = accountFor(input.platform, input.who, input.site);
  return { payload, tagReport, lint, extras, account, payloadSha256: payloadHashOf(input.platform, account, payload, extras) };
}

/**
 * Build (or rebuild) the platform draft for an article: adapt the text, sanitize the tags, run the checks,
 * hash the exact payload and remember which version of the article it came from. Nothing is sent. A draft
 * that is publishing, unknown or published is not rebuilt: it stays as the record of what went out. A draft the
 * owner edited is not rebuilt either, unless they say the edits may be replaced.
 */
export async function prepareDraft(owner: OwnerContext, env: Pick<PublishEnv, 'now'>, input: unknown): Promise<PlatformDraftDTO> {
  const values = parseInput(prepareSchema, input);
  const article = await owner.data.articles.get(values.articleId);
  if (!article) throw new ActionError('not_found', 'Article not found');
  const info = PLATFORMS[values.platform];
  // Preparing never needs an account: it builds the post from the article and sends nothing, and the owner can still
  // copy it and post by hand. The account is attached when the platform is connected (see bindToConnection), and
  // staging, approving and publishing need it.
  const connection = await owner.data.connections.getByPlatform(values.platform);

  await refresh(owner, env, article.id);
  const existing = await owner.data.platformDrafts.current(article.id, values.platform);
  if (existing && (existing.status === 'published' || existing.status === 'publishing' || existing.status === 'unknown')) {
    const why =
      existing.status === 'published'
        ? `This article is already published on ${info.name}. Changing a live post is not built yet.`
        : existing.status === 'unknown'
          ? `The last publish to ${info.name} has an unknown result. Check on the platform before preparing anything new.`
          : `A publish to ${info.name} is in progress.`;
    throw new ActionError('conflict', why, {}, { code: 'ALREADY_OUT' });
  }
  if (existing && existing.editCount > 0 && !values.discardEdits) {
    throw new ActionError('conflict', `You edited this ${info.name} draft. Rebuilding replaces your edits with a fresh adaptation of the article. Confirm to rebuild.`, {}, { code: 'HAS_EDITS' });
  }

  const explicitCover = values.coverImageUrl === undefined ? undefined : values.coverImageUrl || null;
  const cover = explicitCover !== undefined ? explicitCover : (existing?.generatedPayload.coverImageUrl ?? existing?.payload.coverImageUrl ?? coverFromMetadata(article.extraMetadata));
  const series = values.series === undefined ? (existing?.generatedPayload.series ?? existing?.payload.series ?? null) : values.series || null;
  const site = toSiteSettingsDTO(await owner.data.siteSettings.get());
  const now = (env.now ?? (() => new Date()))();
  const built = buildDraft({ article, platform: values.platform, who: connection?.who ?? null, config: connection ? connection.config : null, site, previous: existing, cover, series, now });
  const rowValues = {
    connectionId: connection?.id ?? null,
    account: built.account,
    payload: built.payload,
    payloadSha256: built.payloadSha256,
    tagReport: built.tagReport,
    lint: built.lint,
    sourceRevision: article.revision,
    sourceHash: sourceHashOf(article),
    generatedPayload: built.payload,
    extras: built.extras,
  };

  let row: PlatformDraft | null;
  if (existing) {
    row = await owner.data.platformDrafts.rebuild(existing.id, rowValues);
    if (!row) throw new ActionError('conflict', 'This draft can no longer be rebuilt.');
  } else {
    row = await owner.data.platformDrafts.create({ articleId: article.id, platform: values.platform, ...rowValues });
  }
  await owner.data.destinations.add(article.id, values.platform);
  await owner.data.audit.record({
    actor: owner.actor,
    action: existing ? 'platform_draft.rebuilt' : 'platform_draft.created',
    entityType: 'platform_draft',
    entityId: row.id,
    metadata: { platform: values.platform, articleId: article.id, errors: built.lint.filter((i) => i.severity === 'error').length, warnings: built.lint.filter((i) => i.severity === 'warning').length },
  });
  return draftView(owner, row);
}

// ---- staging -----------------------------------------------------------------------------------------

function pause(env: PublishEnv, ms: number): Promise<void> {
  return env.sleep ? env.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Staging is private and repeatable, so a short, capped retry is allowed for transient failures. A first
 * create that ended ambiguously is NOT retried (it could make a second private draft); an update, a rate
 * limit that names a short wait, and a read can be.
 */
async function stageWithRetries<T>(env: PublishEnv, canRepeatAmbiguous: boolean, run: () => Promise<T>): Promise<{ value: T; attempts: number }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= STAGE_ATTEMPTS; attempt++) {
    try {
      return { value: await run(), attempts: attempt };
    } catch (err) {
      lastError = err;
      if (!(err instanceof PlatformError) || !err.transient || attempt === STAGE_ATTEMPTS) break;
      if (err.kind !== 'rate_limit' && !canRepeatAmbiguous) break;
      const backoff = STAGE_BACKOFF_MS[attempt - 1] ?? STAGE_BACKOFF_MS.at(-1) ?? 1000;
      await pause(env, Math.min(STAGE_MAX_WAIT_MS, Math.max(backoff, err.retryAfterMs ?? 0)));
    }
  }
  throw lastError;
}

const STATUS_WHY: Partial<Record<DraftStatus, string>> = {
  pending_approval: 'It is waiting for your approval. Decline the request before staging again.',
  approved: 'It is being published.',
  publishing: 'It is being published right now.',
  published: 'It is already published.',
  unknown: 'Its last publish has an unknown result. Check on the platform first.',
  source_changed: 'The article changed after the draft was built. Rebuild the draft first.',
};

/**
 * Give a draft that was prepared before its platform was connected the connected account. The post itself is not
 * touched. Because the account is part of what is hashed, the hash changes, so this happens only before staging.
 */
async function bindToConnection(owner: OwnerContext, draft: PlatformDraft, connection: { id: string; who: string | null; config: { publicationId?: string } }): Promise<PlatformDraft> {
  const site = toSiteSettingsDTO(await owner.data.siteSettings.get());
  const account = accountFor(draft.platform, connection.who, site);
  if (draft.connectionId === connection.id && draft.account === account) return draft;
  if (draft.status !== 'draft' && draft.status !== 'failed') return draft;
  const article = await owner.data.articles.get(draft.articleId);
  if (!article) return draft;
  const lint = [...adapterFor(draft.platform).validate(draft.payload, draft.extras), ...contextLint(draft.platform, article, draft.payload, connection.config)];
  const payloadSha256 = payloadHashOf(draft.platform, account, draft.payload, draft.extras);
  const row = await owner.data.platformDrafts.bindConnection(draft.id, { expectedHash: draft.payloadSha256, connectionId: connection.id, account, payloadSha256, lint });
  return row ?? draft;
}

export interface StageOutcome {
  ok: boolean;
  message: string;
  draft: PlatformDraftDTO;
}

/** What the adapters need to know about a draft beyond its payload. */
export function adapterDraftOf(draft: PlatformDraft) {
  return { id: draft.id, payload: draft.payload, remoteId: draft.remoteId, extras: draft.extras, payloadSha256: draft.payloadSha256 };
}

/** The repository a personal-site probe reads, from the draft's own options. */
function siteTargetOf(draft: PlatformDraft) {
  const site = draft.extras.site;
  return draft.platform === 'site' && site?.repo ? { repo: site.repo, baseBranch: site.baseBranch } : undefined;
}

/** Create or update the PRIVATE copy on the platform. It never publishes and never touches a live article. */
export async function stageDraft(owner: OwnerContext, env: PublishEnv, id: unknown): Promise<StageOutcome> {
  const first = await loadDraft(owner, id);
  requirePublishable(first.platform, 'staged');
  await refresh(owner, env, first.articleId);
  let draft = await loadDraft(owner, id);
  const name = PLATFORMS[draft.platform].name;
  if (!(STAGEABLE_STATUSES as readonly string[]).includes(draft.status)) {
    throw new ActionError('conflict', `This draft cannot be staged. ${STATUS_WHY[draft.status] ?? ''}`.trim(), {}, { code: 'STATUS' });
  }
  const connection = draft.connectionId ? await owner.data.connections.getWithKey(draft.connectionId) : await owner.data.connections.getByPlatform(draft.platform).then((c) => (c ? owner.data.connections.getWithKey(c.id) : null));
  if (!connection) throw new ActionError('conflict', `Connect ${name} first, in Platforms > Integrations.`, {}, { code: 'NOT_CONNECTED' });
  // A post prepared before the account was connected picks the account up here, before anything is sent.
  draft = await bindToConnection(owner, draft, connection);
  const errors = draft.lint.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    throw new ActionError('invalid', `Fix ${errors.length} problem${errors.length === 1 ? '' : 's'} before staging: ${errors[0]!.message}`, {}, { code: 'LINT' });
  }
  let secret: string;
  try {
    secret = plainSecret(env, connection);
  } catch (err) {
    throw new ActionError('unavailable', err instanceof KeyUnreadableError ? err.message : 'The saved key could not be read.');
  }
  const { adapter, ctx } = contextFor(env, connection, secret, siteTargetOf(draft));
  const attempt = await owner.data.platformDrafts.startAttempt(draft.id, 'stage', draft.payloadSha256);

  try {
    const { value, attempts } = await stageWithRetries(env, draft.remoteId !== null, () => adapter.stage(ctx, adapterDraftOf(draft)));
    const staged = await owner.data.platformDrafts.markStaged(draft.id, draft.payloadSha256, { remoteId: value.remoteId, previewUrl: value.previewUrl, info: value.info ?? null });
    await owner.data.platformDrafts.finishAttempt(attempt.id, {
      status: 'succeeded',
      remoteId: value.remoteId,
      message: staged ? (attempts > 1 ? `Staged after ${attempts} tries.` : draft.platform === 'site' ? 'Read the repository and checked the target file. Nothing was written.' : null) : 'The draft changed while it was being staged, so the result was not applied.',
    });
    await owner.data.audit.record({ actor: owner.actor, action: 'platform_draft.staged', entityType: 'platform_draft', entityId: draft.id, metadata: { platform: draft.platform, applied: Boolean(staged), attempts } });
    const view = await draftView(owner, await loadDraft(owner, draft.id));
    const okMessage =
      draft.platform === 'site'
        ? value.info?.fileExists
          ? `Checked ${draft.extras.site?.repo}. A file already exists at ${value.info.path}. Mark the draft “update existing” if you mean to replace it. Nothing was written.`
          : `Checked ${draft.extras.site?.repo}: ${value.info?.path} is free on ${draft.extras.site?.baseBranch}. Nothing was written.`
        : `A private draft is on ${name}. It is not public.`;
    return staged ? { ok: true, message: okMessage, draft: view } : { ok: false, message: 'The draft changed while it was being staged. Review it and stage again.', draft: view };
  } catch (err) {
    const platformError = err instanceof PlatformError ? err : new PlatformError('network', 'The request failed before the platform answered.');
    const failure = describeFailure(draft.platform, platformError, 'stage');
    failure.message = redactSecrets(failure.message, [secret]);
    await owner.data.platformDrafts.markStageFailed(draft.id, draft.payloadSha256, failure);
    await owner.data.platformDrafts.finishAttempt(attempt.id, { status: 'failed', httpStatus: platformError.httpStatus, errorKind: failure.kind, message: failure.message });
    if (failure.kind === 'auth') await owner.data.connections.recordCheck(connection.id, { status: 'needs_reconnect', message: failure.message });
    await owner.data.audit.record({ actor: owner.actor, action: 'platform_draft.stage_failed', entityType: 'platform_draft', entityId: draft.id, metadata: { platform: draft.platform, kind: failure.kind } });
    return { ok: false, message: `${failure.message} ${failure.nextAction}`, draft: await draftView(owner, await loadDraft(owner, draft.id)) };
  }
}

// ---- canonical page ----------------------------------------------------------------------------------

/**
 * Look at the article's canonical page and keep what was found. Syndication destinations warn, and ask for one
 * more tick, when it is not live. The look is read-only and goes through the SSRF-safe fetcher.
 */
export async function refreshCanonical(owner: OwnerContext, env: PublishEnv, article: Pick<Article, 'id'>, url: string | null) {
  if (!url) return null;
  const site = toSiteSettingsDTO(await owner.data.siteSettings.get());
  const result = await checkCanonicalPage(url, siteHostOf(site), env.canonical);
  const row = await owner.data.canonicalChecks.save({ articleId: article.id, url, ...result, checkedAt: (env.now ?? (() => new Date()))() });
  await owner.data.audit.record({ actor: owner.actor, action: 'canonical.checked', entityType: 'article', entityId: article.id, metadata: { state: result.state, httpStatus: result.httpStatus } });
  return row;
}

// ---- approval ----------------------------------------------------------------------------------------

export interface ApprovalRequestOutcome {
  draft: PlatformDraftDTO;
  /** Where the owner reviews and approves. Opening it approves nothing. */
  link: string;
}

const requestSchema = z.object({ mode: z.enum(['publish', 'manual']).default('publish') }).strict();

/**
 * Ask the owner to approve this exact payload. Creates a pending, single-use request that expires in 30
 * minutes. Anyone allowed to prepare drafts may ask; only the owner, in the app, can answer. Mode `manual` asks
 * the owner to approve recording a post they made by hand; it is the owner's request only.
 */
export async function requestApproval(owner: OwnerContext, env: PublishEnv, id: unknown, input: unknown = {}): Promise<ApprovalRequestOutcome> {
  const { mode } = parseInput(requestSchema, input ?? {});
  if (mode === 'manual') requireOwnerActor(owner, 'Recording a post made by hand');
  const first = await loadDraft(owner, id);
  if (mode === 'publish') requirePublishable(first.platform, 'approved for publishing');
  await refresh(owner, env, first.articleId);
  const draft = await loadDraft(owner, id);
  const name = PLATFORMS[draft.platform].name;
  if (draft.status === 'source_changed' || draft.stale) throw new ActionError('conflict', 'The article changed after this draft was built. Rebuild the draft first.', {}, { code: 'SOURCE_CHANGED' });

  if (mode === 'manual') {
    if (draft.status !== 'draft' && draft.status !== 'staged' && draft.status !== 'failed' && draft.status !== 'pending_approval') {
      throw new ActionError('conflict', `Recording cannot be requested now. ${STATUS_WHY[draft.status] ?? ''}`.trim(), {}, { code: 'STATUS' });
    }
  } else {
    if (draft.status !== 'staged' && draft.status !== 'pending_approval') {
      const why = draft.status === 'draft' || draft.status === 'failed' ? (draft.platform === 'site' ? 'Check the target on GitHub first, so you know where the file will go.' : `Stage the private draft on ${name} first, so you can look at it before it goes public.`) : (STATUS_WHY[draft.status] ?? 'It is not ready for approval.');
      throw new ActionError('conflict', `Approval cannot be requested yet. ${why}`, {}, { code: 'STATUS' });
    }
    const errors = draft.lint.filter((i) => i.severity === 'error');
    if (errors.length > 0) throw new ActionError('invalid', `Fix ${errors.length} problem${errors.length === 1 ? '' : 's'} first: ${errors[0]!.message}`, {}, { code: 'LINT' });
    const connection = draft.connectionId ? await owner.data.connections.get(draft.connectionId) : await owner.data.connections.getByPlatform(draft.platform);
    if (!connection || connection.status !== 'connected') throw new ActionError('conflict', `${name} is not connected. Reconnect it in Platforms > Integrations.`, {}, { code: 'UNHEALTHY' });
    if (draft.platform === 'site') {
      const options = draft.extras.site;
      const seen = draft.remoteInfo;
      if (seen?.fileExists && !(options?.updateExisting && options.expectedSha === seen.fileSha)) {
        throw new ActionError('conflict', `A file already exists at ${options?.path}. Mark the draft “update existing” (after looking at the file), or change the path.`, {}, { code: 'FILE_EXISTS' });
      }
    }
    if (isSyndication(draft.platform) && draft.payload.canonicalUrl) {
      const article = await owner.data.articles.get(draft.articleId);
      if (article) await refreshCanonical(owner, env, article, draft.payload.canonicalUrl);
    }
  }

  const now = (env.now ?? (() => new Date()))();
  const approval = await owner.data.platformDrafts.openApproval(draft.id, {
    tag: approvalTag(draft.payloadSha256),
    expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
    requestedBy: owner.actor === 'agent' ? 'agent' : 'owner',
    expectedHash: draft.payloadSha256,
    kind: mode,
  });
  if (!approval) throw new ActionError('conflict', 'The draft changed. Review it and ask again.', {}, { code: 'STATUS' });
  await owner.data.audit.record({ actor: owner.actor, action: 'approval.requested', entityType: 'approval', entityId: approval.id, metadata: { platform: draft.platform, draftId: draft.id, tag: approval.tag, mode } });
  return { draft: await draftView(owner, await loadDraft(owner, draft.id)), link: `${env.config.appUrl}/articles/${draft.articleId}/publish?view=guided&step=3&d=${draft.platform}` };
}

/** Say no to a pending request. Only the signed-in owner. The draft goes back to where it was. */
export async function declineApproval(owner: OwnerContext, env: PublishEnv, approvalId: unknown): Promise<PlatformDraftDTO> {
  requireOwnerActor(owner, 'Declining an approval');
  const id = parseId(approvalId, 'Approval');
  const denied = await owner.data.platformDrafts.deny(id);
  if (!denied) throw new ActionError('conflict', 'This request is no longer pending.');
  await owner.data.audit.record({ actor: owner.actor, action: 'approval.declined', entityType: 'approval', entityId: id, metadata: { draftId: denied.draftId } });
  void env;
  return draftView(owner, await loadDraft(owner, denied.draftId));
}

/** Exactly one approval id arrives in the path and nothing else is accepted in the body: there is no way to approve more than one payload at a time. */
const approveSchema = z
  .object({
    checked: z.array(z.string().max(300)).max(20),
  })
  .strict();

export interface PublishOutcome {
  outcome: 'published' | 'failed' | 'unknown';
  message: string;
  draft: PlatformDraftDTO;
}

/**
 * THE publish. Only a signed-in person can reach it. In order: every checklist box ticked; the key is
 * readable; a read-only probe says the connection works; then one transaction consumes the approval and moves
 * the draft to `publishing` (re-checking the hash, expiry, source, connection and duplicates); then the
 * adapter is called exactly once with exactly the approved payload. Nothing is retried. A clear refusal is
 * `failed`; anything that may have gone out is `unknown`.
 */
export async function approveAndPublish(owner: OwnerContext, env: PublishEnv, approvalId: unknown, input: unknown): Promise<PublishOutcome> {
  requireOwnerActor(owner, 'Approving a publish');
  const id = parseId(approvalId, 'Approval');
  const { checked } = parseInput(approveSchema, input);
  const approval = await owner.data.platformDrafts.getApproval(id);
  if (!approval) throw new ActionError('not_found', 'Approval not found');
  const draft = await owner.data.platformDrafts.get(approval.draftId);
  if (!draft) throw new ActionError('not_found', 'Draft not found');
  requirePublishable(draft.platform, 'published');
  if (approval.kind !== 'publish') throw new ActionError('conflict', 'This approval is for recording a post made by hand, not for publishing.', {}, { code: 'APPROVAL_INVALID' });
  const name = PLATFORMS[draft.platform].name;
  const now = env.now ?? (() => new Date());

  const required = await checklistFor(owner, draft, 'publish');
  const missing = required.filter((box) => !checked.includes(box));
  if (missing.length > 0) {
    throw new ActionError('invalid', `Tick every box before approving (${missing.length} left).`, { checked: 'Every box must be ticked.' }, { code: 'CHECKLIST', missing });
  }

  const connection = draft.connectionId ? await owner.data.connections.getWithKey(draft.connectionId) : await owner.data.connections.getByPlatform(draft.platform).then((c) => (c ? owner.data.connections.getWithKey(c.id) : null));
  if (!connection) throw new ActionError('conflict', `Connect ${name} first, in Platforms > Integrations.`, {}, { code: 'NOT_CONNECTED' });
  let secret: string;
  try {
    secret = plainSecret(env, connection);
  } catch (err) {
    throw new ActionError('unavailable', err instanceof KeyUnreadableError ? err.message : 'The saved key could not be read.');
  }
  const { adapter, ctx } = contextFor(env, connection, secret, siteTargetOf(draft));

  // A read-only probe first. If it fails nothing is consumed and the approval stays pending until it expires.
  try {
    const health = await adapter.health(ctx);
    await owner.data.connections.recordCheck(connection.id, { status: 'connected', who: health.who, config: health.config ?? connection.config, message: null });
  } catch (err) {
    const platformError = err instanceof PlatformError ? err : new PlatformError('network', 'The connection could not be checked.');
    const failure = describeFailure(draft.platform, platformError, 'health');
    const message = redactSecrets(failure.message, [secret]);
    await owner.data.connections.recordCheck(connection.id, { status: failure.kind === 'auth' || failure.kind === 'forbidden_plan' ? 'needs_reconnect' : 'error', message });
    throw new ActionError('unavailable', `${message} Nothing was sent and your approval is still waiting. ${failure.nextAction}`, {}, { code: 'UNHEALTHY' });
  }

  let authorized;
  try {
    authorized = await owner.data.platformDrafts.authorizePublish({ draftId: draft.id, approvalId: approval.id, checked, now: now() });
  } catch (err) {
    if (err instanceof PublishRefusal) {
      if (err.code === 'SOURCE_CHANGED') await syncArticleDrafts(owner, draft.articleId);
      await owner.data.audit.record({ actor: owner.actor, action: 'approval.refused', entityType: 'approval', entityId: approval.id, metadata: { code: err.code, draftId: draft.id } });
      throw new ActionError('conflict', err.message, {}, { code: err.code });
    }
    throw err;
  }
  await owner.data.audit.record({ actor: owner.actor, action: 'platform.publish_started', entityType: 'platform_draft', entityId: draft.id, metadata: { platform: draft.platform, approvalId: approval.id, tag: approval.tag, payloadSha256: draft.payloadSha256 } });

  // From here the approval is spent and the draft is `publishing`. The adapter is called once.
  let publication;
  try {
    publication = await adapter.publish(ctx, adapterDraftOf(authorized.draft));
  } catch (err) {
    const platformError = err instanceof PlatformError ? err : new PlatformError('network', 'The request ended in an unexpected way.');
    const failure = describeFailure(draft.platform, platformError, 'publish');
    failure.message = redactSecrets(failure.message, [secret]);
    const clean = err instanceof PlatformError && !err.ambiguous;
    const status = clean ? 'failed' : 'unknown';
    await owner.data.platformDrafts.settlePublish(draft.id, authorized.attempt.id, { status, failure, httpStatus: platformError.httpStatus, now: now() });
    if (failure.kind === 'auth') await owner.data.connections.recordCheck(connection.id, { status: 'needs_reconnect', message: failure.message });
    await owner.data.audit.record({ actor: owner.actor, action: clean ? 'platform.publish_failed' : 'platform.publish_unknown', entityType: 'platform_draft', entityId: draft.id, metadata: { platform: draft.platform, kind: failure.kind, httpStatus: platformError.httpStatus } });
    return { outcome: status, message: `${failure.message} ${failure.nextAction}`, draft: await draftView(owner, await loadDraft(owner, draft.id)) };
  }

  const settled = await owner.data.platformDrafts.settlePublish(draft.id, authorized.attempt.id, {
    status: 'published',
    remoteId: publication.remoteId,
    remoteUrl: publication.remoteUrl,
    httpStatus: 200,
    now: now(),
  });
  await owner.data.audit.record({ actor: owner.actor, action: 'platform.published', entityType: 'platform_draft', entityId: draft.id, metadata: { platform: draft.platform, remoteId: publication.remoteId, recorded: Boolean(settled) } });
  return {
    outcome: 'published',
    message: draft.platform === 'site' ? 'Pull request opened. Merge it in GitHub to go live.' : `Published on ${name}.`,
    draft: await draftView(owner, await loadDraft(owner, draft.id)),
  };
}

// ---- recovery ----------------------------------------------------------------------------------------

export interface CheckOutcome {
  remote: 'published' | 'private' | 'not_found' | 'unreadable';
  message: string;
  draft: PlatformDraftDTO;
}

/**
 * Read-only: ask the platform where this draft stands. When the draft is `unknown`, a clear answer settles
 * it (live: published with its link; private: back to staged). "Not found" does not settle it, because it is
 * not proof that nothing went out.
 */
export async function checkOnPlatform(owner: OwnerContext, env: PublishEnv, id: unknown): Promise<CheckOutcome> {
  requireOwnerActor(owner, 'Checking on the platform');
  const first = await loadDraft(owner, id);
  requirePublishable(first.platform, 'checked');
  await refresh(owner, env, first.articleId);
  const draft = await loadDraft(owner, id);
  const name = PLATFORMS[draft.platform].name;
  const isSite = draft.platform === 'site';
  const connection = draft.connectionId ? await owner.data.connections.getWithKey(draft.connectionId) : await owner.data.connections.getByPlatform(draft.platform).then((c) => (c ? owner.data.connections.getWithKey(c.id) : null));
  if (!connection) throw new ActionError('conflict', `Connect ${name} first, in Platforms > Integrations.`, {}, { code: 'NOT_CONNECTED' });
  let secret: string;
  try {
    secret = plainSecret(env, connection);
  } catch (err) {
    throw new ActionError('unavailable', err instanceof KeyUnreadableError ? err.message : 'The saved key could not be read.');
  }
  const { adapter, ctx } = contextFor(env, connection, secret, siteTargetOf(draft));
  const now = (env.now ?? (() => new Date()))();
  const view = async () => draftView(owner, await loadDraft(owner, draft.id));
  const what = isSite ? 'a pull request' : 'the post';

  let result;
  try {
    result = await adapter.check(ctx, adapterDraftOf(draft));
  } catch (err) {
    const platformError = err instanceof PlatformError ? err : new PlatformError('network', 'The check failed.');
    const failure = describeFailure(draft.platform, platformError, 'check');
    const message = redactSecrets(`${failure.message} ${failure.nextAction}`, [secret]);
    await owner.data.platformDrafts.startAttempt(draft.id, 'check', draft.payloadSha256).then((a) =>
      owner.data.platformDrafts.finishAttempt(a.id, { status: 'failed', httpStatus: platformError.httpStatus, errorKind: failure.kind, message }),
    );
    return { remote: 'unreadable', message, draft: await view() };
  }

  const attempt = await owner.data.platformDrafts.startAttempt(draft.id, 'check', draft.payloadSha256);
  if (result.state === 'published') {
    const resolved = draft.status === 'unknown' ? await owner.data.platformDrafts.resolveUnknown(draft.id, { outcome: 'published', remoteId: result.remoteId, remoteUrl: result.remoteUrl }, { kind: 'check', message: isSite ? 'Found a pull request on GitHub.' : `Found live on ${name}.`, now }) : null;
    await owner.data.platformDrafts.finishAttempt(attempt.id, { status: 'succeeded', remoteId: result.remoteId, remoteUrl: result.remoteUrl, message: isSite ? 'A pull request exists.' : `Live on ${name}.` });
    await owner.data.audit.record({ actor: owner.actor, action: 'platform.checked', entityType: 'platform_draft', entityId: draft.id, metadata: { platform: draft.platform, remote: 'published', resolved: Boolean(resolved) } });
    return {
      remote: 'published',
      message: isSite ? (resolved ? 'A pull request exists. The draft is now recorded as opened.' : 'A pull request exists.') : resolved ? `It is live on ${name}. The draft is now recorded as published.` : `It is live on ${name}.`,
      draft: await view(),
    };
  }
  if (result.state === 'private') {
    const resolved = draft.status === 'unknown' ? await owner.data.platformDrafts.resolveUnknown(draft.id, { outcome: 'not_published' }, { kind: 'check', message: isSite ? 'No pull request exists.' : `Still private on ${name}.`, now }) : null;
    await owner.data.platformDrafts.finishAttempt(attempt.id, { status: 'succeeded', message: isSite ? 'No pull request exists.' : `Private on ${name}.` });
    await owner.data.audit.record({ actor: owner.actor, action: 'platform.checked', entityType: 'platform_draft', entityId: draft.id, metadata: { platform: draft.platform, remote: 'private', resolved: Boolean(resolved) } });
    return {
      remote: 'private',
      message: isSite
        ? resolved
          ? 'No pull request was opened (only the branch exists), so nothing went out. You can ask for approval again.'
          : 'No pull request exists yet.'
        : resolved
          ? `It is still a private draft on ${name}, so it did not go out. You can ask for approval again.`
          : `It is a private draft on ${name}.`,
      draft: await view(),
    };
  }
  await owner.data.platformDrafts.finishAttempt(attempt.id, { status: 'succeeded', message: isSite ? 'No pull request or branch found.' : `Not found on ${name}.` });
  await owner.data.audit.record({ actor: owner.actor, action: 'platform.checked', entityType: 'platform_draft', entityId: draft.id, metadata: { platform: draft.platform, remote: 'not_found' } });
  return {
    remote: 'not_found',
    message: `${what[0]!.toUpperCase()}${what.slice(1)} could not be found on ${name}. That is not proof it never went out, so the result stays unknown. Look on ${name}, then mark it by hand.`,
    draft: await view(),
  };
}

const manualSchema = z.object({
  outcome: z.enum(['posted', 'not_posted']),
  remoteUrl: z.string().trim().max(2000).nullable().optional(),
  /** Must be the literal `true`: the person has read the warning. */
  confirm: z.literal(true, { error: 'Confirm that you checked the platform yourself.' }),
});

/** Resolve an `unknown` draft by the owner's own word, after looking at the platform. Needs an explicit confirmation. */
export async function markByHand(owner: OwnerContext, env: Pick<PublishEnv, 'now'>, id: unknown, input: unknown): Promise<PlatformDraftDTO> {
  requireOwnerActor(owner, 'Marking a result by hand');
  const values = parseInput(manualSchema, input);
  const draft = await loadDraft(owner, id);
  if (draft.status !== 'unknown') throw new ActionError('conflict', 'Only a draft with an unknown result can be marked by hand.');
  let remoteUrl: string | null = null;
  if (values.outcome === 'posted' && values.remoteUrl) {
    try {
      const parsed = new URL(values.remoteUrl);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('scheme');
      remoteUrl = parsed.toString();
    } catch {
      throw new ActionError('invalid', 'Enter the post’s full web address, or leave it empty.', { remoteUrl: 'Enter a full web address.' });
    }
  }
  const now = (env.now ?? (() => new Date()))();
  const resolved = await owner.data.platformDrafts.resolveUnknown(
    draft.id,
    values.outcome === 'posted' ? { outcome: 'published', remoteId: draft.remoteId, remoteUrl } : { outcome: 'not_published' },
    { kind: 'manual', message: values.outcome === 'posted' ? 'You marked this as posted by hand.' : 'You marked this as not posted.', now },
  );
  if (!resolved) throw new ActionError('conflict', 'The result was resolved in the meantime.');
  await owner.data.audit.record({ actor: owner.actor, action: 'platform.marked_by_hand', entityType: 'platform_draft', entityId: draft.id, metadata: { platform: draft.platform, outcome: values.outcome } });
  return draftView(owner, await loadDraft(owner, draft.id));
}
