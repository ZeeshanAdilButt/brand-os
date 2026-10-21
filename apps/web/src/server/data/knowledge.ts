import { and, count, desc, eq, getTableColumns, sql, type SQL } from 'drizzle-orm';
import {
  knowledgeItems,
  knowledgeSources,
  type Confidence,
  type Confidentiality,
  type ItemKind,
  type KnowledgeItem,
  type KnowledgeSource,
  type SourceKind,
  type VerificationStatus,
} from '../db/schema';
import { MARK_END, MARK_START } from '../../lib/knowledge';
import { definedOnly, NotFoundError, type Scope } from './scope';

/** Every item column except the search vector, which is an index, not data to hand around. */
const { search: _searchVector, ...itemColumns } = getTableColumns(knowledgeItems);
void _searchVector;

export interface ItemInput {
  kind: ItemKind;
  title: string;
  body: string;
  tags: string[];
  sourceId: string | null;
  sourceDate: string | null;
  verificationStatus: VerificationStatus;
  confidence: Confidence;
  confidentiality: Confidentiality;
  publicUsePermitted: boolean;
}

export type ItemPatch = Partial<ItemInput>;

export interface ItemFilter {
  kind?: ItemKind | undefined;
  confidentiality?: Confidentiality | undefined;
  verificationStatus?: VerificationStatus | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface SearchHit {
  item: KnowledgeItem;
  rank: number;
  /** Body excerpt. Matches are wrapped in MARK_START and MARK_END; the text is NOT HTML-escaped. */
  snippet: string;
  /** Title with matches wrapped the same way. */
  titleMarked: string;
}

export { MARK_END, MARK_START };

const HEADLINE_OPTIONS = `StartSel=${MARK_START},StopSel=${MARK_END},MaxFragments=2,MaxWords=28,MinWords=10,FragmentDelimiter= ... `;
const TITLE_HEADLINE_OPTIONS = `StartSel=${MARK_START},StopSel=${MARK_END},HighlightAll=true`;
const MAX_PAGE = 200;

export interface SourceInput {
  kind: SourceKind;
  title: string;
  uri: string | null;
  sourceDate: string | null;
}

export function scopedSources(scope: Scope) {
  return {
    async list(): Promise<KnowledgeSource[]> {
      const db = await scope.db();
      return db
        .select()
        .from(knowledgeSources)
        .where(eq(knowledgeSources.ownerId, scope.ownerId))
        .orderBy(desc(knowledgeSources.importedAt));
    },

    async get(id: string): Promise<KnowledgeSource | null> {
      const db = await scope.db();
      const [row] = await db
        .select()
        .from(knowledgeSources)
        .where(and(eq(knowledgeSources.ownerId, scope.ownerId), eq(knowledgeSources.id, id)));
      return row ?? null;
    },

    async create(input: SourceInput): Promise<KnowledgeSource> {
      const db = await scope.db();
      const [row] = await db
        .insert(knowledgeSources)
        .values({ kind: input.kind, title: input.title, uri: input.uri, sourceDate: input.sourceDate, ownerId: scope.ownerId })
        .returning();
      if (!row) throw new Error('source insert returned no row');
      return row;
    },

    /** Items that pointed at the source keep existing; their source link is cleared by the database. */
    async remove(id: string): Promise<boolean> {
      const db = await scope.db();
      const rows = await db
        .delete(knowledgeSources)
        .where(and(eq(knowledgeSources.ownerId, scope.ownerId), eq(knowledgeSources.id, id)))
        .returning({ id: knowledgeSources.id });
      return rows.length > 0;
    },

    /** Insert when no source with this seed key exists. Never modifies an existing one. */
    async insertSeeded(seedKey: string, input: SourceInput): Promise<{ id: string; outcome: 'created' | 'kept' }> {
      const db = await scope.db();
      const inserted = await db
        .insert(knowledgeSources)
        .values({ ...input, seedKey, ownerId: scope.ownerId })
        .onConflictDoNothing()
        .returning({ id: knowledgeSources.id });
      if (inserted[0]) return { id: inserted[0].id, outcome: 'created' };
      const [existing] = await db
        .select({ id: knowledgeSources.id })
        .from(knowledgeSources)
        .where(and(eq(knowledgeSources.ownerId, scope.ownerId), eq(knowledgeSources.seedKey, seedKey)));
      if (!existing) throw new Error('seeded source missing after conflict');
      return { id: existing.id, outcome: 'kept' };
    },
  };
}

export function scopedItems(scope: Scope) {
  /** A source id may only point at one of this owner's own sources. */
  async function assertOwnSource(sourceId: string | null | undefined): Promise<void> {
    if (!sourceId) return;
    const db = await scope.db();
    const [row] = await db
      .select({ id: knowledgeSources.id })
      .from(knowledgeSources)
      .where(and(eq(knowledgeSources.ownerId, scope.ownerId), eq(knowledgeSources.id, sourceId)));
    if (!row) throw new NotFoundError('source');
  }

  function filters(filter: ItemFilter): SQL[] {
    const conditions: SQL[] = [eq(knowledgeItems.ownerId, scope.ownerId)];
    if (filter.kind) conditions.push(eq(knowledgeItems.kind, filter.kind));
    if (filter.confidentiality) conditions.push(eq(knowledgeItems.confidentiality, filter.confidentiality));
    if (filter.verificationStatus) conditions.push(eq(knowledgeItems.verificationStatus, filter.verificationStatus));
    return conditions;
  }

  function page(filter: ItemFilter): { limit: number; offset: number } {
    return { limit: Math.min(Math.max(filter.limit ?? 100, 1), MAX_PAGE), offset: Math.max(filter.offset ?? 0, 0) };
  }

  return {
    async list(filter: ItemFilter = {}): Promise<KnowledgeItem[]> {
      const db = await scope.db();
      const { limit, offset } = page(filter);
      return db
        .select(itemColumns)
        .from(knowledgeItems)
        .where(and(...filters(filter)))
        .orderBy(desc(knowledgeItems.updatedAt), desc(knowledgeItems.createdAt))
        .limit(limit)
        .offset(offset);
    },

    async get(id: string): Promise<KnowledgeItem | null> {
      const db = await scope.db();
      const [row] = await db
        .select(itemColumns)
        .from(knowledgeItems)
        .where(and(eq(knowledgeItems.ownerId, scope.ownerId), eq(knowledgeItems.id, id)));
      return row ?? null;
    },

    async create(input: ItemInput): Promise<KnowledgeItem> {
      await assertOwnSource(input.sourceId);
      const db = await scope.db();
      const [row] = await db
        .insert(knowledgeItems)
        // ownerId comes last and from the scope; a smuggled key in `input` cannot win.
        .values({ ...input, ownerId: scope.ownerId })
        .returning(itemColumns);
      if (!row) throw new Error('item insert returned no row');
      return row;
    },

    async update(id: string, patch: ItemPatch): Promise<KnowledgeItem> {
      if (patch.sourceId) await assertOwnSource(patch.sourceId);
      const db = await scope.db();
      const [row] = await db
        .update(knowledgeItems)
        .set({ ...definedOnly(patch), updatedAt: new Date() })
        .where(and(eq(knowledgeItems.ownerId, scope.ownerId), eq(knowledgeItems.id, id)))
        .returning(itemColumns);
      if (!row) throw new NotFoundError('item');
      return row;
    },

    /** The owner confirms the claim is accurate. Does not touch public-use permission. */
    async markReviewed(id: string): Promise<KnowledgeItem> {
      const db = await scope.db();
      const now = new Date();
      const [row] = await db
        .update(knowledgeItems)
        .set({ verificationStatus: 'verified', lastReviewedAt: now, updatedAt: now })
        .where(and(eq(knowledgeItems.ownerId, scope.ownerId), eq(knowledgeItems.id, id)))
        .returning(itemColumns);
      if (!row) throw new NotFoundError('item');
      return row;
    },

    async remove(id: string): Promise<boolean> {
      const db = await scope.db();
      const rows = await db
        .delete(knowledgeItems)
        .where(and(eq(knowledgeItems.ownerId, scope.ownerId), eq(knowledgeItems.id, id)))
        .returning({ id: knowledgeItems.id });
      return rows.length > 0;
    },

    async counts(): Promise<{ total: number; needsReview: number }> {
      const db = await scope.db();
      const [row] = await db
        .select({
          total: count(),
          needsReview: sql<number>`count(*) filter (where ${knowledgeItems.verificationStatus} = 'owner_claim_needs_review')`,
        })
        .from(knowledgeItems)
        .where(eq(knowledgeItems.ownerId, scope.ownerId));
      return { total: Number(row?.total ?? 0), needsReview: Number(row?.needsReview ?? 0) };
    },

    /**
     * Ranked full-text search over this owner's items only. The tenant filter is part of the same
     * WHERE as the text match, so another owner's rows are never candidates, ranked or not.
     */
    async search(query: string, filter: ItemFilter = {}): Promise<SearchHit[]> {
      const db = await scope.db();
      const { limit, offset } = page(filter);
      const tsquery = sql`websearch_to_tsquery('english', ${query})`;
      const rank = sql<number>`ts_rank(${knowledgeItems.search}, ${tsquery})`;
      const rows = await db
        .select({
          item: itemColumns,
          rank,
          snippet: sql<string>`ts_headline('english', ${knowledgeItems.body}, ${tsquery}, ${HEADLINE_OPTIONS})`,
          titleMarked: sql<string>`ts_headline('english', ${knowledgeItems.title}, ${tsquery}, ${TITLE_HEADLINE_OPTIONS})`,
        })
        .from(knowledgeItems)
        .where(and(...filters(filter), sql`${knowledgeItems.search} @@ ${tsquery}`))
        .orderBy(desc(rank), desc(knowledgeItems.updatedAt))
        .limit(limit)
        .offset(offset);
      return rows.map((r) => ({ item: r.item, rank: Number(r.rank), snippet: r.snippet, titleMarked: r.titleMarked }));
    },

    /** Insert when no item with this seed key exists. Never modifies an existing one, so owner edits survive a re-run. */
    async insertSeeded(seedKey: string, input: ItemInput): Promise<'created' | 'kept'> {
      await assertOwnSource(input.sourceId);
      const db = await scope.db();
      const rows = await db
        .insert(knowledgeItems)
        .values({ ...input, seedKey, ownerId: scope.ownerId })
        .onConflictDoNothing()
        .returning({ id: knowledgeItems.id });
      return rows.length ? 'created' : 'kept';
    },
  };
}
