import { z } from 'zod';
import {
  ARTICLE_SOURCE_KINDS,
  ARTICLE_STATUSES,
  LIMITS,
  SLUG_PATTERN,
  slugify,
  type ArticleSourceKind,
} from '../../lib/articles';
import { ConflictError, type ArticleFilter, type ArticleHit, type ArticleListRow, type ArticlePatch, type VersionSummary } from '../data/articles';
import { NotFoundError, SlugTakenError } from '../data/scope';
import type { Article, ArticleVersion } from '../db/schema';
import { ActionError, parseId, parseInput, type OwnerContext } from './owner';

const text = (max: number) => z.string().trim().max(max);

/** Tags: trimmed, no empty entries, no duplicates (ignoring case), within the limits. */
const tagsSchema = z
  .array(z.string())
  .max(LIMITS.tags, `Use at most ${LIMITS.tags} tags.`)
  .transform((tags) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of tags) {
      const tag = raw.trim();
      if (!tag || seen.has(tag.toLowerCase())) continue;
      seen.add(tag.toLowerCase());
      out.push(tag);
    }
    return out;
  })
  .refine((tags) => tags.every((t) => t.length <= LIMITS.tag), `Each tag can be at most ${LIMITS.tag} characters.`);

/** A canonical address must be an absolute http(s) URL. An empty value clears it. */
const canonicalSchema = z
  .string()
  .trim()
  .max(LIMITS.canonicalUrl)
  .transform((value, ctx) => {
    if (value === '') return null;
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('scheme');
      return url.toString();
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Enter a full web address starting with http:// or https://.' });
      return z.NEVER;
    }
  })
  .nullable();

const slugSchema = text(LIMITS.slug)
  .min(1, 'A slug is required.')
  .regex(SLUG_PATTERN, 'Use lower-case letters, numbers and single hyphens only.');

export const articleCreateSchema = z.object({
  title: text(LIMITS.title).default(''),
  slug: slugSchema.optional(),
  description: text(LIMITS.description).default(''),
  tags: tagsSchema.default([]),
  canonicalUrl: canonicalSchema.default(null),
  bodyMarkdown: z.string().max(LIMITS.body, `The article is longer than ${LIMITS.body.toLocaleString('en')} characters.`).default(''),
});

/** Everything an editor may change. There is no owner id and no revision-free way to save. */
export const articleSaveSchema = z.object({
  expectedRevision: z.number().int().min(1),
  reason: z.enum(['autosave', 'manual']).default('autosave'),
  title: text(LIMITS.title).optional(),
  slug: slugSchema.optional(),
  description: text(LIMITS.description).optional(),
  tags: tagsSchema.optional(),
  canonicalUrl: canonicalSchema.optional(),
  coverAssetId: z.uuid().nullable().optional(),
  status: z.enum(ARTICLE_STATUSES).optional(),
  bodyMarkdown: z.string().max(LIMITS.body, `The article is longer than ${LIMITS.body.toLocaleString('en')} characters.`).optional(),
});

export const articleListSchema = z.object({
  q: text(LIMITS.query).optional(),
  status: z.enum([...ARTICLE_STATUSES, 'all'] as const).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export interface ArticleList {
  query: string;
  hits: ArticleHit[] | null;
  articles: ArticleListRow[];
}

function mapErrors(err: unknown): never {
  if (err instanceof ConflictError) {
    throw new ActionError('conflict', 'This article was changed somewhere else since you opened it.', {}, { current: err.current });
  }
  if (err instanceof SlugTakenError) {
    throw new ActionError('invalid', 'Another article of yours already uses that slug.', { slug: 'Another article of yours already uses that slug.' });
  }
  if (err instanceof NotFoundError) {
    throw new ActionError('not_found', `${err.message.replace(/ not found$/, '').replace(/^./, (c) => c.toUpperCase())} not found`);
  }
  throw err;
}

async function guard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    return mapErrors(err);
  }
}

export async function listArticles(owner: OwnerContext, rawQuery: Record<string, unknown> = {}): Promise<ArticleList> {
  const cleaned = Object.fromEntries(Object.entries(rawQuery).filter(([, v]) => v !== undefined && v !== ''));
  const query = parseInput(articleListSchema, cleaned);
  const filter: ArticleFilter = { status: query.status, limit: query.limit, offset: query.offset };
  if (query.q) {
    const hits = await owner.data.articles.search(query.q, filter);
    return { query: query.q, hits, articles: hits.map((h) => h.article) };
  }
  return { query: '', hits: null, articles: await owner.data.articles.list(filter) };
}

export async function articleCounts(owner: OwnerContext) {
  return owner.data.articles.counts();
}

export async function getArticle(owner: OwnerContext, id: unknown): Promise<Article> {
  const article = await owner.data.articles.get(parseId(id, 'Article'));
  if (!article) throw new ActionError('not_found', 'Article not found');
  return article;
}

export async function createArticle(owner: OwnerContext, input: unknown = {}): Promise<Article> {
  const values = parseInput(articleCreateSchema, input);
  const slug = values.slug ?? (await owner.data.articles.freeSlug(slugify(values.title || 'untitled')));
  const article = await guard(() =>
    owner.data.articles.create({
      title: values.title,
      slug,
      description: values.description,
      tags: values.tags,
      canonicalUrl: values.canonicalUrl,
      bodyMarkdown: values.bodyMarkdown,
      sourceKind: 'manual',
    }),
  );
  await owner.data.audit.record({ actor: owner.actor, action: 'article.created', entityType: 'article', entityId: article.id });
  return article;
}

/** Save changes if the editor's copy is still current; otherwise a 'conflict' carrying the current copy. */
export async function saveArticle(owner: OwnerContext, id: unknown, input: unknown): Promise<Article> {
  const articleId = parseId(id, 'Article');
  const { expectedRevision, reason, ...rest } = parseInput(articleSaveSchema, input);
  const patch: ArticlePatch = {
    title: rest.title,
    slug: rest.slug,
    description: rest.description,
    tags: rest.tags,
    canonicalUrl: rest.canonicalUrl,
    coverAssetId: rest.coverAssetId,
    status: rest.status,
    bodyMarkdown: rest.bodyMarkdown,
  };
  const article = await guard(() => owner.data.articles.save(articleId, expectedRevision, patch, reason));
  // Autosaves would flood the log; deliberate saves are recorded.
  if (reason === 'manual') {
    await owner.data.audit.record({ actor: owner.actor, action: 'article.saved', entityType: 'article', entityId: article.id });
  }
  return article;
}

export async function deleteArticle(owner: OwnerContext, id: unknown): Promise<void> {
  const articleId = parseId(id, 'Article');
  if (!(await owner.data.articles.remove(articleId))) throw new ActionError('not_found', 'Article not found');
  await owner.data.audit.record({ actor: owner.actor, action: 'article.deleted', entityType: 'article', entityId: articleId });
}

/** Whether a slug is free for this owner, and a free alternative when it is not. */
export async function checkSlug(owner: OwnerContext, slug: unknown, exceptId?: unknown) {
  const parsed = slugSchema.safeParse(typeof slug === 'string' ? slug : '');
  if (!parsed.success) {
    return { valid: false as const, available: false, message: parsed.error.issues[0]?.message ?? 'Invalid slug.', suggestion: null };
  }
  const except = typeof exceptId === 'string' && exceptId !== '' ? parseId(exceptId, 'Article') : undefined;
  const taken = await owner.data.articles.slugTaken(parsed.data, except);
  return {
    valid: true as const,
    available: !taken,
    message: taken ? 'Another article of yours already uses that slug.' : null,
    suggestion: taken ? await owner.data.articles.freeSlug(parsed.data) : null,
  };
}

export async function listVersions(owner: OwnerContext, articleId: unknown): Promise<VersionSummary[]> {
  const id = parseId(articleId, 'Article');
  if (!(await owner.data.articles.get(id))) throw new ActionError('not_found', 'Article not found');
  return owner.data.articles.listVersions(id);
}

export async function getVersion(owner: OwnerContext, articleId: unknown, versionNo: unknown): Promise<ArticleVersion> {
  const id = parseId(articleId, 'Article');
  const no = z.coerce.number().int().min(1).safeParse(versionNo);
  if (!no.success) throw new ActionError('not_found', 'Version not found');
  const version = await owner.data.articles.getVersion(id, no.data);
  if (!version) throw new ActionError('not_found', 'Version not found');
  return version;
}

const restoreSchema = z.object({ expectedRevision: z.number().int().min(1) });

export async function restoreVersion(owner: OwnerContext, articleId: unknown, versionNo: unknown, input: unknown): Promise<Article> {
  const id = parseId(articleId, 'Article');
  const no = z.coerce.number().int().min(1).safeParse(versionNo);
  if (!no.success) throw new ActionError('not_found', 'Version not found');
  const { expectedRevision } = parseInput(restoreSchema, input);
  const article = await guard(() => owner.data.articles.restore(id, no.data, expectedRevision));
  await owner.data.audit.record({
    actor: owner.actor,
    action: 'article.restored',
    entityType: 'article',
    entityId: article.id,
    metadata: { fromVersion: no.data },
  });
  return article;
}

/** Used by imports: create an article with its first snapshot (reason 'import'), choosing a free slug. */
export async function createImportedArticle(
  owner: OwnerContext,
  input: {
    title: string;
    description: string;
    tags: string[];
    canonicalUrl: string | null;
    bodyMarkdown: string;
    extraMetadata: Record<string, unknown>;
    sourceKind: ArticleSourceKind;
    sourceRef: string;
  },
): Promise<Article> {
  if (!ARTICLE_SOURCE_KINDS.includes(input.sourceKind)) throw new ActionError('invalid', 'Unknown source kind.');
  const values = parseInput(articleCreateSchema, {
    title: input.title.slice(0, LIMITS.title),
    description: input.description.slice(0, LIMITS.description),
    tags: input.tags.map((t) => t.slice(0, LIMITS.tag)).slice(0, LIMITS.tags),
    canonicalUrl: input.canonicalUrl ?? '',
    bodyMarkdown: input.bodyMarkdown,
  });
  const slug = await owner.data.articles.freeSlug(slugify(values.title || 'untitled'));
  const article = await guard(() =>
    owner.data.articles.create({
      title: values.title,
      slug,
      description: values.description,
      tags: values.tags,
      canonicalUrl: values.canonicalUrl,
      bodyMarkdown: values.bodyMarkdown,
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef.slice(0, 2000),
      extraMetadata: input.extraMetadata,
      reason: 'import',
    }),
  );
  await owner.data.audit.record({
    actor: owner.actor,
    action: 'article.imported',
    entityType: 'article',
    entityId: article.id,
    metadata: { sourceKind: input.sourceKind },
  });
  return article;
}
