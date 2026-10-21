import { and, asc, desc, eq, gt, inArray, lt, ne, sql } from 'drizzle-orm';
import {
  ALREADY_OUT_STATUSES,
  LIVE_STATUSES,
  PUBLISHING_STALE_MS,
  STAGEABLE_STATUSES,
  type AttemptKind,
  type AttemptStatus,
  type ConnectionStatus,
  type DraftPayload,
  type DraftStatus,
  type ErrorKind,
  type LintIssue,
  type PlatformId,
  type TagReport,
} from '../../lib/publishing';
import {
  approvals,
  articles,
  platformConnections,
  platformDrafts,
  publishAttempts,
  type Approval,
  type PlatformConnection,
  type PlatformDraft,
  type PublishAttempt,
} from '../db/schema';
import { sourceHashOf } from '../publishing/source';
import { isUniqueViolation, NotFoundError, type Scope } from './scope';

/** A connection as listings and the UI see it: everything but the encrypted key. */
export type PublicConnection = Omit<PlatformConnection, 'encryptedKey'>;

function connectionColumns() {
  return {
    id: platformConnections.id,
    ownerId: platformConnections.ownerId,
    platform: platformConnections.platform,
    encryptedKey: platformConnections.encryptedKey,
    keyLast4: platformConnections.keyLast4,
    status: platformConnections.status,
    who: platformConnections.who,
    config: platformConnections.config,
    lastCheckedAt: platformConnections.lastCheckedAt,
    lastCheckMessage: platformConnections.lastCheckMessage,
    createdAt: platformConnections.createdAt,
    updatedAt: platformConnections.updatedAt,
  };
}
const { encryptedKey: _encrypted, ...publicConnectionColumns } = connectionColumns();
void _encrypted;

export interface ConnectionSave {
  id: string;
  platform: PlatformId;
  encryptedKey: string;
  keyLast4: string;
  status: ConnectionStatus;
  who: string | null;
  config: PlatformConnection['config'];
  message: string | null;
}

/** Tenant-scoped access to one owner's platform connections. Only `getWithKey` returns the encrypted key. */
export function scopedConnections(scope: Scope) {
  const owned = (id: string) => and(eq(platformConnections.ownerId, scope.ownerId), eq(platformConnections.id, id));
  return {
    async list(): Promise<PublicConnection[]> {
      const db = await scope.db();
      return db.select(publicConnectionColumns).from(platformConnections).where(eq(platformConnections.ownerId, scope.ownerId)).orderBy(asc(platformConnections.createdAt));
    },
    async get(id: string): Promise<PublicConnection | null> {
      const db = await scope.db();
      const [row] = await db.select(publicConnectionColumns).from(platformConnections).where(owned(id));
      return row ?? null;
    },
    async getByPlatform(platform: PlatformId): Promise<PublicConnection | null> {
      const db = await scope.db();
      const [row] = await db
        .select(publicConnectionColumns)
        .from(platformConnections)
        .where(and(eq(platformConnections.ownerId, scope.ownerId), eq(platformConnections.platform, platform)));
      return row ?? null;
    },
    /** The connection including its encrypted key, for the code that is about to call the platform. */
    async getWithKey(id: string): Promise<PlatformConnection | null> {
      const db = await scope.db();
      const [row] = await db.select(connectionColumns()).from(platformConnections).where(owned(id));
      return row ?? null;
    },
    /** One connection per platform: saving again replaces the key and the probe results of the existing row. */
    async save(input: ConnectionSave): Promise<PublicConnection> {
      const db = await scope.db();
      const now = new Date();
      const [row] = await db
        .insert(platformConnections)
        .values({
          id: input.id,
          platform: input.platform,
          encryptedKey: input.encryptedKey,
          keyLast4: input.keyLast4,
          status: input.status,
          who: input.who,
          config: input.config,
          lastCheckedAt: now,
          lastCheckMessage: input.message,
          ownerId: scope.ownerId,
        })
        .onConflictDoUpdate({
          target: [platformConnections.ownerId, platformConnections.platform],
          set: {
            encryptedKey: input.encryptedKey,
            keyLast4: input.keyLast4,
            status: input.status,
            who: input.who,
            config: input.config,
            lastCheckedAt: now,
            lastCheckMessage: input.message,
            updatedAt: now,
          },
        })
        .returning(publicConnectionColumns);
      if (!row) throw new Error('connection save returned no row');
      return row;
    },
    async recordCheck(id: string, check: { status: ConnectionStatus; who?: string | null; config?: PlatformConnection['config']; message: string | null }): Promise<PublicConnection> {
      const db = await scope.db();
      const now = new Date();
      const [row] = await db
        .update(platformConnections)
        .set({
          status: check.status,
          ...(check.who === undefined ? {} : { who: check.who }),
          ...(check.config === undefined ? {} : { config: check.config }),
          lastCheckedAt: now,
          lastCheckMessage: check.message ? check.message.slice(0, 500) : null,
          updatedAt: now,
        })
        .where(owned(id))
        .returning(publicConnectionColumns);
      if (!row) throw new NotFoundError('connection');
      return row;
    },
    async remove(id: string): Promise<boolean> {
      const db = await scope.db();
      const gone = await db.delete(platformConnections).where(owned(id)).returning({ id: platformConnections.id });
      return gone.length > 0;
    },
  };
}

/** Why a publish was refused. The transaction rolls back, so nothing changed. */
export type PublishRefusalCode =
  | 'NOT_FOUND'
  | 'STATUS'
  | 'ALREADY_OUT'
  | 'NOT_STAGED'
  | 'SOURCE_CHANGED'
  | 'HASH_MISMATCH'
  | 'UNHEALTHY'
  | 'DUPLICATE'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_USED'
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_DENIED'
  | 'APPROVAL_INVALID';

export class PublishRefusal extends Error {
  constructor(
    readonly code: PublishRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'PublishRefusal';
  }
}

export interface DraftInsert {
  articleId: string;
  platform: PlatformId;
  connectionId: string | null;
  account: string | null;
  payload: DraftPayload;
  payloadSha256: string;
  tagReport: TagReport;
  lint: LintIssue[];
  sourceRevision: number;
  sourceHash: string;
}

export interface FailureInfo {
  kind: ErrorKind;
  message: string;
  nextAction: string | null;
}

export interface Authorized {
  draft: PlatformDraft;
  approval: Approval;
  attempt: PublishAttempt;
  connection: PlatformConnection;
}

/** The statuses from which the draft can be rebuilt from its article. */
const REBUILDABLE: readonly DraftStatus[] = ['draft', 'staged', 'pending_approval', 'approved', 'failed', 'source_changed'];

/** Tenant-scoped access to platform drafts, their approvals and their attempts. */
export function scopedPlatformDrafts(scope: Scope) {
  const owned = (id: string) => and(eq(platformDrafts.ownerId, scope.ownerId), eq(platformDrafts.id, id));
  const ownedApproval = (id: string) => and(eq(approvals.ownerId, scope.ownerId), eq(approvals.id, id));

  return {
    async get(id: string): Promise<PlatformDraft | null> {
      const db = await scope.db();
      const [row] = await db.select().from(platformDrafts).where(owned(id));
      return row ?? null;
    },

    async list(filter: { articleId?: string; statuses?: DraftStatus[]; limit?: number } = {}): Promise<PlatformDraft[]> {
      const db = await scope.db();
      const conditions = [eq(platformDrafts.ownerId, scope.ownerId)];
      if (filter.articleId) conditions.push(eq(platformDrafts.articleId, filter.articleId));
      if (filter.statuses?.length) conditions.push(inArray(platformDrafts.status, filter.statuses));
      return db
        .select()
        .from(platformDrafts)
        .where(and(...conditions))
        .orderBy(desc(platformDrafts.updatedAt))
        .limit(Math.min(Math.max(filter.limit ?? 50, 1), 200));
    },

    /** The newest draft for this article and platform, or null. */
    async current(articleId: string, platform: PlatformId): Promise<PlatformDraft | null> {
      const db = await scope.db();
      const [row] = await db
        .select()
        .from(platformDrafts)
        .where(and(eq(platformDrafts.ownerId, scope.ownerId), eq(platformDrafts.articleId, articleId), eq(platformDrafts.platform, platform)))
        .orderBy(desc(platformDrafts.createdAt))
        .limit(1);
      return row ?? null;
    },

    async create(input: DraftInsert): Promise<PlatformDraft> {
      const db = await scope.db();
      const [article] = await db.select({ id: articles.id }).from(articles).where(and(eq(articles.ownerId, scope.ownerId), eq(articles.id, input.articleId)));
      if (!article) throw new NotFoundError('article');
      const [row] = await db.insert(platformDrafts).values({ ...input, ownerId: scope.ownerId }).returning();
      if (!row) throw new Error('draft insert returned no row');
      return row;
    },

    /**
     * Rebuild a draft from its article: new payload, new hash, every open approval void. The private
     * copy on the platform (remote id) is kept so staging updates it rather than making another.
     * Refused (null) for a draft that is in flight or out.
     */
    async rebuild(id: string, input: Omit<DraftInsert, 'articleId' | 'platform'>): Promise<PlatformDraft | null> {
      const db = await scope.db();
      return db.transaction(async (tx) => {
        const [row] = await tx
          .update(platformDrafts)
          .set({
            connectionId: input.connectionId,
            account: input.account,
            status: 'draft',
            payload: input.payload,
            payloadSha256: input.payloadSha256,
            tagReport: input.tagReport,
            lint: input.lint,
            sourceRevision: input.sourceRevision,
            sourceHash: input.sourceHash,
            stale: false,
            failureKind: null,
            failureMessage: null,
            nextAction: null,
            updatedAt: new Date(),
          })
          .where(and(owned(id), inArray(platformDrafts.status, [...REBUILDABLE])))
          .returning();
        if (!row) return null;
        await tx
          .update(approvals)
          .set({ status: 'invalidated', invalidReason: 'The draft was rebuilt, so this approval no longer applies.' })
          .where(and(eq(approvals.ownerId, scope.ownerId), eq(approvals.draftId, id), eq(approvals.status, 'pending')));
        return row;
      });
    },

    /**
     * Record that a private copy exists. Only a draft that is still draft, staged or failed, and still
     * has the hash that was staged, is touched: a late answer never moves a draft that has since been
     * approved, published, changed or is in flight. Returns null when it was ignored.
     */
    async markStaged(id: string, expectedHash: string, remote: { remoteId: string; previewUrl: string | null }): Promise<PlatformDraft | null> {
      const db = await scope.db();
      const [row] = await db
        .update(platformDrafts)
        .set({
          status: 'staged',
          remoteId: remote.remoteId,
          remotePreviewUrl: remote.previewUrl,
          stagedAt: new Date(),
          failureKind: null,
          failureMessage: null,
          nextAction: null,
          updatedAt: new Date(),
        })
        .where(and(owned(id), inArray(platformDrafts.status, [...STAGEABLE_STATUSES]), eq(platformDrafts.payloadSha256, expectedHash)))
        .returning();
      return row ?? null;
    },

    /** A stage failure. Same positive list as markStaged: it can never flip an approved, publishing or published draft. */
    async markStageFailed(id: string, expectedHash: string, failure: FailureInfo): Promise<PlatformDraft | null> {
      const db = await scope.db();
      const [row] = await db
        .update(platformDrafts)
        .set({ status: 'failed', failureKind: failure.kind, failureMessage: failure.message, nextAction: failure.nextAction, updatedAt: new Date() })
        .where(and(owned(id), inArray(platformDrafts.status, [...STAGEABLE_STATUSES]), eq(platformDrafts.payloadSha256, expectedHash)))
        .returning();
      return row ?? null;
    },

    /** Flag drafts of an article whose source no longer matches, and void their open approvals. Returns the drafts it changed. */
    async syncSource(articleId: string): Promise<PlatformDraft[]> {
      const db = await scope.db();
      return db.transaction(async (tx) => {
        const [article] = await tx.select().from(articles).where(and(eq(articles.ownerId, scope.ownerId), eq(articles.id, articleId)));
        const open = await tx
          .select()
          .from(platformDrafts)
          .where(and(eq(platformDrafts.ownerId, scope.ownerId), eq(platformDrafts.articleId, articleId), inArray(platformDrafts.status, [...LIVE_STATUSES])));
        const current = article ? sourceHashOf(article) : null;
        const changed: PlatformDraft[] = [];
        for (const draft of open) {
          if (current !== null && draft.sourceHash === current) continue;
          const [row] = await tx
            .update(platformDrafts)
            .set({ status: 'source_changed', stale: true, updatedAt: new Date() })
            .where(and(owned(draft.id), inArray(platformDrafts.status, [...LIVE_STATUSES])))
            .returning();
          if (!row) continue;
          await tx
            .update(approvals)
            .set({ status: 'invalidated', invalidReason: 'The article changed after this approval was requested.' })
            .where(and(eq(approvals.ownerId, scope.ownerId), eq(approvals.draftId, draft.id), eq(approvals.status, 'pending')));
          changed.push(row);
        }
        return changed;
      });
    },

    /** A publish request that has been "publishing" too long becomes unknown, never failed: the request may have gone out. */
    async sweepStalePublishing(now: Date): Promise<PlatformDraft[]> {
      const db = await scope.db();
      const cutoff = new Date(now.getTime() - PUBLISHING_STALE_MS);
      return db.transaction(async (tx) => {
        const rows = await tx
          .update(platformDrafts)
          .set({
            status: 'unknown',
            failureKind: 'timeout',
            failureMessage: 'The app stopped before the platform answered, so the result is not known.',
            nextAction: 'Use “Check on platform” to see whether it went live.',
            updatedAt: now,
          })
          .where(and(eq(platformDrafts.ownerId, scope.ownerId), eq(platformDrafts.status, 'publishing'), lt(platformDrafts.updatedAt, cutoff)))
          .returning();
        for (const row of rows) {
          await tx
            .update(publishAttempts)
            .set({ status: 'unknown', message: 'The app stopped before the platform answered.', finishedAt: now })
            .where(and(eq(publishAttempts.ownerId, scope.ownerId), eq(publishAttempts.draftId, row.id), eq(publishAttempts.kind, 'publish'), eq(publishAttempts.status, 'started')));
        }
        return rows;
      });
    },

    // ---- approvals ---------------------------------------------------------------------------

    async getApproval(id: string): Promise<Approval | null> {
      const db = await scope.db();
      const [row] = await db.select().from(approvals).where(ownedApproval(id));
      return row ?? null;
    },

    /** The newest approval of a draft. */
    async latestApproval(draftId: string): Promise<Approval | null> {
      const db = await scope.db();
      const [row] = await db
        .select()
        .from(approvals)
        .where(and(eq(approvals.ownerId, scope.ownerId), eq(approvals.draftId, draftId)))
        .orderBy(desc(approvals.createdAt))
        .limit(1);
      return row ?? null;
    },

    /** Expire pending approvals past their time. Returns how many. */
    async expireApprovals(now: Date): Promise<number> {
      const db = await scope.db();
      const rows = await db
        .update(approvals)
        .set({ status: 'expired' })
        .where(and(eq(approvals.ownerId, scope.ownerId), eq(approvals.status, 'pending'), lt(approvals.expiresAt, now)))
        .returning({ id: approvals.id });
      return rows.length;
    },

    /**
     * Open an approval request for a staged draft. Any earlier pending request for the draft is voided so
     * only one can ever be spent. Returns null when the draft is not in a state that can be approved.
     */
    async openApproval(draftId: string, input: { tag: string; expiresAt: Date; requestedBy: 'owner' | 'agent'; expectedHash: string }): Promise<Approval | null> {
      const db = await scope.db();
      return db.transaction(async (tx) => {
        const [moved] = await tx
          .update(platformDrafts)
          .set({ status: 'pending_approval', updatedAt: new Date() })
          .where(and(owned(draftId), inArray(platformDrafts.status, ['staged', 'pending_approval']), eq(platformDrafts.payloadSha256, input.expectedHash), eq(platformDrafts.stale, false)))
          .returning({ id: platformDrafts.id });
        if (!moved) return null;
        await tx
          .update(approvals)
          .set({ status: 'invalidated', invalidReason: 'A newer approval was requested.' })
          .where(and(eq(approvals.ownerId, scope.ownerId), eq(approvals.draftId, draftId), eq(approvals.status, 'pending')));
        const [row] = await tx
          .insert(approvals)
          .values({ ownerId: scope.ownerId, draftId, payloadSha256: input.expectedHash, tag: input.tag, expiresAt: input.expiresAt, requestedBy: input.requestedBy })
          .returning();
        if (!row) throw new Error('approval insert returned no row');
        return row;
      });
    },

    /** Say no. Only a pending approval can be denied; the draft goes back to staged. */
    async deny(approvalId: string): Promise<Approval | null> {
      const db = await scope.db();
      return db.transaction(async (tx) => {
        const [row] = await tx
          .update(approvals)
          .set({ status: 'denied', invalidReason: 'You declined this request.' })
          .where(and(ownedApproval(approvalId), eq(approvals.status, 'pending')))
          .returning();
        if (!row) return null;
        await tx
          .update(platformDrafts)
          .set({ status: 'staged', updatedAt: new Date() })
          .where(and(owned(row.draftId), eq(platformDrafts.status, 'pending_approval')));
        return row;
      });
    },

    /**
     * THE authorization. In one transaction: the draft is pending approval, staged remotely, unchanged
     * since the approval was requested and not stale; the article still hashes to what the draft was
     * built from; the connection is healthy; the approval is pending, unexpired and for exactly this
     * payload hash. Then the approval is consumed and the draft becomes `publishing` together, with a
     * `started` attempt row. Any failed check rolls everything back. The partial unique index on
     * (owner, platform, payload hash) makes a second draft with the same payload unable to enter
     * `publishing`, `unknown` or `published`.
     */
    async authorizePublish(input: { draftId: string; approvalId: string; checked: string[]; now: Date }): Promise<Authorized> {
      const db = await scope.db();
      return db.transaction(async (tx) => {
        const [draft] = await tx.select().from(platformDrafts).where(owned(input.draftId));
        if (!draft) throw new PublishRefusal('NOT_FOUND', 'This draft does not exist.');
        if ((ALREADY_OUT_STATUSES as readonly string[]).includes(draft.status)) {
          throw new PublishRefusal('ALREADY_OUT', draft.status === 'published' ? 'This payload is already published.' : 'This payload is already being published or its result is not known. It will not be sent again.');
        }
        if (draft.status === 'source_changed' || draft.stale) throw new PublishRefusal('SOURCE_CHANGED', 'The article changed after this draft was built. Rebuild the draft and ask again.');
        if (draft.status !== 'pending_approval') throw new PublishRefusal('STATUS', 'This draft is not waiting for approval.');
        if (!draft.remoteId) throw new PublishRefusal('NOT_STAGED', 'Stage the private draft first, so you can look at it before it goes public.');

        const [article] = await tx.select().from(articles).where(and(eq(articles.ownerId, scope.ownerId), eq(articles.id, draft.articleId)));
        if (!article || sourceHashOf(article) !== draft.sourceHash) {
          throw new PublishRefusal('SOURCE_CHANGED', 'The article changed after this draft was built. Rebuild the draft and ask again.');
        }

        const [connection] = draft.connectionId
          ? await tx.select(connectionColumns()).from(platformConnections).where(and(eq(platformConnections.ownerId, scope.ownerId), eq(platformConnections.id, draft.connectionId)))
          : [];
        if (!connection || connection.status !== 'connected') throw new PublishRefusal('UNHEALTHY', 'The connection is not healthy. Reconnect it in Settings, then ask again.');

        const [approval] = await tx
          .update(approvals)
          .set({ status: 'used', approvedAt: input.now, usedAt: input.now, checked: input.checked })
          .where(
            and(
              ownedApproval(input.approvalId),
              eq(approvals.draftId, draft.id),
              eq(approvals.status, 'pending'),
              gt(approvals.expiresAt, input.now),
              eq(approvals.payloadSha256, draft.payloadSha256),
            ),
          )
          .returning();
        if (!approval) {
          const [seen] = await tx.select().from(approvals).where(ownedApproval(input.approvalId));
          if (!seen || seen.draftId !== draft.id) throw new PublishRefusal('APPROVAL_NOT_FOUND', 'This approval does not exist.');
          if (seen.status === 'used') throw new PublishRefusal('APPROVAL_USED', 'This approval was already used. Each approval covers one publish.');
          if (seen.status === 'denied') throw new PublishRefusal('APPROVAL_DENIED', 'This approval was declined.');
          if (seen.status === 'invalidated') throw new PublishRefusal('APPROVAL_INVALID', seen.invalidReason ?? 'This approval no longer applies.');
          if (seen.status === 'expired' || seen.expiresAt.getTime() <= input.now.getTime()) throw new PublishRefusal('APPROVAL_EXPIRED', 'This approval expired. Ask for a new one.');
          throw new PublishRefusal('HASH_MISMATCH', 'The draft is not what was approved. Ask for a new approval.');
        }

        let moved: PlatformDraft | undefined;
        try {
          [moved] = await tx
            .update(platformDrafts)
            .set({ status: 'publishing', failureKind: null, failureMessage: null, nextAction: null, updatedAt: input.now })
            .where(and(owned(draft.id), eq(platformDrafts.status, 'pending_approval'), eq(platformDrafts.payloadSha256, approval.payloadSha256), eq(platformDrafts.stale, false)))
            .returning();
        } catch (err) {
          if (isUniqueViolation(err)) throw new PublishRefusal('DUPLICATE', 'Another draft with this exact payload is already published or being published on this platform.');
          throw err;
        }
        if (!moved) throw new PublishRefusal('HASH_MISMATCH', 'The draft changed while it was being authorized. Nothing was sent.');

        const [attempt] = await tx
          .insert(publishAttempts)
          .values({ ownerId: scope.ownerId, draftId: draft.id, kind: 'publish', status: 'started', payloadSha256: moved.payloadSha256, approvalId: approval.id, startedAt: input.now })
          .returning();
        if (!attempt) throw new Error('attempt insert returned no row');
        return { draft: moved, approval, attempt, connection };
      });
    },

    /** Settle an in-flight publish. Only a draft still `publishing` is changed, so a manual resolution is never overwritten. */
    async settlePublish(
      draftId: string,
      attemptId: string,
      outcome:
        | { status: 'published'; remoteId: string | null; remoteUrl: string | null; httpStatus: number | null; now: Date }
        | { status: 'failed' | 'unknown'; failure: FailureInfo; httpStatus: number | null; now: Date },
    ): Promise<PlatformDraft | null> {
      const db = await scope.db();
      return db.transaction(async (tx) => {
        const attemptPatch =
          outcome.status === 'published'
            ? { status: 'succeeded' as const, httpStatus: outcome.httpStatus, remoteId: outcome.remoteId, remoteUrl: outcome.remoteUrl, finishedAt: outcome.now }
            : { status: outcome.status as AttemptStatus, httpStatus: outcome.httpStatus, errorKind: outcome.failure.kind, message: outcome.failure.message, finishedAt: outcome.now };
        await tx.update(publishAttempts).set(attemptPatch).where(and(eq(publishAttempts.ownerId, scope.ownerId), eq(publishAttempts.id, attemptId)));
        const draftPatch =
          outcome.status === 'published'
            ? { status: 'published' as const, remoteId: outcome.remoteId ?? undefined, remoteUrl: outcome.remoteUrl, publishedAt: outcome.now, failureKind: null, failureMessage: null, nextAction: null, updatedAt: outcome.now }
            : { status: outcome.status, failureKind: outcome.failure.kind, failureMessage: outcome.failure.message, nextAction: outcome.failure.nextAction, updatedAt: outcome.now };
        const [row] = await tx
          .update(platformDrafts)
          .set(draftPatch)
          .where(and(owned(draftId), eq(platformDrafts.status, 'publishing')))
          .returning();
        if (row && outcome.status === 'published') {
          await tx.update(articles).set({ publishedAt: outcome.now }).where(and(eq(articles.ownerId, scope.ownerId), eq(articles.id, row.articleId), sql`${articles.publishedAt} is null`));
        }
        return row ?? null;
      });
    },

    /**
     * Resolve an `unknown` draft after a check or by the owner's word. `published` records the remote link;
     * `not_published` returns it to staged. Only an unknown draft changes, so nothing else is overwritten.
     */
    async resolveUnknown(
      draftId: string,
      resolution: { outcome: 'published'; remoteId: string | null; remoteUrl: string | null } | { outcome: 'not_published' },
      attempt: { kind: AttemptKind; message: string; now: Date },
    ): Promise<PlatformDraft | null> {
      const db = await scope.db();
      return db.transaction(async (tx) => {
        const patch =
          resolution.outcome === 'published'
            ? { status: 'published' as const, ...(resolution.remoteId ? { remoteId: resolution.remoteId } : {}), remoteUrl: resolution.remoteUrl, publishedAt: attempt.now, failureKind: null, failureMessage: null, nextAction: null, updatedAt: attempt.now }
            : { status: 'staged' as const, failureKind: null, failureMessage: null, nextAction: null, updatedAt: attempt.now };
        const [row] = await tx
          .update(platformDrafts)
          .set(patch)
          .where(and(owned(draftId), eq(platformDrafts.status, 'unknown')))
          .returning();
        if (!row) return null;
        await tx.insert(publishAttempts).values({
          ownerId: scope.ownerId,
          draftId,
          kind: attempt.kind,
          status: 'succeeded',
          payloadSha256: row.payloadSha256,
          message: attempt.message,
          remoteId: row.remoteId,
          remoteUrl: row.remoteUrl,
          startedAt: attempt.now,
          finishedAt: attempt.now,
        });
        if (resolution.outcome === 'published') {
          await tx.update(articles).set({ publishedAt: attempt.now }).where(and(eq(articles.ownerId, scope.ownerId), eq(articles.id, row.articleId), sql`${articles.publishedAt} is null`));
        }
        return row;
      });
    },

    // ---- attempts ----------------------------------------------------------------------------

    async startAttempt(draftId: string, kind: AttemptKind, payloadSha256: string): Promise<PublishAttempt> {
      const db = await scope.db();
      const [row] = await db.insert(publishAttempts).values({ ownerId: scope.ownerId, draftId, kind, status: 'started', payloadSha256 }).returning();
      if (!row) throw new Error('attempt insert returned no row');
      return row;
    },

    async finishAttempt(
      id: string,
      result: { status: AttemptStatus; httpStatus?: number | null; errorKind?: ErrorKind | null; message?: string | null; remoteId?: string | null; remoteUrl?: string | null },
    ): Promise<void> {
      const db = await scope.db();
      await db
        .update(publishAttempts)
        .set({
          status: result.status,
          httpStatus: result.httpStatus ?? null,
          errorKind: result.errorKind ?? null,
          message: result.message ? result.message.slice(0, 1000) : null,
          remoteId: result.remoteId ?? null,
          remoteUrl: result.remoteUrl ?? null,
          finishedAt: new Date(),
        })
        .where(and(eq(publishAttempts.ownerId, scope.ownerId), eq(publishAttempts.id, id), ne(publishAttempts.status, 'succeeded')));
    },

    async listAttempts(draftId: string, limit = 20): Promise<PublishAttempt[]> {
      const db = await scope.db();
      return db
        .select()
        .from(publishAttempts)
        .where(and(eq(publishAttempts.ownerId, scope.ownerId), eq(publishAttempts.draftId, draftId)))
        .orderBy(desc(publishAttempts.startedAt))
        .limit(limit);
    },
  };
}
