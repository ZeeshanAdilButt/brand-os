import type { DraftStatus } from '@cph/core';

/**
 * Draft states from which a post can still reach a platform. This one list serves two purposes:
 * - sync flags these drafts `source_changed` (and invalidates their approvals) when the post changes;
 * - the gate refuses to request, approve or authorize a draft in any other state.
 *
 * Because both use the same list, the gate can never accept a draft that sync would not stop
 * (Review Focus #1). `failed` and `held` are on it because a human may re-approve them.
 */
export const LIVE_DRAFT_STATUSES: ReadonlySet<DraftStatus> = new Set<DraftStatus>([
  'draft',
  'staged',
  'pending_approval',
  'approved',
  'scheduled',
  'failed',
  'held',
]);

/**
 * Draft states in which the post is in flight or already out. A new approval must never send it
 * again. `unknown` in particular means the remote call may have happened without a publication row.
 */
export const ALREADY_OUT: ReadonlySet<DraftStatus> = new Set<DraftStatus>(['publishing', 'unknown', 'published', 'handed_off']);
