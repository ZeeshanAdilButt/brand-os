import type { ContentItem } from '@cph/core';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import { errorText, redactDetail } from '../audit.js';
import type { Approval, Repos } from '../db/repos.js';
import { approvalTag, type ApprovalGate } from '../gate/approval-gate.js';
import { GateError } from '../gate/errors.js';
import { isPast } from '../gate/prechecks.js';
import { silentLogger, type Logger } from '../log.js';
import { validateLinkedinPostUrl } from '../routes/assist-linkedin.js';
import { BufferMutationError } from '../routes/buffer-client.js';
import { BufferStageError } from '../routes/buffer.js';
import { PlatformError, StageRefused } from '../routes/types.js';
import { MasterKeyInvalid, MasterKeyMissing } from '../secrets/keystore.js';
import { SecretDecryptError } from '../secrets/secret-store.js';
import type { ConnectionsService, ConnectionView } from '../services/connections.js';
import { DraftError, type DraftErrorCode, type DraftPlatform, type DraftsService } from '../services/drafts.js';
import type { PublishService } from '../services/publish.js';
import type { RecoveryService } from '../services/recovery.js';
import type { SyncResult } from '../sync.js';
import {
  ApproveChatRequest,
  CreateDraftRequest,
  DraftListQuery,
  HandoffRequest,
  LogQuery,
  LoginNonceRequest,
  OpenDashboardRequest,
  PublishRequest,
  RecordPublicationRequest,
  RequestApprovalRequest,
  UpdateDraftRequest,
  type ApprovalCardResponse,
  type ApprovalState,
  type ApprovalStatusResponse,
  type ApproveChatResponse,
  type ContentDetailResponse,
  type ContentSummary,
} from './api.js';
import {
  dashboardLoginUrl,
  DEFAULT_DAEMON_PORT,
  hostAndOriginGuard,
  requireScope,
  type LoginNonceStore,
  type ScopeVariables,
  type TokenVerifier,
} from './auth.js';

export interface AppDeps {
  /** Default 4646. Used for the Host / Origin guard and the login URL. */
  port?: number;
  tokens: TokenVerifier;
  nonces: LoginNonceStore;
  /** Opens the default browser (the `open` package in production, a fake in tests). */
  opener: (url: string) => Promise<void>;
  repos: Repos;
  drafts: DraftsService;
  publish: Pick<PublishService, 'publish' | 'handOff' | 'recordPublication'>;
  recovery: Pick<RecoveryService, 'checkOnPlatform'>;
  /** Only `request`: approving and denying are dashboard-only (T0.19), never on this router. */
  gate: Pick<ApprovalGate, 'request'>;
  /**
   * The chat approval path (mcp token only): a gate whose presence is the chat prompt the MCP server
   * showed, so it answers 'verified'. Without it the two chat routes answer 503.
   */
  chatGate?: Pick<ApprovalGate, 'approve' | 'checklist'>;
  connections: Pick<ConnectionsService, 'list'>;
  /** `syncContent` with the daemon's deps (single-flight). */
  sync: () => Promise<SyncResult>;
  /** The post as it is on disk now, or undefined. */
  loadContentItem: (slug: string) => ContentItem | undefined;
  /** False while the master key is missing or malformed (degraded mode). */
  secretsReady: () => boolean;
  now?: () => Date;
  /** The cookie-authenticated dashboard router (`createDashboardRouter`); without one every dashboard request is refused. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the dashboard router has its own context variables
  dashboard?: Hono<any>;
  log?: Logger;
}

/** Bodies are small JSON objects; anything larger is refused before it is parsed. */
const MAX_BODY_BYTES = 1024 * 1024;
const BOTH = ['mcp', 'cli'] as const;
const CLI_ONLY = ['cli'] as const;
const MCP_ONLY = ['mcp'] as const;
const NOT_CONFIGURED_MESSAGE = 'The master key is missing from Windows Credential Manager, so nothing can be connected, staged or published. Run `cph install` to create it, then reconnect the platforms.';
/** Where `cph dashboard` lands when it does not name a page. */
const DEFAULT_LOGIN_PAGE = 'approvals';

/** A refusal raised by the HTTP layer itself, mapped to `{code, message}` with its status. */
class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const DRAFT_ERROR_STATUS: Record<DraftErrorCode, ContentfulStatusCode> = {
  'unknown-draft': 404,
  'unknown-post': 404,
  'unsupported-platform': 422,
  'invalid-payload': 422,
  'full-text-immutable': 422,
  'canonical-not-live': 409,
  'not-editable': 409,
  conflict: 409,
  'no-stage': 409,
  'not-stageable': 409,
  'no-remote-schedule': 409,
  'no-route': 409,
  'not-staged': 409,
  'assist-route': 409,
  'inactive-route': 409,
  'not-handed-off': 409,
  'not-unknown': 409,
  'sync-first': 409,
};

type ErrorJson = { code: string; message: string; detail?: Record<string, unknown> };

/** Maps any thrown value to a status and a redacted body. Never echoes a secret, a nonce or a token. */
export function errorResponse(error: unknown): { status: ContentfulStatusCode; body: ErrorJson } {
  const body = (status: ContentfulStatusCode, code: string, message: string, detail?: Record<string, unknown>) => ({
    status,
    body: { code, message: errorText(message), ...(detail === undefined ? {} : { detail: redactDetail(detail) as Record<string, unknown> }) },
  });
  if (error instanceof ApiError) return body(error.status, error.code, error.message, error.detail);
  if (error instanceof GateError) return body(409, error.code, error.message.replace(/^[A-Z_]+: /, ''), error.detail);
  if (error instanceof DraftError) return body(DRAFT_ERROR_STATUS[error.code] ?? 409, error.code, error.message.replace(/^[a-z-]+: /, ''), error.detail);
  if (error instanceof MasterKeyMissing || error instanceof MasterKeyInvalid) return body(503, 'NOT_CONFIGURED', NOT_CONFIGURED_MESSAGE);
  if (error instanceof SecretDecryptError) return body(503, 'SECRET_UNREADABLE', `${error.message} Reconnect it in the dashboard.`);
  if (error instanceof StageRefused) return body(409, 'STAGE_REFUSED', error.message);
  if (error instanceof PlatformError) return body(502, 'PLATFORM_ERROR', error.message, { httpStatus: error.status });
  if (error instanceof BufferMutationError || error instanceof BufferStageError) return body(502, 'PLATFORM_ERROR', error.message);
  return body(500, 'INTERNAL', error instanceof Error ? `${error.name}: ${error.message}` : 'unexpected error');
}

async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  const text = await c.req.text();
  let raw: unknown = {};
  if (text.trim() !== '') {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new ApiError(400, 'BAD_REQUEST', 'the body is not valid JSON');
    }
  }
  return parse(schema, raw);
}

/** zod's optional fields read `x?: T | undefined`; the services take `x?: T` (exactOptionalPropertyTypes). */
type Compact<T> = { [K in keyof T]: Exclude<T[K], undefined> };
function compact<T extends object>(value: T): Compact<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Compact<T>;
}

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ');
    throw new ApiError(400, 'BAD_REQUEST', issues);
  }
  return result.data;
}

/**
 * The payload as the prompt shows it: LinkedIn is the post text (plus its link attachment), dev.to is
 * the fields and the article body, anything else is the JSON. Nothing is shortened.
 */
export function payloadText(payload: unknown): string {
  const p = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : undefined;
  if (p === undefined) return JSON.stringify(payload, null, 2);
  const str = (key: string): string | undefined => (typeof p[key] === 'string' ? (p[key] as string) : undefined);
  if (typeof p['text'] === 'string') {
    const link = typeof p['link'] === 'object' && p['link'] !== null ? (p['link'] as Record<string, unknown>) : undefined;
    return link === undefined ? p['text'] : `${p['text']}\n\nLink attachment: ${String(link['url'] ?? '')}`;
  }
  if (typeof p['body_markdown'] === 'string') {
    const tags = Array.isArray(p['tags']) ? (p['tags'] as unknown[]).map(String).join(', ') : '';
    return [
      `title: ${str('title') ?? ''}`,
      `canonical_url: ${str('canonical_url') ?? ''}`,
      `description: ${str('description') ?? ''}`,
      `tags: ${tags}`,
      '',
      p['body_markdown'],
    ].join('\n');
  }
  return JSON.stringify(payload, null, 2);
}

/** The status `get_approval_status` reports: the approval row, read together with its draft and publication. */
export function approvalState(repos: Repos, approval: Approval, now: Date): { status: ApprovalState; remoteUrl?: string } {
  const draft = repos.drafts.get(approval.draftId);
  if (approval.usedAt !== undefined) {
    if (draft === undefined) return { status: 'failed' };
    if (draft.status === 'published') {
      const publication = repos.publications.findByHash(draft.platform, approval.payloadSha256);
      return publication?.remoteUrl === undefined ? { status: 'published' } : { status: 'published', remoteUrl: publication.remoteUrl };
    }
    if (draft.status === 'publishing' || draft.status === 'unknown' || draft.status === 'handed_off') return { status: draft.status };
    // Spent, and the post did not go out with it (failed, dry run, or edited since): this approval is done.
    return { status: 'failed' };
  }
  switch (approval.status) {
    case 'pending':
    case 'approved':
      return { status: isPast(approval.expiresAt, now) ? 'expired' : approval.status };
    default:
      return { status: approval.status };
  }
}

/**
 * The daemon's HTTP app. Every request passes the Host / Origin guard. `/api/*` is the bearer-token
 * router (mcp and cli scopes); everything else is the cookie-authenticated dashboard, which never
 * accepts a bearer token. No API route approves, denies, changes settings, toggles publishing,
 * confirms a remote cancel or resolves an unknown draft by hand.
 */
export function createApp(deps: AppDeps): Hono {
  const port = deps.port ?? DEFAULT_DAEMON_PORT;
  const log = deps.log ?? silentLogger;
  const now = deps.now ?? (() => new Date());
  const { repos } = deps;

  const app = new Hono();
  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    // Path only: a query string can carry a login nonce.
    log(c.res.status >= 500 ? 'error' : 'info', `${c.req.method} ${new URL(c.req.url).pathname} ${c.res.status} ${Date.now() - started}ms`);
  });
  app.use('*', hostAndOriginGuard(port));

  const api = new Hono<{ Variables: ScopeVariables }>();
  api.use('*', bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ code: 'BAD_REQUEST', message: 'the body is too large' }, 413) }));
  const both = requireScope(deps.tokens, BOTH);
  const cliOnly = requireScope(deps.tokens, CLI_ONLY);
  const mcpOnly = requireScope(deps.tokens, MCP_ONLY);

  const requireSecrets = (): void => {
    if (!deps.secretsReady()) throw new ApiError(503, 'NOT_CONFIGURED', NOT_CONFIGURED_MESSAGE);
  };
  const requireDraft = (id: string): void => {
    if (repos.drafts.get(id) === undefined) throw new ApiError(404, 'unknown-draft', `no draft ${id}`);
  };
  const contentSummary = (slug: string): ContentSummary | undefined => {
    const row = repos.content.get(slug);
    if (row === undefined) return undefined;
    return {
      ...row,
      drafts: repos.drafts.list({ slug }).map((d) => ({ id: d.id, platform: d.platform, route: d.route, status: d.status })),
    };
  };

  // ---- sync and content ----

  api.post('/sync', both, async (c) => c.json(await deps.sync()));

  api.get('/content', both, (c) => c.json({ content: repos.content.list().map((row) => contentSummary(row.slug) as ContentSummary) }));

  api.get('/content/:slug', both, (c) => {
    const slug = c.req.param('slug');
    const summary = contentSummary(slug);
    if (summary === undefined) throw new ApiError(404, 'unknown-post', `${slug} has not been synced`);
    const item = deps.loadContentItem(slug);
    const detail: ContentDetailResponse = { ...summary, readable: item !== undefined, sourceCurrent: false };
    if (item !== undefined) {
      const row = repos.content.get(slug);
      detail.sourceCurrent = row?.mdxSha256 === item.source.mdxSha256 && row.notesSha256 === item.source.notesSha256;
      detail.frontmatter = { ...item.frontmatter };
      if (item.notes !== undefined) detail.notes = { ...item.notes };
      detail.coverPngUrl = item.coverPngUrl;
    }
    return c.json(detail);
  });

  // ---- connections ----

  api.get('/connections', both, (c) => {
    const ready = deps.secretsReady();
    const connections = deps.connections.list().map((view): ConnectionView => {
      if (ready || view.route === 'assist') return view;
      return { platform: view.platform, route: view.route, account: view.account, active: view.active, state: 'not_configured', nextAction: 'Run `cph install` to create the master key, then reconnect.' };
    });
    // Last line of defence: nothing here should look like a secret, and anything that does is masked.
    return c.json({ secretsReady: ready, connections: redactDetail(connections) as ConnectionView[] });
  });

  // ---- dashboard ----

  api.post('/open-dashboard', both, async (c) => {
    const { page } = await readJson(c, OpenDashboardRequest);
    const { nonce } = deps.nonces.mint();
    try {
      await deps.opener(dashboardLoginUrl(nonce, page, port));
    } catch {
      deps.nonces.revoke(nonce);
      // The opener's error may quote the URL, and with it the nonce: never echo it.
      throw new ApiError(502, 'OPEN_FAILED', 'the default browser could not be opened; run `cph dashboard` instead');
    }
    return c.json({ opened: true as const, page });
  });

  api.post('/dashboard-login-nonce', cliOnly, async (c) => {
    const { page } = await readJson(c, LoginNonceRequest);
    const { nonce, expiresAt } = deps.nonces.mint();
    return c.json({ nonce, expiresAt, url: dashboardLoginUrl(nonce, page ?? DEFAULT_LOGIN_PAGE, port) });
  });

  // ---- drafts ----

  api.get('/preview/:slug/:platform', both, (c) => c.json(deps.drafts.preview(c.req.param('slug'), c.req.param('platform') as DraftPlatform)));

  api.post('/drafts', both, async (c) => {
    const input = await readJson(c, CreateDraftRequest);
    return c.json(deps.drafts.create(compact(input)), 201);
  });

  api.get('/drafts', both, (c) => {
    const filter = parse(DraftListQuery, c.req.query());
    return c.json({ drafts: deps.drafts.list(compact(filter)) });
  });

  api.get('/drafts/:id', both, (c) => c.json(deps.drafts.get(c.req.param('id'))));

  api.patch('/drafts/:id', both, async (c) => {
    const id = c.req.param('id');
    requireDraft(id);
    const { payload } = await readJson(c, UpdateDraftRequest);
    return c.json(await deps.drafts.update(id, payload));
  });

  api.post('/drafts/:id/stage', both, async (c) => {
    const id = c.req.param('id');
    requireDraft(id);
    requireSecrets();
    const ref = await deps.drafts.stage(id);
    return c.json(ref.previewUrl === undefined ? { remoteId: ref.remoteId } : { remoteId: ref.remoteId, previewUrl: ref.previewUrl });
  });

  api.post('/drafts/:id/check', both, async (c) => {
    const id = c.req.param('id');
    requireDraft(id);
    return c.json({ outcome: await deps.recovery.checkOnPlatform(id) });
  });

  // ---- approvals ----

  api.post('/approvals', both, async (c) => {
    const { draftId } = await readJson(c, RequestApprovalRequest);
    requireDraft(draftId);
    return c.json(deps.gate.request(draftId), 201);
  });

  api.get('/approvals/:id', both, (c) => {
    const id = c.req.param('id');
    const approval = repos.approvals.get(id);
    if (approval === undefined) throw new ApiError(404, 'NO_APPROVAL', `no approval ${id}`);
    const state = approvalState(repos, approval, now());
    const body: ApprovalStatusResponse = { approvalId: approval.id, draftId: approval.draftId, mode: approval.mode, expiresAt: approval.expiresAt, ...state };
    return c.json(body);
  });

  // ---- approval in chat (mcp only) ----

  const chatGate = (): NonNullable<AppDeps['chatGate']> => {
    if (deps.chatGate === undefined) throw new ApiError(503, 'NOT_CONFIGURED', 'approval in chat is not available');
    return deps.chatGate;
  };

  /** The approval as the chat prompt shows it. Read-only. */
  api.get('/approvals/:id/card', both, (c) => {
    const id = c.req.param('id');
    const approval = repos.approvals.get(id);
    if (approval === undefined) throw new ApiError(404, 'NO_APPROVAL', `no approval ${id}`);
    const draft = repos.drafts.get(approval.draftId);
    if (draft === undefined) throw new ApiError(404, 'unknown-draft', `no draft ${approval.draftId}`);
    const state = approvalState(repos, approval, now());
    const body: ApprovalCardResponse = {
      approvalId: approval.id,
      draftId: draft.id,
      status: state.status,
      platform: draft.platform,
      route: draft.route,
      slug: draft.slug,
      tag: approvalTag(approval.payloadSha256),
      payloadText: payloadText(draft.payload),
      // Only a pending approval can be answered, and the post must still be readable to list its boxes.
      checklist: state.status === 'pending' ? chatGate().checklist(draft.id) : [],
    };
    return c.json(body);
  });

  /** Records an approval answered in Claude Code (elicitation). The gate still checks every box and the hash. */
  api.post('/approvals/:id/approve-chat', mcpOnly, async (c) => {
    const id = c.req.param('id');
    const { checked, mode } = await readJson(c, ApproveChatRequest);
    if (repos.approvals.get(id) === undefined) throw new ApiError(404, 'NO_APPROVAL', `no approval ${id}`);
    await chatGate().approve(id, { channel: 'chat_elicitation', checked, mode });
    const body: ApproveChatResponse = { approvalId: id, approved: true };
    return c.json(body);
  });

  // ---- publishing ----

  api.post('/publish', both, async (c) => {
    // Only the two ids: the allowed approval mode is fixed by PublishService.publish (approve_only).
    const { draftId, approvalId } = await readJson(c, PublishRequest);
    requireDraft(draftId);
    requireSecrets();
    return c.json(await deps.publish.publish(draftId, approvalId));
  });

  api.post('/drafts/:id/handoff', both, async (c) => {
    const draftId = c.req.param('id');
    const { approvalId } = await readJson(c, HandoffRequest);
    requireDraft(draftId);
    return c.json(await deps.publish.handOff(draftId, approvalId));
  });

  api.post('/publications', both, async (c) => {
    const { draftId, url } = await readJson(c, RecordPublicationRequest);
    requireDraft(draftId);
    try {
      validateLinkedinPostUrl(url);
    } catch (error) {
      throw new ApiError(422, 'invalid-url', error instanceof Error ? error.message : 'the post URL is not valid');
    }
    deps.publish.recordPublication(draftId, url);
    return c.json({ draft: deps.drafts.get(draftId) }, 201);
  });

  // ---- log ----

  api.get('/log', both, (c) => {
    const query = parse(LogQuery, c.req.query());
    const entries = repos.audit.list(compact(query));
    // The audit helper already redacts details; this pass also covers rows written around it.
    return c.json({ entries: redactDetail(entries) });
  });

  api.all('*', (c) => c.json({ code: 'NOT_FOUND', message: `no API route ${c.req.method} ${new URL(c.req.url).pathname}` }, 404));

  const onError = (error: unknown, c: Context): Response => {
    const { status, body } = errorResponse(error);
    if (status >= 500) log('error', `${c.req.method} ${new URL(c.req.url).pathname}: ${errorText(error)}`);
    return c.json(body, status);
  };
  api.onError(onError);
  app.onError(onError);

  app.route('/api', api);
  app.route('/', deps.dashboard ?? lockedDashboard());
  return app;
}

/**
 * Stands in for the dashboard when none is given (API-only apps in tests): a request carrying
 * `Authorization` and every other request are refused (403). API tokens never reach a dashboard route.
 */
function lockedDashboard(): Hono {
  const locked = new Hono();
  locked.all('*', (c) =>
    c.json(
      c.req.header('authorization') === undefined
        ? { code: 'FORBIDDEN', message: 'sign in to the dashboard through `cph dashboard` or open_dashboard' }
        : { code: 'FORBIDDEN', message: 'the dashboard does not accept API tokens; sign in through `cph dashboard`' },
      403,
    ),
  );
  return locked;
}

