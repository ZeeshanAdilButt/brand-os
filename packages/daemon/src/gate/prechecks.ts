import { payloadHash, transforms, type ContentItem, type Draft, type LintResult } from '@cph/core';
import type { ContentRow, Repos } from '../db/repos.js';
import type { GateCode } from './errors.js';
import { ALREADY_OUT, LIVE_DRAFT_STATUSES } from './statuses.js';

/**
 * The individual checks behind `ApprovalGate` (spec 2.6 rules 1 and 5). Each returns a `Refusal`
 * or `undefined`; none of them throws or writes, so the gate can run the whole list twice (once
 * before the async health probe, once inside the consuming transaction) and audit in one place.
 */
export interface Refusal {
  code: GateCode;
  message: string;
  detail?: Record<string, unknown>;
}

export type LintDraft = (draft: Draft, item: ContentItem) => LintResult[];

/**
 * The approval hash, recomputed from the stored payload. The `payload_sha256` column is never
 * trusted on its own. Phase 0 drafts carry no media, so `mediaSha256` is empty.
 */
export function recomputeHash(draft: Pick<Draft, 'platform' | 'account' | 'route' | 'payload' | 'scheduledAt'>): string {
  return payloadHash({
    platform: draft.platform,
    account: draft.account,
    route: draft.route,
    payload: draft.payload,
    mediaSha256: [],
    scheduledAt: draft.scheduledAt ?? null,
  });
}

/** True when `iso` is at or before `now`. An unreadable time counts as past (fail closed). */
export function isPast(iso: string, now: Date): boolean {
  const t = Date.parse(iso);
  return !Number.isFinite(t) || t <= now.getTime();
}

/** Only the exact stored value 'true' enables publishing. */
export function checkPublishingEnabled(repos: Repos): Refusal | undefined {
  if (repos.settings.get('publishing_enabled') === 'true') return undefined;
  return { code: 'PUBLISHING_DISABLED', message: 'publishing is disabled' };
}

/** The canonical page passed the live check (canonical_live_at set) and the post is published. */
export function checkCanonicalLive(content: ContentRow | undefined): Refusal | undefined {
  if (content === undefined) return { code: 'CANONICAL_NOT_LIVE', message: 'the post is not in the content table' };
  if (content.canonicalLiveAt === undefined) {
    return { code: 'CANONICAL_NOT_LIVE', message: `${content.canonicalUrl} has not passed the live check` };
  }
  if (!content.published) return { code: 'CANONICAL_NOT_LIVE', message: 'the post frontmatter says published: false' };
  return undefined;
}

/**
 * The post as it is on disk now must be the post the last sync recorded. A mismatch means it was
 * edited (or vanished) after the drafts were built and sync has not flagged them yet (Review Focus #1).
 */
export function checkSourceCurrent(content: ContentRow | undefined, item: ContentItem | undefined): Refusal | undefined {
  if (item === undefined) return { code: 'SOURCE_CHANGED', message: 'the post can no longer be read' };
  if (content === undefined) return { code: 'SOURCE_CHANGED', message: 'the post is not in the content table' };
  if (item.source.mdxSha256 !== content.mdxSha256 || item.source.notesSha256 !== content.notesSha256) {
    return { code: 'SOURCE_CHANGED', message: 'the post or its notes changed since the last sync' };
  }
  return undefined;
}

/**
 * The draft was built from the post version the content row records now. A draft made before the
 * post changed (or before source hashes were recorded) is refused even if its status was never
 * flagged: approving it would approve text built from another version of the post.
 */
export function checkDraftSource(draft: Draft, content: ContentRow | undefined): Refusal | undefined {
  if (content === undefined) return { code: 'SOURCE_CHANGED', message: 'the post is not in the content table' };
  if (draft.sourceMdxSha256 !== content.mdxSha256 || draft.sourceNotesSha256 !== content.notesSha256) {
    return {
      code: 'SOURCE_CHANGED',
      message: 'the draft was built from another version of the post; create a new draft',
      detail: { draftSource: draft.sourceMdxSha256 ?? null, contentSource: content.mdxSha256 },
    };
  }
  return undefined;
}

/** The platform transform's lint, run on the stored payload against the current post. */
export const defaultLintDraft: LintDraft = (draft, item) => {
  const transform = transforms[draft.platform];
  if (transform === undefined) {
    return [{ rule: 'no-transform', severity: 'error', message: `no transform is registered for ${draft.platform}` }];
  }
  return transform.lint(draft.payload, item);
};

/** No lint result of severity 'error'. A lint that throws is a failure, not a pass. */
export function checkLint(draft: Draft, item: ContentItem, lintDraft: LintDraft): Refusal | undefined {
  let results: LintResult[];
  try {
    results = lintDraft(draft, item);
  } catch (err) {
    return { code: 'LINT_ERRORS', message: `lint failed: ${err instanceof Error ? err.message : String(err)}`, detail: { rules: ['lint-threw'] } };
  }
  const errors = results.filter((r) => r.severity !== 'warning');
  if (errors.length === 0) return undefined;
  return {
    code: 'LINT_ERRORS',
    message: errors.map((e) => `${e.rule}: ${e.message}`).join('; '),
    detail: { rules: errors.map((e) => e.rule) },
  };
}

/** The SEO delay: `not_before` must have passed. An unreadable value blocks. */
export function checkNotBefore(draft: Draft, now: Date): Refusal | undefined {
  if (draft.notBefore === undefined) return undefined;
  const t = Date.parse(draft.notBefore);
  if (!Number.isFinite(t)) return { code: 'NOT_BEFORE', message: `not_before is not a valid time: ${draft.notBefore}` };
  if (t <= now.getTime()) return undefined;
  return { code: 'NOT_BEFORE', message: `not before ${draft.notBefore}`, detail: { notBefore: draft.notBefore } };
}

/**
 * The draft is in a state the gate may act on (positive allowlist, shared with sync):
 * - `source_changed` gives SOURCE_CHANGED;
 * - in flight or already out (`publishing`, `unknown`, `published`, `handed_off`) gives DUPLICATE;
 * - anything else not on `LIVE_DRAFT_STATUSES` gives NOT_APPROVED.
 */
export function checkDraftStatus(draft: Draft): Refusal | undefined {
  if (LIVE_DRAFT_STATUSES.has(draft.status)) return undefined;
  if (draft.status === 'source_changed') {
    return { code: 'SOURCE_CHANGED', message: 'the post changed after this draft was made', detail: { status: draft.status } };
  }
  if (ALREADY_OUT.has(draft.status)) {
    return { code: 'DUPLICATE', message: `the draft is already ${draft.status}`, detail: { status: draft.status } };
  }
  return { code: 'NOT_APPROVED', message: `a draft in status ${String(draft.status)} cannot be approved or published`, detail: { status: draft.status } };
}

/**
 * A platform scheduler (Buffer customScheduled, YouTube publishAt) still holds a post for this draft.
 * Until it is cancelled (or the user confirms they removed it by hand) the draft cannot be approved
 * again: a second approval would let a new post go out next to the old scheduled one.
 */
export function checkRemoteScheduled(draft: Draft): Refusal | undefined {
  if (draft.remoteScheduledId === undefined) return undefined;
  return {
    code: 'REMOTE_SCHEDULED',
    message: 'a scheduled post for this draft is still on the platform; cancel it (or confirm you deleted it) first',
    detail: { remoteScheduledId: draft.remoteScheduledId },
  };
}

/** The same hash was never published to this platform. */
export function checkDuplicate(repos: Repos, draft: Draft, hash: string): Refusal | undefined {
  const existing = repos.publications.findByHash(draft.platform, hash);
  if (existing !== undefined) {
    return { code: 'DUPLICATE', message: `already published to ${draft.platform}`, detail: { publicationId: existing.id } };
  }
  return undefined;
}
