import { buildContentItem, DEFAULT_BASE_URL, type ContentItem } from '@cph/core';
import type { Repos } from './db/repos.js';
import { LIVE_DRAFT_STATUSES } from './gate/statuses.js';
import { checkCanonicalLive } from './live-check.js';
import type { SiteReader } from './site/site-reader.js';
import { computeT0 } from './t0.js';

export interface SyncDeps {
  reader: SiteReader;
  repos: Repos;
  fetchFn: typeof fetch;
  now: () => Date;
  /**
   * Called once per sync with the ids of drafts that were flagged `source_changed` while a platform
   * scheduler still holds their post (`remote_scheduled_id`). T1.7 wires remote cancellation here;
   * in Phase 0 nothing is platform-scheduled, so it is normally not called. If it rejects, the local
   * flags stay (the old text must never be approved), the failure is audited, and the error is rethrown.
   */
  onInvalidated?: (draftIds: string[]) => Promise<void>;
  /** IANA name of the site's time zone (config `site.timeZone`). Defaults to the machine's. */
  timeZone?: string;
  /** Config `site.baseUrl`. Defaults to https://www.example-blog.dev. */
  baseUrl?: string;
}

export interface SyncError {
  slug: string;
  message: string;
}

export interface SyncResult {
  /** Posts parsed and written to `content`. */
  upserted: number;
  /** Slugs that were already known and whose MDX or notes hash changed. New posts are not "changed". */
  changed: string[];
  /** Approvals set to `invalidated` because their draft's source changed. */
  invalidatedApprovals: number;
  /** Posts that could not be read or parsed; the rest of the sync still ran. */
  errors: SyncError[];
}

/** A draft in one of these states can still reach a platform, so a source change must stop it. Shared with the gate. */
const FLAGGED_ON_CHANGE = LIVE_DRAFT_STATUSES;

const ACTOR = 'sync';

/**
 * Reads every post through the read-only `SiteReader`, upserts `content`, runs the canonical-live
 * gate on posts not yet seen live (setting `canonical_live_at` and `t0`), and, when a post's MDX or
 * notes changed, flags its drafts `source_changed` and invalidates their approvals (Review Focus #1).
 *
 * Change detection compares the hashes `buildContentItem` computes over NORMALISED text, so a CRLF or
 * BOM-only rewrite is not a change. Only local files and the post's own public URL are read: no
 * platform API call is made.
 */
export async function syncContent(deps: SyncDeps): Promise<SyncResult> {
  const { reader, repos, fetchFn, now, onInvalidated } = deps;
  const timeZone = deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const baseUrl = deps.baseUrl ?? DEFAULT_BASE_URL;

  const result: SyncResult = { upserted: 0, changed: [], invalidatedApprovals: 0, errors: [] };
  const remoteHeld: string[] = [];

  /** A known post whose source can no longer be trusted: stop everything that was prepared from it. */
  const invalidateUnreadable = (slug: string, reason: 'unparseable' | 'removed', message?: string): void => {
    const held: string[] = [];
    let invalidated = 0;
    let flagged = 0;
    repos.transaction(() => {
      ({ invalidated, flagged } = flagDrafts(repos, slug, { reason, ...(message === undefined ? {} : { message }) }, held));
    });
    remoteHeld.push(...held);
    result.invalidatedApprovals += invalidated;
    if (flagged > 0 && !result.changed.includes(slug)) result.changed.push(slug);
  };

  const repoCommit = await reader.gitHead();
  const listed = await reader.listPosts();
  for (const slug of listed) {
    const known = repos.content.get(slug) !== undefined;
    let item: ContentItem;
    let dirtyPaths: string[];
    try {
      const mdxRaw = await reader.readPost(slug);
      const notesRaw = await reader.readNotes(slug);
      item = buildContentItem({
        slug,
        mdxRaw,
        ...(notesRaw === null ? {} : { notesRaw }),
        repoCommit,
        dirty: false,
        baseUrl,
      });
      // A date the T0 rule cannot read makes the post unusable (the zone is checked separately below).
      computeT0(item.frontmatter.date, null, 'UTC');
      dirtyPaths = [`content/posts/${slug}.mdx`, ...(notesRaw === null ? [] : [`content/publishing-notes/${slug}.md`])];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ slug, message });
      // Review Focus #1: a source that changed into something unparseable must still stop its drafts.
      if (known) invalidateUnreadable(slug, 'unparseable', message);
      continue;
    }

    try {
      let dirty = false;
      for (const path of dirtyPaths) dirty = (await reader.isDirty(path)) || dirty;
      item = { ...item, source: { ...item.source, dirty } };

      const existing = repos.content.get(slug);

      // The gate runs until a post has passed it once; after that canonical_live_at never moves.
      let canonicalLiveAt = existing?.canonicalLiveAt;
      if (canonicalLiveAt === undefined && (await checkCanonicalLive(item, fetchFn)).ok) {
        canonicalLiveAt = now().toISOString();
      }
      const t0 = canonicalLiveAt === undefined ? null : computeT0(item.frontmatter.date, canonicalLiveAt, timeZone);

      const mdxChanged = existing !== undefined && existing.mdxSha256 !== item.source.mdxSha256;
      const notesChanged = existing !== undefined && existing.notesSha256 !== item.source.notesSha256;

      const held: string[] = [];
      let invalidated = 0;
      repos.transaction(() => {
        repos.content.upsert({
          slug,
          canonicalUrl: item.canonicalUrl,
          title: item.frontmatter.title,
          date: item.frontmatter.date,
          mdxSha256: item.source.mdxSha256,
          ...(item.source.notesSha256 === undefined ? {} : { notesSha256: item.source.notesSha256 }),
          repoCommit,
          dirty,
          published: item.frontmatter.published,
          ...(canonicalLiveAt === undefined ? {} : { canonicalLiveAt }),
          ...(t0 === null ? {} : { t0 }),
        });
        if (mdxChanged || notesChanged) {
          ({ invalidated } = flagDrafts(repos, slug, { mdxChanged, notesChanged }, held));
        }
      });
      remoteHeld.push(...held);
      result.invalidatedApprovals += invalidated;
      result.upserted += 1;
      if (mdxChanged || notesChanged) result.changed.push(slug);
    } catch (err) {
      result.errors.push({ slug, message: err instanceof Error ? err.message : String(err) });
    }
  }

  // A known post that is no longer listed was removed from the site: nothing prepared from it may go out.
  const present = new Set(listed);
  for (const row of repos.content.list()) {
    if (!present.has(row.slug)) invalidateUnreadable(row.slug, 'removed');
  }

  if (remoteHeld.length > 0 && onInvalidated !== undefined) {
    try {
      await onInvalidated(remoteHeld);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const draftId of remoteHeld) {
        repos.audit.append({ actorChannel: ACTOR, action: 'remote_cancel_failed', draftId, detail: { message } });
      }
      throw err;
    }
  }
  return result;
}

/** Flags the slug's live drafts and invalidates their approvals. Runs inside the caller's transaction. */
function flagDrafts(
  repos: Repos,
  slug: string,
  what: Record<string, unknown>,
  remoteHeld: string[],
): { invalidated: number; flagged: number } {
  let invalidated = 0;
  let flagged = 0;
  for (const draft of repos.drafts.list({ slug })) {
    if (!FLAGGED_ON_CHANGE.has(draft.status)) continue;
    repos.drafts.update(draft.id, { status: 'source_changed' });
    flagged += 1;
    const approvalIds: string[] = [];
    for (const approval of repos.approvals.listByDraft(draft.id)) {
      if (approval.status !== 'pending' && approval.status !== 'approved') continue;
      repos.approvals.setStatus(approval.id, 'invalidated');
      approvalIds.push(approval.id);
    }
    invalidated += approvalIds.length;
    repos.audit.append({
      actorChannel: ACTOR,
      action: 'source_changed',
      draftId: draft.id,
      hash: draft.payloadSha256,
      platform: draft.platform,
      detail: { slug, from: draft.status, ...what, invalidatedApprovals: approvalIds },
    });
    if (draft.remoteScheduledId !== undefined) remoteHeld.push(draft.id);
  }
  return { invalidated, flagged };
}
