/**
 * The loopback API contract: request and response schemas for every `/api/*` route (T0.18), shared
 * with `DaemonClient` (T0.20) through the `@cph/daemon/api` export.
 *
 * This module imports nothing but zod at run time, so a client can load it without pulling in the
 * daemon (SQLite, keyring, routes). The route handlers live in `app.ts`.
 *
 * Every response that is not 2xx has the `ErrorBody` shape. Codes:
 * - the gate's `GateCode` (409), for example `PUBLISHING_DISABLED`, `HASH_MISMATCH`, `WRONG_CHANNEL`;
 * - the services' kebab-case codes (`unknown-draft` 404, `invalid-payload` 422, `not-stageable` 409, ...);
 * - the HTTP layer's own: `UNAUTHORIZED` 401, `FORBIDDEN_SCOPE` / `FORBIDDEN_HOST` / `FORBIDDEN_ORIGIN` 403,
 *   `BAD_REQUEST` 400, `NOT_FOUND` 404, `NOT_CONFIGURED` 503, `OPEN_FAILED` / `PLATFORM_ERROR` 502,
 *   `INTERNAL` 500.
 */
import { z } from 'zod';
import type { Authorship, DraftKind, DraftStatus, PlatformId, RouteKind } from '@cph/core';

// ---- shared vocabularies -----------------------------------------------------------------------

export const PLATFORM_IDS = ['devto', 'linkedin', 'x', 'bluesky', 'mastodon', 'hashnode', 'medium', 'substack', 'reddit', 'youtube'] as const satisfies readonly PlatformId[];
export const ROUTE_KINDS = ['direct', 'buffer', 'assist'] as const satisfies readonly RouteKind[];
export const DRAFT_KINDS = ['article', 'post', 'thread', 'video', 'newsletter', 'assist-kit'] as const satisfies readonly DraftKind[];
export const DRAFT_STATUSES = [
  'draft',
  'staged',
  'pending_approval',
  'approved',
  'scheduled',
  'publishing',
  'unknown',
  'published',
  'handed_off',
  'failed',
  'held',
  'source_changed',
] as const satisfies readonly DraftStatus[];
export const AUTHORSHIPS = ['verbatim', 'reformatted', 'ai-assisted'] as const satisfies readonly Authorship[];
/** The platforms Phase 0 can draft for. */
export const DRAFT_PLATFORMS = ['devto', 'linkedin'] as const;

const Platform = z.enum(PLATFORM_IDS);
const Route = z.enum(ROUTE_KINDS);
const DraftStatusSchema = z.enum(DRAFT_STATUSES);
/** A draft or approval id in a body (ids are UUIDs; the bound only keeps junk out). */
const Id = z.string().min(1).max(128);

export const ErrorBody = z.object({
  code: z.string(),
  message: z.string(),
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

export const LintResultSchema = z.object({ rule: z.string(), severity: z.enum(['error', 'warning']), message: z.string() });

// ---- dashboard pages ---------------------------------------------------------------------------

const PAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const BARE_PAGES: ReadonlySet<string> = new Set(['connections', 'approvals', 'content', 'log']);
/** `connections/<x>`: a platform, or `buffer` (the Buffer connect card, U0-B). */
const CONNECT_PAGES: ReadonlySet<string> = new Set([...PLATFORM_IDS, 'buffer']);

/**
 * The dashboard pages `open-dashboard` (and the login nonce) may point at: `connections`,
 * `connections/<platform>`, `connections/buffer`, `drafts/<id>`, `approvals`, `approvals/<id>`, `content`, `log`. No
 * leading slash, no query, no settings page: Claude can open a page to look at, never one that
 * changes settings.
 */
export function isDashboardPage(page: string): boolean {
  if (BARE_PAGES.has(page)) return true;
  const match = /^(connections|drafts|approvals)\/([^/]+)$/.exec(page);
  if (match === null) return false;
  const [, section, rest] = match as unknown as [string, string, string];
  return section === 'connections' ? CONNECT_PAGES.has(rest) : PAGE_ID.test(rest);
}

export const DashboardPage = z.string().max(100).refine(isDashboardPage, { message: 'not an allowed dashboard page' });

// ---- sync and content --------------------------------------------------------------------------

export const SyncResponse = z.object({
  upserted: z.number(),
  changed: z.array(z.string()),
  invalidatedApprovals: z.number(),
  errors: z.array(z.object({ slug: z.string(), message: z.string() })),
});
export type SyncResponse = z.infer<typeof SyncResponse>;

export const DraftSummary = z.object({ id: z.string(), platform: Platform, route: Route, status: DraftStatusSchema });

export const ContentSummary = z.object({
  slug: z.string(),
  canonicalUrl: z.string(),
  title: z.string(),
  date: z.string(),
  published: z.boolean(),
  dirty: z.boolean(),
  repoCommit: z.string(),
  canonicalLiveAt: z.string().optional(),
  t0: z.string().optional(),
  syncedAt: z.string(),
  drafts: z.array(DraftSummary),
});
export type ContentSummary = z.infer<typeof ContentSummary>;

export const ContentListResponse = z.object({ content: z.array(ContentSummary) });
export type ContentListResponse = z.infer<typeof ContentListResponse>;

export const ContentDetailResponse = ContentSummary.extend({
  /** The post could be read from disk just now. */
  readable: z.boolean(),
  /** What is on disk now is what the last sync recorded. */
  sourceCurrent: z.boolean(),
  frontmatter: z.record(z.string(), z.unknown()).optional(),
  /** The publishing package from the notes file, when the post has one. */
  notes: z.record(z.string(), z.unknown()).optional(),
  coverPngUrl: z.string().optional(),
});
export type ContentDetailResponse = z.infer<typeof ContentDetailResponse>;

// ---- connections -------------------------------------------------------------------------------

export const ConnectionViewSchema = z.object({
  platform: Platform,
  route: Route,
  account: z.string(),
  active: z.boolean(),
  state: z.enum(['connected', 'expiring', 'needs_reconnect', 'not_configured', 'manual_only', 'unchecked']),
  who: z.string().optional(),
  detail: z.string().optional(),
  nextAction: z.string().optional(),
  checkedAt: z.string().optional(),
});

export const ConnectionsResponse = z.object({
  /** False while the master key is missing (degraded mode: nothing can be connected, staged or published). */
  secretsReady: z.boolean(),
  connections: z.array(ConnectionViewSchema),
});
export type ConnectionsResponse = z.infer<typeof ConnectionsResponse>;

// ---- dashboard ---------------------------------------------------------------------------------

export const OpenDashboardRequest = z.strictObject({ page: DashboardPage });
export type OpenDashboardRequest = z.infer<typeof OpenDashboardRequest>;
/** Only this: the login nonce never leaves the daemon. */
export const OpenDashboardResponse = z.strictObject({ opened: z.literal(true), page: z.string() });
export type OpenDashboardResponse = z.infer<typeof OpenDashboardResponse>;

/** cli scope only (`cph dashboard`). Without `page` the login lands on the approvals queue. */
export const LoginNonceRequest = z.strictObject({ page: DashboardPage.optional() });
export type LoginNonceRequest = z.infer<typeof LoginNonceRequest>;
export const LoginNonceResponse = z.object({ nonce: z.string(), expiresAt: z.string(), url: z.string() });
export type LoginNonceResponse = z.infer<typeof LoginNonceResponse>;

// ---- drafts ------------------------------------------------------------------------------------

export const PreviewResponse = z.object({ payload: z.unknown(), lint: z.array(LintResultSchema) });
export type PreviewResponse = z.infer<typeof PreviewResponse>;

export const CreateDraftRequest = z.strictObject({
  slug: z.string().min(1).max(200),
  platform: z.enum(DRAFT_PLATFORMS),
  account: z.string().min(1).max(100).optional(),
  /** Omitted: the transform skeleton. Given: validated by the service, merged over the skeleton. */
  payload: z.record(z.string(), z.unknown()).optional(),
  authorship: z.enum(AUTHORSHIPS).optional(),
});
export type CreateDraftRequest = z.infer<typeof CreateDraftRequest>;

/** A payload patch, merged over the current payload. Any real change invalidates the draft's approvals. */
export const UpdateDraftRequest = z.strictObject({ payload: z.record(z.string(), z.unknown()) });
export type UpdateDraftRequest = z.infer<typeof UpdateDraftRequest>;

export const DraftListQuery = z.strictObject({
  slug: z.string().optional(),
  platform: Platform.optional(),
  status: DraftStatusSchema.optional(),
});

export const DraftViewSchema = z.object({
  id: z.string(),
  slug: z.string(),
  platform: Platform,
  account: z.string(),
  route: Route,
  kind: z.enum(DRAFT_KINDS),
  status: DraftStatusSchema,
  authorship: z.enum(AUTHORSHIPS),
  payload: z.unknown(),
  payloadSha256: z.string(),
  lint: z.array(LintResultSchema),
  notBefore: z.string().optional(),
  scheduledAt: z.string().optional(),
  remoteRef: z.string().optional(),
  remoteScheduledId: z.string().optional(),
  failureReason: z.string().optional(),
});
export const DraftResponse = DraftViewSchema;
export type DraftResponse = z.infer<typeof DraftResponse>;
export const DraftListResponse = z.object({ drafts: z.array(DraftViewSchema) });
export type DraftListResponse = z.infer<typeof DraftListResponse>;

export const StageResponse = z.object({ remoteId: z.string(), previewUrl: z.string().optional() });
export type StageResponse = z.infer<typeof StageResponse>;

export const CheckResponse = z.object({ outcome: z.enum(['published', 'failed', 'unknown']) });
export type CheckResponse = z.infer<typeof CheckResponse>;

// ---- approvals ---------------------------------------------------------------------------------

export const RequestApprovalRequest = z.strictObject({ draftId: Id });
export type RequestApprovalRequest = z.infer<typeof RequestApprovalRequest>;

/** Nothing in it can approve anything if echoed back: approving happens only in the dashboard, with Hello. */
export const ApprovalRequestResponse = z.object({
  approvalId: z.string(),
  status: z.literal('pending'),
  approveUrl: z.string(),
  instructions: z.string(),
});
export type ApprovalRequestResponse = z.infer<typeof ApprovalRequestResponse>;

/**
 * What `get_approval_status` reports. Claude polls until a terminal state: `published` (with
 * `remoteUrl` when known), `approved` (call publish within the TTL), `denied`, `expired`, and the
 * states in which the approval can no longer be used (`invalidated`, `cancelled`, `failed`,
 * `unknown`, `handed_off`). `publishing` means the approval was spent and the send is in flight.
 */
export const APPROVAL_STATES = [
  'pending',
  'approved',
  'publishing',
  'published',
  'handed_off',
  'failed',
  'unknown',
  'denied',
  'expired',
  'invalidated',
  'cancelled',
] as const;
export const TERMINAL_APPROVAL_STATES: readonly ApprovalState[] = APPROVAL_STATES.filter((s) => s !== 'pending' && s !== 'publishing');
export type ApprovalState = (typeof APPROVAL_STATES)[number];

export const ApprovalStatusResponse = z.object({
  approvalId: z.string(),
  draftId: z.string(),
  status: z.enum(APPROVAL_STATES),
  /** Meaningful once approved: `approve_only` (Claude may publish it) or `publish_now` / `schedule` (dashboard only). */
  mode: z.enum(['publish_now', 'approve_only', 'schedule']),
  expiresAt: z.string(),
  remoteUrl: z.string().optional(),
});
export type ApprovalStatusResponse = z.infer<typeof ApprovalStatusResponse>;

/**
 * What the chat approval prompt shows (cph MCP `approve_in_chat`): the approval card as data. Read-only;
 * it cannot approve anything. `payloadText` is the payload exactly as it will be sent.
 */
export const ApprovalCardResponse = z.object({
  approvalId: z.string(),
  draftId: z.string(),
  status: z.enum(APPROVAL_STATES),
  platform: Platform,
  route: Route,
  slug: z.string(),
  /** `#3F9A12C0`: the first 8 hex characters of the payload hash, upper-cased. */
  tag: z.string(),
  payloadText: z.string(),
  checklist: z.array(z.string()),
});
export type ApprovalCardResponse = z.infer<typeof ApprovalCardResponse>;

/** mcp scope only. `checked` must be every checklist box, verbatim; `mode` can only be approve_only. */
export const ApproveChatRequest = z.strictObject({
  checked: z.array(z.string().min(1).max(1000)).min(1).max(50),
  mode: z.literal('approve_only'),
});
export type ApproveChatRequest = z.infer<typeof ApproveChatRequest>;
export const ApproveChatResponse = z.object({ approvalId: z.string(), approved: z.literal(true) });
export type ApproveChatResponse = z.infer<typeof ApproveChatResponse>;

// ---- publishing --------------------------------------------------------------------------------

/** Only Approve-only approvals can be spent here; there is no way to ask for another mode. */
export const PublishRequest = z.strictObject({ draftId: Id, approvalId: Id });
export type PublishRequest = z.infer<typeof PublishRequest>;
export const PublishResponse = z.object({
  status: z.enum(['published', 'failed', 'unknown', 'dry_run']),
  remoteUrl: z.string().optional(),
  /** Redacted. Set for failed and unknown. */
  error: z.string().optional(),
});
export type PublishResponse = z.infer<typeof PublishResponse>;

export const HandoffRequest = z.strictObject({ approvalId: Id });
export type HandoffRequest = z.infer<typeof HandoffRequest>;
export const HandoffResponse = z.object({ copiedText: z.string(), openUrl: z.string(), checklist: z.array(z.string()) });
export type HandoffResponse = z.infer<typeof HandoffResponse>;

export const RecordPublicationRequest = z.strictObject({ draftId: Id, url: z.string().min(1).max(2000) });
export type RecordPublicationRequest = z.infer<typeof RecordPublicationRequest>;
export const RecordPublicationResponse = z.object({ draft: DraftViewSchema });
export type RecordPublicationResponse = z.infer<typeof RecordPublicationResponse>;

// ---- log ---------------------------------------------------------------------------------------

export const LogQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  draftId: z.string().min(1).optional(),
});
export const AuditEntrySchema = z.object({
  id: z.number(),
  ts: z.string(),
  actorChannel: z.string(),
  action: z.string(),
  draftId: z.string().optional(),
  approvalId: z.string().optional(),
  hash: z.string().optional(),
  platform: z.string().optional(),
  detail: z.unknown().optional(),
});
export const LogResponse = z.object({ entries: z.array(AuditEntrySchema) });
export type LogResponse = z.infer<typeof LogResponse>;
