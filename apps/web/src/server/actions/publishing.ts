import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  APPROVAL_TTL_MS,
  PLATFORMS,
  PLATFORM_IDS,
  STAGEABLE_STATUSES,
  approvalChecklist,
  approvalTag,
  type ConnectionDTO,
  type DestinationDTO,
  type DraftStatus,
  type PlatformDraftDTO,
  type PlatformId,
} from '../../lib/publishing';
import { redactSecrets } from '../ai/redact';
import { encryptKey, masterKey, SecretUnavailableError } from '../ai/crypto';
import { PublishRefusal } from '../data/tenant';
import type { PlatformDraft } from '../db/schema';
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
 *  - `approveAndPublish` is the only code that can make anything public, and it calls the adapter once.
 */

const STAGE_ATTEMPTS = 3;
const STAGE_BACKOFF_MS = [1000, 3000];
const STAGE_MAX_WAIT_MS = 10_000;

function requireOwnerActor(owner: OwnerContext, what: string): void {
  if (owner.actor !== 'owner') throw new ActionError('forbidden', `${what} can only be done by signing in. Agents and AI cannot do this.`);
}

const platformSchema = z.enum(PLATFORM_IDS);

// ---- connections -------------------------------------------------------------------------------------

export interface ConnectionView {
  platform: PlatformId;
  info: (typeof PLATFORMS)[PlatformId];
  connection: ConnectionDTO | null;
}

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

/**
 * Save a key. It is checked against the platform first with a read-only call; a key the platform refuses is
 * not stored. The key is encrypted with the owner and row bound in, and is never returned or logged.
 */
export async function connectPlatform(owner: OwnerContext, env: PublishEnv, input: unknown): Promise<ConnectionDTO> {
  requireOwnerActor(owner, 'Connecting a platform');
  const { platform, secret } = parseInput(connectSchema, input);
  const existing = await owner.data.connections.getByPlatform(platform);
  const id = existing?.id ?? randomUUID();
  const sealed = sealSecret(env, secret, owner.ownerId, id);

  const { adapter, ctx } = contextWith(env, platform, existing?.config ?? {}, secret);
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
  let secret: string;
  try {
    secret = plainSecret(env, row);
  } catch (err) {
    const message = err instanceof KeyUnreadableError ? err.message : 'The saved key could not be read.';
    const updated = await owner.data.connections.recordCheck(row.id, { status: 'needs_reconnect', message });
    return { connection: toConnectionDTO(updated), ok: false, message };
  }
  const { adapter, ctx } = contextFor(env, row, secret);
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
async function refresh(owner: OwnerContext, env: Pick<PublishEnv, 'now'>, articleId?: string): Promise<void> {
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

async function draftView(owner: OwnerContext, row: PlatformDraft): Promise<PlatformDraftDTO> {
  const [approval, attempts, connection] = await Promise.all([
    owner.data.platformDrafts.latestApproval(row.id),
    owner.data.platformDrafts.listAttempts(row.id),
    owner.data.connections.getByPlatform(row.platform),
  ]);
  return toDraftDTO(row, { approval, attempts, adapter: adapterFor(row.platform), config: connection?.config ?? {} });
}

async function loadDraft(owner: OwnerContext, id: unknown): Promise<PlatformDraft> {
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

/** For the article studio: every destination with its capabilities, the connection and the draft, if any. */
export async function listDestinations(owner: OwnerContext, env: Pick<PublishEnv, 'now'>, articleId: unknown): Promise<DestinationDTO[]> {
  const id = parseId(articleId, 'Article');
  if (!(await owner.data.articles.get(id))) throw new ActionError('not_found', 'Article not found');
  await refresh(owner, env, id);
  const connections = await owner.data.connections.list();
  const out: DestinationDTO[] = [];
  for (const platform of PLATFORM_IDS) {
    const connection = connections.find((c) => c.platform === platform);
    const row = await owner.data.platformDrafts.current(id, platform);
    out.push({ platform, info: PLATFORMS[platform], connection: connection ? toConnectionDTO(connection) : null, draft: row ? await draftView(owner, row) : null });
  }
  return out;
}

const prepareSchema = z.object({
  articleId: z.uuid({ error: 'Choose an article.' }),
  platform: platformSchema,
  /** A public https address for the cover. The article's own cover image only exists in this app and cannot be sent. */
  coverImageUrl: z.string().trim().max(2000).nullable().optional(),
  series: z.string().trim().max(100).nullable().optional(),
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

/**
 * Build (or rebuild) the platform draft for an article: adapt the text, sanitize the tags, run the checks,
 * hash the exact payload and remember which version of the article it came from. Nothing is sent. A draft
 * that is publishing, unknown or published is not rebuilt: it stays as the record of what went out.
 */
export async function prepareDraft(owner: OwnerContext, env: Pick<PublishEnv, 'now'>, input: unknown): Promise<PlatformDraftDTO> {
  const values = parseInput(prepareSchema, input);
  const article = await owner.data.articles.get(values.articleId);
  if (!article) throw new ActionError('not_found', 'Article not found');
  const connection = await owner.data.connections.getByPlatform(values.platform);
  const info = PLATFORMS[values.platform];
  if (!connection) throw new ActionError('conflict', `Connect ${info.name} first, in Settings > Connections.`, {}, { code: 'NOT_CONNECTED' });

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

  const adapter = adapterFor(values.platform);
  const explicitCover = values.coverImageUrl === undefined ? undefined : values.coverImageUrl || null;
  const cover = explicitCover !== undefined ? explicitCover : (existing?.payload.coverImageUrl ?? coverFromMetadata(article.extraMetadata));
  const series = values.series === undefined ? (existing?.payload.series ?? null) : values.series || null;
  const { payload, tagReport } = adapter.adapt({
    title: article.title,
    description: article.description,
    tags: article.tags,
    canonicalUrl: article.canonicalUrl,
    coverImageUrl: cover,
    series,
    bodyMarkdown: article.bodyMarkdown,
  });
  const lint = adapter.validate(payload);
  if (article.coverAssetId && !payload.coverImageUrl) {
    lint.push({ code: 'cover_local_only', severity: 'warning', message: 'The article’s cover image only exists in this app, so no cover will be sent. Add a public https URL for the cover to include one.' });
  }
  if (!connection.config.publicationId && values.platform === 'hashnode') {
    lint.push({ code: 'publication_missing', severity: 'error', message: 'No Hashnode publication is selected. Choose one in Settings > Connections.' });
  }
  const account = connection.who;
  const built = {
    connectionId: connection.id,
    account,
    payload,
    payloadSha256: payloadHashOf(values.platform, account, payload),
    tagReport,
    lint,
    sourceRevision: article.revision,
    sourceHash: sourceHashOf(article),
  };

  let row: PlatformDraft | null;
  if (existing) {
    row = await owner.data.platformDrafts.rebuild(existing.id, built);
    if (!row) throw new ActionError('conflict', 'This draft can no longer be rebuilt.');
  } else {
    row = await owner.data.platformDrafts.create({ articleId: article.id, platform: values.platform, ...built });
  }
  await owner.data.audit.record({
    actor: owner.actor,
    action: existing ? 'platform_draft.rebuilt' : 'platform_draft.created',
    entityType: 'platform_draft',
    entityId: row.id,
    metadata: { platform: values.platform, articleId: article.id, errors: lint.filter((i) => i.severity === 'error').length, warnings: lint.filter((i) => i.severity === 'warning').length },
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

export interface StageOutcome {
  ok: boolean;
  message: string;
  draft: PlatformDraftDTO;
}

/** Create or update the PRIVATE copy on the platform. It never publishes and never touches a live article. */
export async function stageDraft(owner: OwnerContext, env: PublishEnv, id: unknown): Promise<StageOutcome> {
  const first = await loadDraft(owner, id);
  await refresh(owner, env, first.articleId);
  const draft = await loadDraft(owner, id);
  const name = PLATFORMS[draft.platform].name;
  if (!(STAGEABLE_STATUSES as readonly string[]).includes(draft.status)) {
    throw new ActionError('conflict', `This draft cannot be staged. ${STATUS_WHY[draft.status] ?? ''}`.trim(), {}, { code: 'STATUS' });
  }
  const errors = draft.lint.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    throw new ActionError('invalid', `Fix ${errors.length} problem${errors.length === 1 ? '' : 's'} before staging: ${errors[0]!.message}`, {}, { code: 'LINT' });
  }
  const connection = draft.connectionId ? await owner.data.connections.getWithKey(draft.connectionId) : null;
  if (!connection) throw new ActionError('conflict', `Connect ${name} first, in Settings > Connections.`, {}, { code: 'NOT_CONNECTED' });
  let secret: string;
  try {
    secret = plainSecret(env, connection);
  } catch (err) {
    throw new ActionError('unavailable', err instanceof KeyUnreadableError ? err.message : 'The saved key could not be read.');
  }
  const { adapter, ctx } = contextFor(env, connection, secret);
  const attempt = await owner.data.platformDrafts.startAttempt(draft.id, 'stage', draft.payloadSha256);

  try {
    const { value, attempts } = await stageWithRetries(env, draft.remoteId !== null, () => adapter.stage(ctx, { id: draft.id, payload: draft.payload, remoteId: draft.remoteId }));
    const staged = await owner.data.platformDrafts.markStaged(draft.id, draft.payloadSha256, { remoteId: value.remoteId, previewUrl: value.previewUrl });
    await owner.data.platformDrafts.finishAttempt(attempt.id, {
      status: 'succeeded',
      remoteId: value.remoteId,
      message: staged ? (attempts > 1 ? `Staged after ${attempts} tries.` : null) : 'The draft changed while it was being staged, so the result was not applied.',
    });
    await owner.data.audit.record({ actor: owner.actor, action: 'platform_draft.staged', entityType: 'platform_draft', entityId: draft.id, metadata: { platform: draft.platform, applied: Boolean(staged), attempts } });
    const view = await draftView(owner, await loadDraft(owner, draft.id));
    return staged
      ? { ok: true, message: `A private draft is on ${name}. It is not public.`, draft: view }
      : { ok: false, message: 'The draft changed while it was being staged. Review it and stage again.', draft: view };
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

// ---- approval ----------------------------------------------------------------------------------------

export interface ApprovalRequestOutcome {
  draft: PlatformDraftDTO;
  /** Where the owner reviews and approves. Opening it approves nothing. */
  link: string;
}

/**
 * Ask the owner to approve this exact payload. Creates a pending, single-use request that expires in 30
 * minutes. Anyone allowed to prepare drafts may ask; only the owner, in the app, can answer.
 */
export async function requestApproval(owner: OwnerContext, env: PublishEnv, id: unknown): Promise<ApprovalRequestOutcome> {
  const first = await loadDraft(owner, id);
  await refresh(owner, env, first.articleId);
  const draft = await loadDraft(owner, id);
  const name = PLATFORMS[draft.platform].name;
  if (draft.status === 'source_changed' || draft.stale) throw new ActionError('conflict', 'The article changed after this draft was built. Rebuild the draft first.', {}, { code: 'SOURCE_CHANGED' });
  if (draft.status !== 'staged' && draft.status !== 'pending_approval') {
    const why = draft.status === 'draft' || draft.status === 'failed' ? `Stage the private draft on ${name} first, so you can look at it before it goes public.` : (STATUS_WHY[draft.status] ?? 'It is not ready for approval.');
    throw new ActionError('conflict', `Approval cannot be requested yet. ${why}`, {}, { code: 'STATUS' });
  }
  const errors = draft.lint.filter((i) => i.severity === 'error');
  if (errors.length > 0) throw new ActionError('invalid', `Fix ${errors.length} problem${errors.length === 1 ? '' : 's'} first: ${errors[0]!.message}`, {}, { code: 'LINT' });
  const connection = draft.connectionId ? await owner.data.connections.get(draft.connectionId) : null;
  if (!connection || connection.status !== 'connected') throw new ActionError('conflict', `${name} is not connected. Reconnect it in Settings > Connections.`, {}, { code: 'UNHEALTHY' });

  const now = (env.now ?? (() => new Date()))();
  const approval = await owner.data.platformDrafts.openApproval(draft.id, {
    tag: approvalTag(draft.payloadSha256),
    expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
    requestedBy: owner.actor === 'agent' ? 'agent' : 'owner',
    expectedHash: draft.payloadSha256,
  });
  if (!approval) throw new ActionError('conflict', 'The draft changed. Review it and ask again.', {}, { code: 'STATUS' });
  await owner.data.audit.record({ actor: owner.actor, action: 'approval.requested', entityType: 'approval', entityId: approval.id, metadata: { platform: draft.platform, draftId: draft.id, tag: approval.tag } });
  return { draft: await draftView(owner, await loadDraft(owner, draft.id)), link: `${env.config.appUrl}/articles/${draft.articleId}?panel=publish` };
}

/** Say no to a pending request. Only the signed-in owner. The draft goes back to staged. */
export async function declineApproval(owner: OwnerContext, env: PublishEnv, approvalId: unknown): Promise<PlatformDraftDTO> {
  requireOwnerActor(owner, 'Declining an approval');
  const id = parseId(approvalId, 'Approval');
  const denied = await owner.data.platformDrafts.deny(id);
  if (!denied) throw new ActionError('conflict', 'This request is no longer pending.');
  await owner.data.audit.record({ actor: owner.actor, action: 'approval.declined', entityType: 'approval', entityId: id, metadata: { draftId: denied.draftId } });
  void env;
  return draftView(owner, await loadDraft(owner, denied.draftId));
}

const approveSchema = z.object({
  checked: z.array(z.string().max(300)).max(20),
});

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
  const name = PLATFORMS[draft.platform].name;
  const now = env.now ?? (() => new Date());

  const required = approvalChecklist(name, draft.payload.canonicalUrl !== null);
  const missing = required.filter((box) => !checked.includes(box));
  if (missing.length > 0) {
    throw new ActionError('invalid', `Tick every box before approving (${missing.length} left).`, { checked: 'Every box must be ticked.' }, { code: 'CHECKLIST', missing });
  }

  const connection = draft.connectionId ? await owner.data.connections.getWithKey(draft.connectionId) : null;
  if (!connection) throw new ActionError('conflict', `Connect ${name} first, in Settings > Connections.`, {}, { code: 'NOT_CONNECTED' });
  let secret: string;
  try {
    secret = plainSecret(env, connection);
  } catch (err) {
    throw new ActionError('unavailable', err instanceof KeyUnreadableError ? err.message : 'The saved key could not be read.');
  }
  const { adapter, ctx } = contextFor(env, connection, secret);

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
    publication = await adapter.publish(ctx, { id: draft.id, payload: authorized.draft.payload, remoteId: authorized.draft.remoteId });
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
  return { outcome: 'published', message: `Published on ${name}.`, draft: await draftView(owner, await loadDraft(owner, draft.id)) };
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
  await refresh(owner, env, first.articleId);
  const draft = await loadDraft(owner, id);
  const name = PLATFORMS[draft.platform].name;
  const connection = draft.connectionId ? await owner.data.connections.getWithKey(draft.connectionId) : null;
  if (!connection) throw new ActionError('conflict', `Connect ${name} first, in Settings > Connections.`, {}, { code: 'NOT_CONNECTED' });
  let secret: string;
  try {
    secret = plainSecret(env, connection);
  } catch (err) {
    throw new ActionError('unavailable', err instanceof KeyUnreadableError ? err.message : 'The saved key could not be read.');
  }
  const { adapter, ctx } = contextFor(env, connection, secret);
  const now = (env.now ?? (() => new Date()))();
  const view = async () => draftView(owner, await loadDraft(owner, draft.id));

  let result;
  try {
    result = await adapter.check(ctx, { id: draft.id, payload: draft.payload, remoteId: draft.remoteId });
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
    const resolved = draft.status === 'unknown' ? await owner.data.platformDrafts.resolveUnknown(draft.id, { outcome: 'published', remoteId: result.remoteId, remoteUrl: result.remoteUrl }, { kind: 'check', message: `Found live on ${name}.`, now }) : null;
    await owner.data.platformDrafts.finishAttempt(attempt.id, { status: 'succeeded', remoteId: result.remoteId, remoteUrl: result.remoteUrl, message: `Live on ${name}.` });
    await owner.data.audit.record({ actor: owner.actor, action: 'platform.checked', entityType: 'platform_draft', entityId: draft.id, metadata: { platform: draft.platform, remote: 'published', resolved: Boolean(resolved) } });
    return { remote: 'published', message: resolved ? `It is live on ${name}. The draft is now recorded as published.` : `It is live on ${name}.`, draft: await view() };
  }
  if (result.state === 'private') {
    const resolved = draft.status === 'unknown' ? await owner.data.platformDrafts.resolveUnknown(draft.id, { outcome: 'not_published' }, { kind: 'check', message: `Still private on ${name}.`, now }) : null;
    await owner.data.platformDrafts.finishAttempt(attempt.id, { status: 'succeeded', message: `Private on ${name}.` });
    await owner.data.audit.record({ actor: owner.actor, action: 'platform.checked', entityType: 'platform_draft', entityId: draft.id, metadata: { platform: draft.platform, remote: 'private', resolved: Boolean(resolved) } });
    return { remote: 'private', message: resolved ? `It is still a private draft on ${name}, so it did not go out. You can ask for approval again.` : `It is a private draft on ${name}.`, draft: await view() };
  }
  await owner.data.platformDrafts.finishAttempt(attempt.id, { status: 'succeeded', message: `Not found on ${name}.` });
  await owner.data.audit.record({ actor: owner.actor, action: 'platform.checked', entityType: 'platform_draft', entityId: draft.id, metadata: { platform: draft.platform, remote: 'not_found' } });
  return {
    remote: 'not_found',
    message: `It could not be found on ${name}. That is not proof it never went out, so the result stays unknown. Look in your ${name} dashboard, then mark it by hand.`,
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
