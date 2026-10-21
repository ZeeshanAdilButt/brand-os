import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { ProviderKind, TaskKind, TaskStatus } from '../../lib/ai';
import type { TaskResult } from '../../lib/ai-ops';
import { aiProviders, aiTasks, articles, type AiTask } from '../db/schema';
import { NotFoundError, type Scope } from './scope';

export interface TaskInsert {
  kind: TaskKind;
  articleId: string;
  selStart: number | null;
  selEnd: number | null;
  excerpt: string;
  instruction: string;
  providerId: string | null;
  providerKind: ProviderKind | null;
  providerName: string | null;
  model: string | null;
  articleRevision: number;
  promptText: string;
  promptSha256: string;
  requestHash: string | null;
  approvedItemIds: string[];
  contextNotes: AiTask['contextNotes'];
  withheldCount: number;
}

/** Fields a transition may set. Everything else on a task is fixed when it is made. */
export interface TaskOutcome {
  status?: TaskStatus;
  result?: TaskResult | null;
  error?: string | null;
  model?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  tokensEstimated?: boolean;
  fromCache?: boolean;
  attempts?: number;
  finished?: boolean;
  /** Reopen a finished task (a retry). */
  clearFinished?: boolean;
}

export interface TaskFilter {
  articleId?: string | undefined;
  statuses?: readonly TaskStatus[] | undefined;
  limit?: number | undefined;
}

/** Start of the calendar month (UTC) that contains `at`. Usage caps count from here. */
export function monthStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

/** Tenant-scoped access to one owner's AI tasks. Every query carries the owner id, and so does every transition. */
export function scopedTasks(scope: Scope) {
  const owned = (id: string) => and(eq(aiTasks.ownerId, scope.ownerId), eq(aiTasks.id, id));

  function setFor(outcome: TaskOutcome) {
    return {
      ...(outcome.status !== undefined ? { status: outcome.status } : {}),
      ...(outcome.result !== undefined ? { result: outcome.result } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      ...(outcome.model !== undefined ? { model: outcome.model } : {}),
      ...(outcome.tokensIn !== undefined ? { tokensIn: outcome.tokensIn } : {}),
      ...(outcome.tokensOut !== undefined ? { tokensOut: outcome.tokensOut } : {}),
      ...(outcome.tokensEstimated !== undefined ? { tokensEstimated: outcome.tokensEstimated } : {}),
      ...(outcome.fromCache !== undefined ? { fromCache: outcome.fromCache } : {}),
      ...(outcome.attempts !== undefined ? { attempts: outcome.attempts } : {}),
      ...(outcome.finished ? { finishedAt: new Date() } : {}),
      ...(outcome.clearFinished ? { finishedAt: null } : {}),
      updatedAt: new Date(),
    };
  }

  return {
    async create(input: TaskInsert): Promise<AiTask> {
      const db = await scope.db();
      // The article must be this owner's: a task can never point at someone else's article.
      const [own] = await db.select({ id: articles.id }).from(articles).where(and(eq(articles.ownerId, scope.ownerId), eq(articles.id, input.articleId)));
      if (!own) throw new NotFoundError('article');
      if (input.providerId) {
        const [provider] = await db
          .select({ id: aiProviders.id })
          .from(aiProviders)
          .where(and(eq(aiProviders.ownerId, scope.ownerId), eq(aiProviders.id, input.providerId)));
        if (!provider) throw new NotFoundError('provider');
      }
      const [row] = await db
        .insert(aiTasks)
        .values({ ...input, ownerId: scope.ownerId })
        .returning();
      if (!row) throw new Error('task insert returned no row');
      return row;
    },

    async get(id: string): Promise<AiTask | null> {
      const db = await scope.db();
      const [row] = await db.select().from(aiTasks).where(owned(id));
      return row ?? null;
    },

    /** Newest first. */
    async list(filter: TaskFilter = {}): Promise<AiTask[]> {
      const db = await scope.db();
      const conditions = [eq(aiTasks.ownerId, scope.ownerId)];
      if (filter.articleId) conditions.push(eq(aiTasks.articleId, filter.articleId));
      if (filter.statuses && filter.statuses.length > 0) conditions.push(inArray(aiTasks.status, [...filter.statuses]));
      return db
        .select()
        .from(aiTasks)
        .where(and(...conditions))
        .orderBy(desc(aiTasks.createdAt))
        .limit(Math.min(Math.max(filter.limit ?? 50, 1), 200));
    },

    /**
     * Move a task from one of `from` to a new state, atomically. Returns the updated row, or null when the
     * task is not this owner's or is no longer in one of those states (someone else got there first).
     */
    async transition(id: string, from: readonly TaskStatus[], outcome: TaskOutcome): Promise<AiTask | null> {
      const db = await scope.db();
      const [row] = await db
        .update(aiTasks)
        .set(setFor(outcome))
        .where(and(owned(id), inArray(aiTasks.status, [...from])))
        .returning();
      return row ?? null;
    },

    /** Count one more attempt on a running task. */
    async bumpAttempts(id: string): Promise<void> {
      const db = await scope.db();
      await db
        .update(aiTasks)
        .set({ attempts: sql`${aiTasks.attempts} + 1`, updatedAt: new Date() })
        .where(and(owned(id), eq(aiTasks.status, 'running')));
    },

    /** An earlier successful answer to an identical request, so a repeat costs nothing. */
    async findCached(requestHash: string): Promise<AiTask | null> {
      const db = await scope.db();
      const [row] = await db
        .select()
        .from(aiTasks)
        .where(and(eq(aiTasks.ownerId, scope.ownerId), eq(aiTasks.requestHash, requestHash), inArray(aiTasks.status, ['needs_review', 'accepted']), eq(aiTasks.fromCache, false)))
        .orderBy(desc(aiTasks.createdAt))
        .limit(1);
      return row?.result ? row : null;
    },

    /** Estimated tokens spent per provider since `since`. Cache hits and tasks that never ran count zero. */
    async usageSince(since: Date): Promise<Map<string, number>> {
      const db = await scope.db();
      const rows = await db
        .select({
          providerId: aiTasks.providerId,
          used: sql<number>`coalesce(sum(coalesce(${aiTasks.tokensIn}, 0) + coalesce(${aiTasks.tokensOut}, 0)), 0)`,
        })
        .from(aiTasks)
        .where(and(eq(aiTasks.ownerId, scope.ownerId), gte(aiTasks.createdAt, since), eq(aiTasks.fromCache, false)))
        .groupBy(aiTasks.providerId);
      const map = new Map<string, number>();
      for (const row of rows) if (row.providerId) map.set(row.providerId, Number(row.used));
      return map;
    },

    /**
     * Tasks the server started and then lost (a restart): still "running", or still "pending" on a provider that
     * runs tasks itself, long after they should have finished. They become failed, with a message that says so.
     */
    async failAbandoned(before: Date, abandonedMessage: string, activeIds: readonly string[]): Promise<AiTask[]> {
      const db = await scope.db();
      const candidates = await db
        .select({ id: aiTasks.id })
        .from(aiTasks)
        .where(
          and(
            eq(aiTasks.ownerId, scope.ownerId),
            lt(aiTasks.updatedAt, before),
            sql`(${aiTasks.status} = 'running' or (${aiTasks.status} = 'pending' and ${aiTasks.providerKind} in ('local', 'api_key')))`,
          ),
        );
      const stale = candidates.map((c) => c.id).filter((id) => !activeIds.includes(id));
      if (stale.length === 0) return [];
      return db
        .update(aiTasks)
        .set({ status: 'failed', error: abandonedMessage, finishedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(aiTasks.ownerId, scope.ownerId), inArray(aiTasks.id, stale), inArray(aiTasks.status, ['running', 'pending'])))
        .returning();
    },
  };
}
