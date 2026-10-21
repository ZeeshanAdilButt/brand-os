import {
  checkSlug,
  createArticle,
  deleteArticle,
  getArticle,
  getVersion,
  listArticles,
  listVersions,
  restoreVersion,
  saveArticle,
} from '../actions/articles';
import { json, readJson, withOwner, type HandlerDeps } from './handlers';

export function handleArticlesGet(request: Request, deps: HandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => {
    const params = Object.fromEntries(new URL(request.url).searchParams);
    const result = await listArticles(owner, params);
    return json({
      query: result.query,
      articles: result.articles,
      ...(result.hits ? { hits: result.hits.map((h) => ({ id: h.article.id, rank: h.rank, snippet: h.snippet, title: h.titleMarked })) } : {}),
    });
  });
}

export function handleArticleCreate(request: Request, deps: HandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => {
    const body = request.headers.get('content-length') === '0' ? {} : await readJson(request).catch(() => ({}));
    return json(await createArticle(owner, body), 201);
  });
}

export function handleArticleGet(request: Request, id: string, deps: HandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => json(await getArticle(owner, id)));
}

export function handleArticlePatch(request: Request, id: string, deps: HandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => json(await saveArticle(owner, id, await readJson(request))));
}

export function handleArticleDelete(request: Request, id: string, deps: HandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => {
    await deleteArticle(owner, id);
    return json({ deleted: true });
  });
}

export function handleSlugCheck(request: Request, deps: HandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => {
    const params = new URL(request.url).searchParams;
    return json(await checkSlug(owner, params.get('slug') ?? '', params.get('exclude') ?? undefined));
  });
}

export function handleVersionsGet(request: Request, id: string, deps: HandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => json({ versions: await listVersions(owner, id) }));
}

export function handleVersionGet(request: Request, id: string, no: string, deps: HandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => json(await getVersion(owner, id, no)));
}

export function handleVersionRestore(request: Request, id: string, no: string, deps: HandlerDeps = {}) {
  return withOwner(request, deps, async (owner) => json(await restoreVersion(owner, id, no, await readJson(request))));
}
