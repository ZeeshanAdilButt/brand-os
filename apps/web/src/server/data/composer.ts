import { and, asc, eq, sql } from 'drizzle-orm';
import type { PlatformId } from '../../lib/publishing';
import type { SiteMapping, SitePreset } from '../../lib/site-export';
import { articleDestinations, articles, canonicalChecks, platformDrafts, siteSettings, type ArticleDestination, type CanonicalCheck, type SiteSettings } from '../db/schema';
import { NotFoundError, type Scope } from './scope';

/** Tenant-scoped access to the destinations an owner added to articles. */
export function scopedDestinations(scope: Scope) {
  const forArticle = (articleId: string) => and(eq(articleDestinations.ownerId, scope.ownerId), eq(articleDestinations.articleId, articleId));
  return {
    /** In the order the owner chose. */
    async list(articleId: string): Promise<ArticleDestination[]> {
      const db = await scope.db();
      return db.select().from(articleDestinations).where(forArticle(articleId)).orderBy(asc(articleDestinations.position), asc(articleDestinations.createdAt));
    },

    /** Add a destination to an article. Adding twice changes nothing. The article must be this owner's. */
    async add(articleId: string, platform: PlatformId): Promise<ArticleDestination> {
      const db = await scope.db();
      const [own] = await db.select({ id: articles.id }).from(articles).where(and(eq(articles.ownerId, scope.ownerId), eq(articles.id, articleId)));
      if (!own) throw new NotFoundError('article');
      const [last] = await db
        .select({ position: sql<number>`coalesce(max(${articleDestinations.position}), -1)` })
        .from(articleDestinations)
        .where(forArticle(articleId));
      const [row] = await db
        .insert(articleDestinations)
        .values({ ownerId: scope.ownerId, articleId, platform, position: (last?.position ?? -1) + 1 })
        .onConflictDoNothing()
        .returning();
      if (row) return row;
      const [existing] = await db.select().from(articleDestinations).where(and(forArticle(articleId), eq(articleDestinations.platform, platform)));
      if (!existing) throw new Error('destination insert returned no row');
      return existing;
    },

    async remove(articleId: string, platform: PlatformId): Promise<boolean> {
      const db = await scope.db();
      const gone = await db
        .delete(articleDestinations)
        .where(and(forArticle(articleId), eq(articleDestinations.platform, platform)))
        .returning({ id: articleDestinations.id });
      return gone.length > 0;
    },

    /** Put the listed platforms first, in that order. Platforms not listed keep their relative order after them. */
    async reorder(articleId: string, order: readonly PlatformId[]): Promise<void> {
      const db = await scope.db();
      await db.transaction(async (tx) => {
        let position = 0;
        for (const platform of order) {
          await tx
            .update(articleDestinations)
            .set({ position: position++ })
            .where(and(eq(articleDestinations.ownerId, scope.ownerId), eq(articleDestinations.articleId, articleId), eq(articleDestinations.platform, platform)));
        }
        const rest = await tx
          .select()
          .from(articleDestinations)
          .where(forArticle(articleId))
          .orderBy(asc(articleDestinations.position), asc(articleDestinations.createdAt));
        for (const row of rest.filter((r) => !order.includes(r.platform))) {
          await tx.update(articleDestinations).set({ position: position++ }).where(and(eq(articleDestinations.ownerId, scope.ownerId), eq(articleDestinations.id, row.id)));
        }
      });
    },

    /** Drafts made before destinations existed (or by an agent) imply a destination. */
    async ensureForDrafts(articleId: string): Promise<void> {
      const db = await scope.db();
      const drafts = await db
        .selectDistinct({ platform: platformDrafts.platform })
        .from(platformDrafts)
        .where(and(eq(platformDrafts.ownerId, scope.ownerId), eq(platformDrafts.articleId, articleId)));
      if (drafts.length === 0) return;
      const have = new Set((await db.select({ platform: articleDestinations.platform }).from(articleDestinations).where(forArticle(articleId))).map((r) => r.platform));
      let position = have.size;
      for (const { platform } of drafts) {
        if (have.has(platform)) continue;
        await db.insert(articleDestinations).values({ ownerId: scope.ownerId, articleId, platform, position: position++ }).onConflictDoNothing();
      }
    },
  };
}

export interface SiteSettingsSave {
  siteUrl: string | null;
  repo: string | null;
  baseBranch: string;
  pathTemplate: string;
  preset: SitePreset;
  mapping: SiteMapping;
}

/** Tenant-scoped access to the owner's personal-site settings (one row). */
export function scopedSiteSettings(scope: Scope) {
  return {
    async get(): Promise<SiteSettings | null> {
      const db = await scope.db();
      const [row] = await db.select().from(siteSettings).where(eq(siteSettings.ownerId, scope.ownerId));
      return row ?? null;
    },

    async save(input: SiteSettingsSave): Promise<SiteSettings> {
      const db = await scope.db();
      const now = new Date();
      const [row] = await db
        .insert(siteSettings)
        .values({ ...input, ownerId: scope.ownerId })
        .onConflictDoUpdate({ target: siteSettings.ownerId, set: { ...input, updatedAt: now } })
        .returning();
      if (!row) throw new Error('site settings save returned no row');
      return row;
    },
  };
}

export interface CanonicalSave {
  articleId: string;
  url: string;
  state: CanonicalCheck['state'];
  httpStatus: number | null;
  title: string | null;
  finalUrl: string | null;
  message: string;
  checkedAt: Date;
}

/** Tenant-scoped access to the canonical page checks. */
export function scopedCanonicalChecks(scope: Scope) {
  return {
    async get(articleId: string, url: string): Promise<CanonicalCheck | null> {
      const db = await scope.db();
      const [row] = await db
        .select()
        .from(canonicalChecks)
        .where(and(eq(canonicalChecks.ownerId, scope.ownerId), eq(canonicalChecks.articleId, articleId), eq(canonicalChecks.url, url)));
      return row ?? null;
    },

    /** One row per article and address: a new look replaces the old one. The article must be this owner's. */
    async save(input: CanonicalSave): Promise<CanonicalCheck> {
      const db = await scope.db();
      const [own] = await db.select({ id: articles.id }).from(articles).where(and(eq(articles.ownerId, scope.ownerId), eq(articles.id, input.articleId)));
      if (!own) throw new NotFoundError('article');
      const values = { ...input, ownerId: scope.ownerId };
      const [row] = await db
        .insert(canonicalChecks)
        .values(values)
        .onConflictDoUpdate({
          target: [canonicalChecks.ownerId, canonicalChecks.articleId, canonicalChecks.url],
          set: { state: input.state, httpStatus: input.httpStatus, title: input.title, finalUrl: input.finalUrl, message: input.message, checkedAt: input.checkedAt },
        })
        .returning();
      if (!row) throw new Error('canonical check save returned no row');
      return row;
    },
  };
}
