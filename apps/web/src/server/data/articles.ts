import { and, asc, count, desc, eq, getTableColumns, ilike, inArray, ne, sql, type SQL } from 'drizzle-orm';
import {
  articles,
  articleVersions,
  assets,
  studioSettings,
  type Article,
  type ArticleVersion,
  type Asset,
} from '../db/schema';
import {
  AUTOSAVE_BURST_MS,
  type ArticleSourceKind,
  type ArticleStatus,
  type VersionReason,
} from '../../lib/articles';
import { MARK_END, MARK_START } from '../../lib/knowledge';
import { definedOnly, isUniqueViolation, NotFoundError, SlugTakenError, type Scope } from './scope';

/** Every article column except the search vector, which is an index, not data to hand around. */
const { search: _searchVector, ...articleColumns } = getTableColumns(articles);
void _searchVector;

/** The article list never carries bodies; it carries their length so the UI can show size. */
const { bodyMarkdown: _body, search: _vector, ...listColumns } = getTableColumns(articles);
void _body;
void _vector;

export type ArticleListRow = Omit<Article, 'bodyMarkdown'> & { bodyChars: number };

export interface ArticleCreateInput {
  title: string;
  slug: string;
  description?: string;
  tags?: string[];
  canonicalUrl?: string | null;
  status?: ArticleStatus;
  bodyMarkdown?: string;
  sourceKind?: ArticleSourceKind;
  sourceRef?: string | null;
  extraMetadata?: Record<string, unknown>;
  /** Why the first snapshot exists. Defaults to 'manual' when the article is created with content. */
  reason?: VersionReason;
}

export type ArticlePatch = {
  title?: string;
  slug?: string;
  description?: string;
  tags?: string[];
  canonicalUrl?: string | null;
  coverAssetId?: string | null;
  status?: ArticleStatus;
  bodyMarkdown?: string;
};

export interface ArticleFilter {
  /** Undefined hides archived articles; 'all' shows everything. */
  status?: ArticleStatus | 'all' | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface ArticleHit {
  article: ArticleListRow;
  rank: number;
  /** Body excerpt with MARK_START / MARK_END around matches. Not HTML-escaped. */
  snippet: string;
  titleMarked: string;
}

export interface VersionSummary {
  id: string;
  versionNo: number;
  title: string;
  reason: VersionReason;
  createdAt: Date;
  chars: number;
}

export interface AssetInput {
  articleId: string | null;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  storageKey: string;
  alt?: string;
}

/** The save named a revision that is no longer current: someone (another tab) saved in between. */
export class ConflictError extends Error {
  constructor(readonly current: Article) {
    super('The article changed since you opened it');
    this.name = 'ConflictError';
  }
}

export { MARK_END, MARK_START };

const MAX_PAGE = 200;
const HEADLINE_OPTIONS = `StartSel=${MARK_START},StopSel=${MARK_END},MaxFragments=2,MaxWords=28,MinWords=10,FragmentDelimiter= ... `;
const TITLE_HEADLINE_OPTIONS = `StartSel=${MARK_START},StopSel=${MARK_END},HighlightAll=true`;

/** The slice of an article a snapshot records beyond title and body. */
function snapshotMetadata(a: Pick<Article, 'slug' | 'description' | 'tags' | 'canonicalUrl' | 'coverAssetId' | 'status'>) {
  return {
    slug: a.slug,
    description: a.description,
    tags: a.tags,
    canonicalUrl: a.canonicalUrl,
    coverAssetId: a.coverAssetId,
    status: a.status,
  };
}

function sameSnapshot(version: ArticleVersion, article: Article): boolean {
  // jsonb does not keep key order, so compare field by field rather than as strings.
  const stored = version.metadata as Record<string, unknown>;
  const now = snapshotMetadata(article);
  return (
    version.title === article.title &&
    version.body === article.bodyMarkdown &&
    (Object.keys(now) as (keyof typeof now)[]).every((key) => JSON.stringify(stored[key] ?? null) === JSON.stringify(now[key] ?? null))
  );
}

function page(filter: { limit?: number | undefined; offset?: number | undefined }) {
  return { limit: Math.min(Math.max(filter.limit ?? 50, 1), MAX_PAGE), offset: Math.max(filter.offset ?? 0, 0) };
}

export function scopedArticles(scope: Scope) {
  const owned = (id: string) => and(eq(articles.ownerId, scope.ownerId), eq(articles.id, id));

  /** A cover must be one of this owner's own assets. */
  async function assertOwnAsset(assetId: string | null | undefined): Promise<void> {
    if (!assetId) return;
    const db = await scope.db();
    const [row] = await db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.ownerId, scope.ownerId), eq(assets.id, assetId)));
    if (!row) throw new NotFoundError('asset');
  }

  function statusFilter(filter: ArticleFilter): SQL[] {
    const conditions: SQL[] = [eq(articles.ownerId, scope.ownerId)];
    if (filter.status === undefined) conditions.push(ne(articles.status, 'archived'));
    else if (filter.status !== 'all') conditions.push(eq(articles.status, filter.status));
    return conditions;
  }

  const listSelect = { ...listColumns, bodyChars: sql<number>`length(${articles.bodyMarkdown})` };

  return {
    async list(filter: ArticleFilter = {}): Promise<ArticleListRow[]> {
      const db = await scope.db();
      const { limit, offset } = page(filter);
      const rows = await db
        .select(listSelect)
        .from(articles)
        .where(and(...statusFilter(filter)))
        .orderBy(desc(articles.updatedAt), desc(articles.createdAt))
        .limit(limit)
        .offset(offset);
      return rows.map((r) => ({ ...r, bodyChars: Number(r.bodyChars) }));
    },

    async counts(): Promise<Record<ArticleStatus | 'total', number>> {
      const db = await scope.db();
      const rows = await db
        .select({ status: articles.status, n: count() })
        .from(articles)
        .where(eq(articles.ownerId, scope.ownerId))
        .groupBy(articles.status);
      const result = { draft: 0, ready: 0, archived: 0, total: 0 };
      for (const row of rows) {
        result[row.status] = Number(row.n);
        result.total += Number(row.n);
      }
      return result;
    },

    async get(id: string): Promise<Article | null> {
      const db = await scope.db();
      const [row] = await db.select(articleColumns).from(articles).where(owned(id));
      return row ?? null;
    },

    /** Every article this owner holds, with bodies. For export. */
    async listAll(offset = 0, limit = 100): Promise<Article[]> {
      const db = await scope.db();
      return db
        .select(articleColumns)
        .from(articles)
        .where(eq(articles.ownerId, scope.ownerId))
        .orderBy(asc(articles.createdAt))
        .limit(limit)
        .offset(offset);
    },

    /** Which of these import references already became an article here, so the UI can say "already imported". */
    async importedFrom(kind: ArticleSourceKind, refs: string[]): Promise<{ sourceRef: string; id: string; title: string }[]> {
      if (refs.length === 0) return [];
      const db = await scope.db();
      const rows = await db
        .select({ sourceRef: articles.sourceRef, id: articles.id, title: articles.title })
        .from(articles)
        .where(and(eq(articles.ownerId, scope.ownerId), eq(articles.sourceKind, kind), inArray(articles.sourceRef, refs)));
      return rows.flatMap((r) => (r.sourceRef ? [{ sourceRef: r.sourceRef, id: r.id, title: r.title }] : []));
    },

    async slugTaken(slug: string, exceptId?: string): Promise<boolean> {
      const db = await scope.db();
      const conditions = [eq(articles.ownerId, scope.ownerId), eq(articles.slug, slug)];
      if (exceptId) conditions.push(ne(articles.id, exceptId));
      const [row] = await db.select({ id: articles.id }).from(articles).where(and(...conditions));
      return Boolean(row);
    },

    /** The slug itself when free, otherwise slug-2, slug-3 and so on. */
    async freeSlug(base: string): Promise<string> {
      const db = await scope.db();
      const rows = await db
        .select({ slug: articles.slug })
        .from(articles)
        .where(and(eq(articles.ownerId, scope.ownerId), ilike(articles.slug, `${base.replace(/[%_\\]/g, '\\$&')}%`)));
      const taken = new Set(rows.map((r) => r.slug));
      if (!taken.has(base)) return base;
      for (let n = 2; ; n++) {
        const candidate = `${base}-${n}`;
        if (!taken.has(candidate)) return candidate;
      }
    },

    async create(input: ArticleCreateInput): Promise<Article> {
      const db = await scope.db();
      try {
        return await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(articles)
            .values({
              title: input.title,
              slug: input.slug,
              description: input.description ?? '',
              tags: input.tags ?? [],
              canonicalUrl: input.canonicalUrl ?? null,
              status: input.status ?? 'draft',
              bodyMarkdown: input.bodyMarkdown ?? '',
              sourceKind: input.sourceKind ?? 'manual',
              sourceRef: input.sourceRef ?? null,
              extraMetadata: input.extraMetadata ?? {},
              ownerId: scope.ownerId,
            })
            .returning(articleColumns);
          if (!row) throw new Error('article insert returned no row');
          if (row.bodyMarkdown.length > 0 || input.reason) {
            await tx.insert(articleVersions).values({
              ownerId: scope.ownerId,
              articleId: row.id,
              versionNo: 1,
              title: row.title,
              body: row.bodyMarkdown,
              metadata: snapshotMetadata(row),
              reason: input.reason ?? 'manual',
            });
          }
          return row;
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw new SlugTakenError(input.slug);
        throw err;
      }
    },

    /**
     * Apply a patch if `expectedRevision` is still current, in one transaction with the history entry.
     * Throws ConflictError (with the current article) when it is not, SlugTakenError for a used slug,
     * NotFoundError when the article is not this owner's. A patch that changes nothing returns the
     * article untouched and records nothing.
     *
     * History: a 'manual' save always leaves a durable snapshot of the current state. An 'autosave'
     * keeps at most one snapshot per editing burst (AUTOSAVE_BURST_MS from the burst's first save):
     * the previous autosave of the same burst is replaced by a new one holding the latest state.
     * Rows are never edited; a superseded autosave row is deleted and a new row inserted.
     */
    async save(id: string, expectedRevision: number, patch: ArticlePatch, reason: 'autosave' | 'manual'): Promise<Article> {
      if (patch.coverAssetId) await assertOwnAsset(patch.coverAssetId);
      const db = await scope.db();
      try {
        return await db.transaction(async (tx) => {
          const [current] = await tx.select(articleColumns).from(articles).where(owned(id)).for('update');
          if (!current) throw new NotFoundError('article');
          if (current.revision !== expectedRevision) throw new ConflictError(current);

          const changes = definedOnly(patch);
          const changed = (Object.keys(changes) as (keyof ArticlePatch)[]).some((key) => {
            const next = changes[key];
            const prev = current[key as keyof Article];
            return Array.isArray(next) ? JSON.stringify(next) !== JSON.stringify(prev) : next !== prev;
          });

          let article = current;
          if (changed) {
            const [updated] = await tx
              .update(articles)
              .set({ ...changes, revision: current.revision + 1, updatedAt: new Date() })
              .where(owned(id))
              .returning(articleColumns);
            if (!updated) throw new NotFoundError('article');
            article = updated;
          }

          const [latest] = await tx
            .select()
            .from(articleVersions)
            .where(and(eq(articleVersions.ownerId, scope.ownerId), eq(articleVersions.articleId, id)))
            .orderBy(desc(articleVersions.versionNo))
            .limit(1);

          if (reason === 'manual') {
            if (latest && sameSnapshot(latest, article) && latest.reason !== 'autosave') return article;
            if (latest?.reason === 'autosave' && sameSnapshot(latest, article)) {
              await tx.delete(articleVersions).where(and(eq(articleVersions.ownerId, scope.ownerId), eq(articleVersions.id, latest.id)));
            }
            await tx.insert(articleVersions).values({
              ownerId: scope.ownerId,
              articleId: id,
              versionNo: (latest?.versionNo ?? 0) + 1,
              title: article.title,
              body: article.bodyMarkdown,
              metadata: snapshotMetadata(article),
              reason: 'manual',
            });
            return article;
          }

          // autosave
          if (!changed) return article;
          const now = Date.now();
          let burstStart = now;
          if (latest?.reason === 'autosave') {
            const stored = (latest.metadata as { burstStart?: unknown }).burstStart;
            const started = typeof stored === 'string' ? Date.parse(stored) : latest.createdAt.getTime();
            if (Number.isFinite(started) && now - started < AUTOSAVE_BURST_MS) {
              burstStart = started;
              await tx.delete(articleVersions).where(and(eq(articleVersions.ownerId, scope.ownerId), eq(articleVersions.id, latest.id)));
            }
          }
          await tx.insert(articleVersions).values({
            ownerId: scope.ownerId,
            articleId: id,
            versionNo: (latest?.versionNo ?? 0) + 1,
            title: article.title,
            body: article.bodyMarkdown,
            metadata: { ...snapshotMetadata(article), burstStart: new Date(burstStart).toISOString() },
            reason: 'autosave',
          });
          return article;
        });
      } catch (err) {
        if (err instanceof ConflictError || err instanceof NotFoundError) throw err;
        if (isUniqueViolation(err) && patch.slug) throw new SlugTakenError(patch.slug);
        throw err;
      }
    },

    async remove(id: string): Promise<boolean> {
      const db = await scope.db();
      const rows = await db.delete(articles).where(owned(id)).returning({ id: articles.id });
      return rows.length > 0;
    },

    /**
     * Ranked full-text search over this owner's articles. The tenant filter shares the WHERE with the
     * text match, so another owner's rows are never candidates.
     */
    async search(query: string, filter: ArticleFilter = {}): Promise<ArticleHit[]> {
      const db = await scope.db();
      const { limit, offset } = page(filter);
      const tsquery = sql`websearch_to_tsquery('english', ${query})`;
      const rank = sql<number>`ts_rank(${articles.search}, ${tsquery})`;
      const rows = await db
        .select({
          article: listSelect,
          rank,
          snippet: sql<string>`ts_headline('english', ${articles.bodyMarkdown}, ${tsquery}, ${HEADLINE_OPTIONS})`,
          titleMarked: sql<string>`ts_headline('english', ${articles.title}, ${tsquery}, ${TITLE_HEADLINE_OPTIONS})`,
        })
        .from(articles)
        .where(and(...statusFilter(filter), sql`${articles.search} @@ ${tsquery}`))
        .orderBy(desc(rank), desc(articles.updatedAt))
        .limit(limit)
        .offset(offset);
      return rows.map((r) => ({
        article: { ...r.article, bodyChars: Number(r.article.bodyChars) },
        rank: Number(r.rank),
        snippet: r.snippet,
        titleMarked: r.titleMarked,
      }));
    },

    /** Newest first, without bodies. */
    async listVersions(articleId: string): Promise<VersionSummary[]> {
      const db = await scope.db();
      const rows = await db
        .select({
          id: articleVersions.id,
          versionNo: articleVersions.versionNo,
          title: articleVersions.title,
          reason: articleVersions.reason,
          createdAt: articleVersions.createdAt,
          chars: sql<number>`length(${articleVersions.body})`,
        })
        .from(articleVersions)
        .where(and(eq(articleVersions.ownerId, scope.ownerId), eq(articleVersions.articleId, articleId)))
        .orderBy(desc(articleVersions.versionNo));
      return rows.map((r) => ({ ...r, chars: Number(r.chars) }));
    },

    async getVersion(articleId: string, versionNo: number): Promise<ArticleVersion | null> {
      const db = await scope.db();
      const [row] = await db
        .select()
        .from(articleVersions)
        .where(
          and(
            eq(articleVersions.ownerId, scope.ownerId),
            eq(articleVersions.articleId, articleId),
            eq(articleVersions.versionNo, versionNo),
          ),
        );
      return row ?? null;
    },

    /**
     * Put an earlier version's content back as a NEW version (reason 'restore'); history is never
     * rewritten. Title, body, description, tags, canonical URL and cover come back. The slug and
     * status stay as they are now: restoring must not change a published address or collide.
     */
    async restore(articleId: string, versionNo: number, expectedRevision: number): Promise<Article> {
      const db = await scope.db();
      return db.transaction(async (tx) => {
        const [current] = await tx.select(articleColumns).from(articles).where(owned(articleId)).for('update');
        if (!current) throw new NotFoundError('article');
        const [version] = await tx
          .select()
          .from(articleVersions)
          .where(
            and(
              eq(articleVersions.ownerId, scope.ownerId),
              eq(articleVersions.articleId, articleId),
              eq(articleVersions.versionNo, versionNo),
            ),
          );
        if (!version) throw new NotFoundError('version');
        if (current.revision !== expectedRevision) throw new ConflictError(current);

        const meta = version.metadata as Record<string, unknown>;
        const cover = typeof meta.coverAssetId === 'string' ? meta.coverAssetId : null;
        let coverAssetId: string | null = null;
        if (cover) {
          const [asset] = await tx
            .select({ id: assets.id })
            .from(assets)
            .where(and(eq(assets.ownerId, scope.ownerId), eq(assets.id, cover)));
          coverAssetId = asset?.id ?? null;
        }
        const [updated] = await tx
          .update(articles)
          .set({
            title: version.title,
            bodyMarkdown: version.body,
            description: typeof meta.description === 'string' ? meta.description : current.description,
            tags: Array.isArray(meta.tags) ? meta.tags.filter((t): t is string => typeof t === 'string') : current.tags,
            canonicalUrl: typeof meta.canonicalUrl === 'string' ? meta.canonicalUrl : null,
            coverAssetId,
            revision: current.revision + 1,
            updatedAt: new Date(),
          })
          .where(owned(articleId))
          .returning(articleColumns);
        if (!updated) throw new NotFoundError('article');

        const [latest] = await tx
          .select({ versionNo: articleVersions.versionNo })
          .from(articleVersions)
          .where(and(eq(articleVersions.ownerId, scope.ownerId), eq(articleVersions.articleId, articleId)))
          .orderBy(desc(articleVersions.versionNo))
          .limit(1);
        await tx.insert(articleVersions).values({
          ownerId: scope.ownerId,
          articleId,
          versionNo: (latest?.versionNo ?? 0) + 1,
          title: updated.title,
          body: updated.bodyMarkdown,
          metadata: { ...snapshotMetadata(updated), restoredFrom: versionNo },
          reason: 'restore',
        });
        return updated;
      });
    },
  };
}

export function scopedAssets(scope: Scope) {
  return {
    async get(id: string): Promise<Asset | null> {
      const db = await scope.db();
      const [row] = await db.select().from(assets).where(and(eq(assets.ownerId, scope.ownerId), eq(assets.id, id)));
      return row ?? null;
    },

    async findBySha(sha256: string): Promise<Asset | null> {
      const db = await scope.db();
      const [row] = await db
        .select()
        .from(assets)
        .where(and(eq(assets.ownerId, scope.ownerId), eq(assets.sha256, sha256)));
      return row ?? null;
    },

    async list(articleId?: string): Promise<Asset[]> {
      const db = await scope.db();
      const conditions = [eq(assets.ownerId, scope.ownerId)];
      if (articleId) conditions.push(eq(assets.articleId, articleId));
      return db.select().from(assets).where(and(...conditions)).orderBy(desc(assets.createdAt));
    },

    /** Several assets by id, only those this owner holds. */
    async getMany(ids: string[]): Promise<Asset[]> {
      if (ids.length === 0) return [];
      const db = await scope.db();
      return db.select().from(assets).where(and(eq(assets.ownerId, scope.ownerId), inArray(assets.id, ids)));
    },

    /**
     * Record an uploaded file. An article id, when given, must be this owner's. If this owner already
     * holds a file with the same sha256 the existing row is returned and `created` is false.
     */
    async create(input: AssetInput): Promise<{ asset: Asset; created: boolean }> {
      const db = await scope.db();
      if (input.articleId) {
        const [own] = await db
          .select({ id: articles.id })
          .from(articles)
          .where(and(eq(articles.ownerId, scope.ownerId), eq(articles.id, input.articleId)));
        if (!own) throw new NotFoundError('article');
      }
      const inserted = await db
        .insert(assets)
        .values({ ...input, alt: input.alt ?? '', ownerId: scope.ownerId })
        .onConflictDoNothing()
        .returning();
      if (inserted[0]) return { asset: inserted[0], created: true };
      const existing = await this.findBySha(input.sha256);
      if (!existing) throw new Error('asset missing after conflict');
      return { asset: existing, created: false };
    },

    async remove(id: string): Promise<Asset | null> {
      const db = await scope.db();
      const [row] = await db
        .delete(assets)
        .where(and(eq(assets.ownerId, scope.ownerId), eq(assets.id, id)))
        .returning();
      return row ?? null;
    },
  };
}

export function scopedStudioSettings(scope: Scope) {
  return {
    async get(): Promise<{ contentFolder: string | null }> {
      const db = await scope.db();
      const [row] = await db.select().from(studioSettings).where(eq(studioSettings.ownerId, scope.ownerId));
      return { contentFolder: row?.contentFolder ?? null };
    },

    async setContentFolder(folder: string | null): Promise<void> {
      const db = await scope.db();
      await db
        .insert(studioSettings)
        .values({ ownerId: scope.ownerId, contentFolder: folder })
        .onConflictDoUpdate({
          target: studioSettings.ownerId,
          set: { contentFolder: folder, updatedAt: new Date() },
        });
    },
  };
}
