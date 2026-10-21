import { PLATFORMS, PUBLISHING_LIMITS, type DraftPayload, type LintIssue } from '../../../lib/publishing';
import { PlatformError } from '../errors';
import { failureFor, parseObject, send, type HttpResult, type RequestOptions } from '../http';
import { analyzeBody, lintPayload } from '../lint';
import { devtoTag, sanitizeTags } from '../tags';
import type { AdaptInput, AdapterContext, CheckResult, HealthResult, PlatformAdapter, PublishResult, StageResult } from './types';

/**
 * DEV.to through the Forem API v1 (checked against developers.forem.com/api/v1, see INTEGRATIONS.md).
 *
 * - Auth is the `api-key` header. Requests carry `Accept: application/vnd.forem.api-v1+json`.
 * - A new article is `POST /api/articles`, an existing one `PUT /api/articles/{id}`, both with
 *   `{ article: {...} }`. `published: false` is a private draft; `published: true` makes it public.
 * - `published: true` is sent in `publish()` and nowhere else. `stage()` hard-sets `published: false`
 *   and refuses to touch an article that is live.
 * - Status lookups use the owner's own lists: `/api/articles/me/published` and `/me/unpublished`.
 * - `tags` is a comma-separated string of at most 4 names.
 */

export const DEVTO_DEFAULT_BASE = 'https://dev.to';
const ACCEPT = 'application/vnd.forem.api-v1+json';
const PAGE_SIZE = 100;
/** Upper bound on list pages read while looking for one article. Reaching it reads as "not found". */
const MAX_PAGES = 30;

type Json = Record<string, unknown>;

function requestOptions(ctx: AdapterContext): RequestOptions {
  return { fetch: ctx.fetch, timeoutMs: ctx.timeoutMs, secrets: [ctx.secret], now: ctx.now };
}

function call(ctx: AdapterContext, method: string, path: string, body?: unknown): Promise<HttpResult> {
  return send(requestOptions(ctx), `${ctx.baseUrl.replace(/\/+$/, '')}${path}`, {
    method,
    headers: { 'api-key': ctx.secret, accept: ACCEPT, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function expectOk(ctx: AdapterContext, res: HttpResult): HttpResult {
  if (res.ok) return res;
  throw failureFor('DEV.to', res, requestOptions(ctx));
}

/** The body DEV.to receives. Absent optional values are sent as null so an update never keeps an old one. */
export function devtoBody(payload: DraftPayload, published: boolean): { article: Json } {
  return {
    article: {
      title: payload.title,
      body_markdown: payload.bodyMarkdown,
      published,
      tags: payload.tags.join(','),
      canonical_url: payload.canonicalUrl,
      main_image: payload.coverImageUrl,
      description: payload.description,
      series: payload.series,
    },
  };
}

/** Find one of the owner's articles by id in a list, paging until it shows up. */
async function findIn(ctx: AdapterContext, list: 'published' | 'unpublished', id: string): Promise<Json | null> {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const path = `/api/articles/me/${list}?page=${page}&per_page=${PAGE_SIZE}`;
    const res = expectOk(ctx, await call(ctx, 'GET', path));
    let items: unknown;
    try {
      items = JSON.parse(res.text);
    } catch {
      throw new PlatformError('protocol', 'DEV.to answered a list request with something that is not JSON.', { httpStatus: res.status });
    }
    if (!Array.isArray(items)) throw new PlatformError('protocol', 'DEV.to answered a list request with an unexpected shape.', { httpStatus: res.status });
    const hit = items.find((item): item is Json => typeof item === 'object' && item !== null && String((item as Json).id) === id);
    if (hit) return hit;
    if (items.length < PAGE_SIZE) return null;
  }
  return null;
}

const isDevtoId = (id: string | null): id is string => id !== null && /^\d+$/.test(id);

export const devtoAdapter: PlatformAdapter = {
  id: 'devto',
  info: PLATFORMS.devto,

  adapt(input: AdaptInput) {
    const tagReport = sanitizeTags(input.tags, (raw) => devtoTag(raw, PUBLISHING_LIMITS.devtoTagChars));
    const footer = input.canonicalUrl && input.bodyMarkdown.trim() ? `\n\n---\n\n*Originally published at [${displayUrl(input.canonicalUrl)}](${input.canonicalUrl}).*\n` : '';
    const payload: DraftPayload = {
      title: input.title.trim(),
      description: input.description.trim(),
      tags: tagReport.sent,
      canonicalUrl: input.canonicalUrl,
      coverImageUrl: input.coverImageUrl,
      series: input.series?.trim() ? input.series.trim() : null,
      bodyMarkdown: `${input.bodyMarkdown.replace(/\s+$/, '')}${footer}`,
    };
    return { payload, tagReport };
  },

  tags(original: string[]) {
    return sanitizeTags(original, (raw) => devtoTag(raw, PUBLISHING_LIMITS.devtoTagChars));
  },

  validate(payload: DraftPayload): LintIssue[] {
    const issues = lintPayload(payload, { hasLocalCover: false, maxBodyChars: PUBLISHING_LIMITS.devtoBodyChars, platformName: 'DEV.to' });
    const max = PLATFORMS.devto.capabilities.tagsMax;
    if (payload.tags.length > max) {
      issues.push({
        code: 'tags_too_many',
        severity: 'error',
        message: `DEV.to takes at most ${max} tags and this has ${payload.tags.length} after cleaning. Remove ${payload.tags.length - max} in the article’s details.`,
        items: payload.tags,
      });
    }
    if (payload.title.length > PUBLISHING_LIMITS.devtoTitleWarn) {
      issues.push({ code: 'title_long', severity: 'warning', message: `The title is ${payload.title.length} characters. DEV.to is reported to cap titles near ${PUBLISHING_LIMITS.devtoTitleWarn}; this limit is not documented.` });
    }
    if (payload.series && payload.series.length > PUBLISHING_LIMITS.series) {
      issues.push({ code: 'series_long', severity: 'error', message: `The series name is longer than ${PUBLISHING_LIMITS.series} characters.` });
    }
    const found = analyzeBody(payload.bodyMarkdown);
    if (found.hasMermaid) {
      issues.push({ code: 'mermaid_unsupported', severity: 'warning', message: 'Mermaid diagrams are drawn in this app but DEV.to will show them as code blocks.' });
    }
    if (found.liquidLike.length > 0) {
      issues.push({
        code: 'liquid_like',
        severity: 'warning',
        message: 'DEV.to reads {% ... %} and {{ ... }} as template tags. Text like this outside code may not appear as written.',
        items: found.liquidLike,
      });
    }
    return issues;
  },

  preview(payload, published) {
    return devtoBody(payload, published);
  },

  async health(ctx): Promise<HealthResult> {
    const res = expectOk(ctx, await call(ctx, 'GET', '/api/users/me'));
    const username = parseObject(res.text)?.username;
    if (typeof username !== 'string' || !username) {
      throw new PlatformError('protocol', 'DEV.to answered, but did not say whose key this is.', { httpStatus: res.status });
    }
    return { who: `@${username}` };
  },

  async stage(ctx, draft): Promise<StageResult> {
    const body = devtoBody(draft.payload, false);
    // Spread last so nothing above can switch it on.
    body.article.published = false;

    let remoteId = draft.remoteId;
    if (remoteId !== null) {
      if (!isDevtoId(remoteId)) throw new PlatformError('config', 'The saved DEV.to article id is not valid. Stage a new private draft.', { notSent: true });
      // Read first: editing a live article is a publish and needs its own approval.
      if (await findIn(ctx, 'published', remoteId)) {
        throw new PlatformError('validation', 'This article is already live on DEV.to. Changing a live article is a publish and needs its own approval, so it was not touched.', { notSent: true });
      }
      if ((await findIn(ctx, 'unpublished', remoteId)) === null) remoteId = null;
    }

    const res =
      remoteId === null
        ? expectOk(ctx, await call(ctx, 'POST', '/api/articles', body))
        : expectOk(ctx, await call(ctx, 'PUT', `/api/articles/${remoteId}`, body));
    const article = parseObject(res.text);
    if (article?.published === true) {
      throw new PlatformError('protocol', 'DEV.to answered a private-draft request with a live article. Check your DEV dashboard now.', { httpStatus: res.status });
    }
    const id = article?.id ?? remoteId;
    if (id === undefined || id === null) throw new PlatformError('protocol', 'DEV.to did not return an article id.', { httpStatus: res.status });
    return { remoteId: String(id), previewUrl: typeof article?.url === 'string' ? article.url : null };
  },

  async publish(ctx, draft): Promise<PublishResult> {
    if (!isDevtoId(draft.remoteId)) {
      throw new PlatformError('config', 'There is no private DEV.to draft to publish. Stage it first.', { notSent: true });
    }
    // The one place `published: true` is sent.
    const body = devtoBody(draft.payload, true);
    const res = expectOk(ctx, await call(ctx, 'PUT', `/api/articles/${draft.remoteId}`, body));
    const article = parseObject(res.text);
    if (!article) throw new PlatformError('protocol', 'DEV.to accepted the request but its answer could not be read. It may be live.', { httpStatus: res.status });
    if (article.published === false) {
      throw new PlatformError('protocol', 'DEV.to accepted the request but still reports the article as private.', { httpStatus: res.status });
    }
    return { remoteId: String(article.id ?? draft.remoteId), remoteUrl: typeof article.url === 'string' ? article.url : null };
  },

  async check(ctx, draft): Promise<CheckResult> {
    if (!isDevtoId(draft.remoteId)) return { state: 'not_found' };
    const live = await findIn(ctx, 'published', draft.remoteId);
    if (live) return { state: 'published', remoteId: String(live.id), remoteUrl: typeof live.url === 'string' ? live.url : null };
    if (await findIn(ctx, 'unpublished', draft.remoteId)) return { state: 'private' };
    return { state: 'not_found' };
  },
};

function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
    return `${parsed.host}${path}`;
  } catch {
    return url;
  }
}
