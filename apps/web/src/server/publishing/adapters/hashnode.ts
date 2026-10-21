import { PLATFORMS, PUBLISHING_LIMITS, type DraftPayload, type LintIssue } from '../../../lib/publishing';
import { PlatformError } from '../errors';
import { clean, failureFor, parseObject, send, type RequestOptions } from '../http';
import { lintPayload } from '../lint';
import { hashnodeSlug, sanitizeTags } from '../tags';
import type { AdaptInput, AdapterContext, CheckResult, HealthResult, PlatformAdapter, PublishResult, StageResult } from './types';

/**
 * Hashnode through its GraphQL API. LIVE-UNVERIFIED: written from the official agent skill and schema
 * (github.com/Hashnode/gql-skill, checked 2026-10-21, see INTEGRATIONS.md) and never run against a real
 * account.
 *
 * - One endpoint, `POST {base}/`, `Authorization: Bearer <personal access token>`, `x-hashnode-client`.
 * - A draft is created with `createDraft`, changed with `updateDraft`, and made public by `publishDraft`
 *   (which takes only the draft id). So `publish()` first writes the approved payload into the draft with
 *   `updateDraft`, then publishes it: the post is exactly what was approved.
 * - Every write needs a Pro plan on the publication. A refusal says `FORBIDDEN` with a message about it.
 * - Errors arrive as HTTP 200 with an `errors[]` array whose `extensions.code` is UNAUTHENTICATED,
 *   FORBIDDEN, NOT_FOUND, BAD_USER_INPUT or INTERNAL_SERVER_ERROR.
 */

export const HASHNODE_DEFAULT_BASE = 'https://gql-beta.hashnode.com/';

type Json = Record<string, unknown>;

function requestOptions(ctx: AdapterContext): RequestOptions {
  return { fetch: ctx.fetch, timeoutMs: ctx.timeoutMs, secrets: [ctx.secret], now: ctx.now };
}

interface GqlError {
  message?: unknown;
  extensions?: { code?: unknown };
}

function fromGraphqlError(error: GqlError, secrets: readonly string[]): PlatformError {
  const code = typeof error.extensions?.code === 'string' ? error.extensions.code : '';
  const text = typeof error.message === 'string' ? clean(error.message, secrets) : '';
  if (code === 'UNAUTHENTICATED') return new PlatformError('auth', 'Hashnode did not accept the token.', { detail: text || null });
  if (code === 'FORBIDDEN') {
    if (/pro plan|upgrade/i.test(text)) {
      return new PlatformError('forbidden_plan', 'This Hashnode publication does not have an active Pro plan, and the API needs one for every write. Upgrade it in your Hashnode dashboard.', { detail: text });
    }
    return new PlatformError('auth', `Hashnode says this token is not allowed to do that${text ? `: ${text}` : '.'}`, { detail: text || null });
  }
  if (code === 'NOT_FOUND') return new PlatformError('not_found', `Hashnode could not find that item${text ? `: ${text}` : '.'}`, { detail: text || null });
  if (code === 'BAD_USER_INPUT') return new PlatformError('validation', `Hashnode refused the request${text ? `: ${text}` : '.'}`, { detail: text || null });
  if (code === 'INTERNAL_SERVER_ERROR') return new PlatformError('server', 'Hashnode had a problem on its side.', { detail: text || null });
  return new PlatformError('validation', `Hashnode reported a problem${text ? `: ${text}` : '.'}`, { detail: text || null });
}

/** Run one GraphQL operation and return its `data`, or throw a classified PlatformError. */
async function gql(ctx: AdapterContext, query: string, variables: Json): Promise<Json> {
  const options = requestOptions(ctx);
  const res = await send(options, ctx.baseUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ctx.secret}`,
      'content-type': 'application/json',
      'x-hashnode-client': 'brand-os',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw failureFor('Hashnode', res, options);
  const body = parseObject(res.text);
  if (!body) throw new PlatformError('protocol', 'Hashnode answered with something that is not JSON.', { httpStatus: res.status });
  const data = body.data && typeof body.data === 'object' ? (body.data as Json) : null;
  const errors = Array.isArray(body.errors) ? (body.errors as GqlError[]) : [];
  if (errors.length > 0 && (!data || Object.values(data).every((v) => v === null))) throw fromGraphqlError(errors[0]!, options.secrets);
  if (!data) throw new PlatformError('protocol', 'Hashnode answered without data.', { httpStatus: res.status });
  return data;
}

const QUERY_ME = `query Me { me { id username name publications(first: 20) { edges { node { id title url isTeam } } } } }`;
const QUERY_DRAFT = `query Draft($id: ObjectId!) { draft(id: $id) { id } }`;
const QUERY_POSTS = `query Posts($id: ObjectId!) { publication(id: $id) { posts(first: 20) { edges { node { id title url slug canonicalUrl } } } } }`;
const MUTATION_CREATE = `mutation CreateDraft($input: CreateDraftInput!) { createDraft(input: $input) { draft { id slug } } }`;
const MUTATION_UPDATE = `mutation UpdateDraft($input: UpdateDraftInput!) { updateDraft(input: $input) { draft { id slug } } }`;
const MUTATION_PUBLISH = `mutation PublishDraft($input: PublishDraftInput!) { publishDraft(input: $input) { post { id slug url } } }`;

/** The draft fields shared by createDraft and updateDraft. */
function draftFields(payload: DraftPayload): Json {
  return {
    title: payload.title,
    contentMarkdown: payload.bodyMarkdown,
    tags: payload.tags.map((slug) => ({ slug })),
    originalArticleURL: payload.canonicalUrl,
    ...(payload.coverImageUrl ? { coverImageOptions: { coverImageURL: payload.coverImageUrl } } : {}),
    ...(payload.description ? { metaTags: { description: payload.description } } : {}),
  };
}

function publicationOf(ctx: AdapterContext): string {
  const id = ctx.config.publicationId;
  if (!id) throw new PlatformError('config', 'No Hashnode publication is selected. Reconnect Hashnode in Settings and choose one.', { notSent: true });
  return id;
}

function idOf(data: Json, mutation: string, field: 'draft' | 'post'): { id: string; url: string | null } {
  const node = (data[mutation] as Json | null | undefined)?.[field] as Json | null | undefined;
  if (!node || typeof node.id !== 'string') {
    throw new PlatformError('protocol', `Hashnode answered ${mutation} without a ${field} id.`);
  }
  return { id: node.id, url: typeof node.url === 'string' ? node.url : null };
}

export const hashnodeAdapter: PlatformAdapter = {
  id: 'hashnode',
  info: PLATFORMS.hashnode,

  adapt(input: AdaptInput) {
    const tagReport = sanitizeTags(input.tags, (raw) => hashnodeSlug(raw, PUBLISHING_LIMITS.hashnodeTagChars));
    const payload: DraftPayload = {
      title: input.title.trim(),
      description: input.description.trim(),
      tags: tagReport.sent,
      canonicalUrl: input.canonicalUrl,
      coverImageUrl: input.coverImageUrl,
      // Series needs an existing series id on Hashnode, which is not looked up yet.
      series: input.series?.trim() ? input.series.trim() : null,
      bodyMarkdown: input.bodyMarkdown.replace(/\s+$/, '') + (input.bodyMarkdown.trim() ? '\n' : ''),
    };
    return { payload, tagReport };
  },

  validate(payload: DraftPayload): LintIssue[] {
    const issues = lintPayload(payload, { hasLocalCover: false, maxBodyChars: PUBLISHING_LIMITS.hashnodeBodyChars, platformName: 'Hashnode' });
    const max = PLATFORMS.hashnode.capabilities.tagsMax;
    if (payload.tags.length > max) {
      issues.push({ code: 'tags_too_many', severity: 'error', message: `Hashnode takes at most ${max} tags and this has ${payload.tags.length}. Remove ${payload.tags.length - max} in the article’s details.`, items: payload.tags });
    }
    if (payload.series) {
      issues.push({ code: 'series_unsupported', severity: 'warning', message: 'Series is not sent to Hashnode yet: it needs an existing series on the publication. The series name is ignored.' });
    }
    return issues;
  },

  preview(payload, published, config, remoteId) {
    const draftId = remoteId ?? '<the private draft>';
    if (!published) {
      return { operation: remoteId ? 'updateDraft' : 'createDraft', variables: { input: remoteId ? { draftId, ...draftFields(payload) } : { publicationId: config.publicationId ?? '<publication>', ...draftFields(payload) } } };
    }
    return {
      steps: [
        { operation: 'updateDraft', variables: { input: { draftId, ...draftFields(payload) } } },
        { operation: 'publishDraft', variables: { input: { draftId } } },
      ],
    };
  },

  async health(ctx): Promise<HealthResult> {
    const data = await gql(ctx, QUERY_ME, {});
    const me = data.me as Json | null;
    if (!me || typeof me.username !== 'string') throw new PlatformError('protocol', 'Hashnode answered, but did not say whose token this is.');
    const edges = ((me.publications as Json | undefined)?.edges ?? []) as { node?: Json }[];
    const publications = edges
      .map((edge) => edge.node)
      .filter((node): node is Json => !!node && typeof node.id === 'string')
      .map((node) => ({ id: String(node.id), title: typeof node.title === 'string' ? node.title : String(node.id) }));
    if (publications.length === 0) {
      throw new PlatformError('validation', 'This Hashnode account has no publication to publish to. Create one on Hashnode first.');
    }
    const keep = publications.find((p) => p.id === ctx.config.publicationId) ?? publications[0]!;
    return { who: `@${me.username}`, config: { publicationId: keep.id, publicationTitle: keep.title, publications } };
  },

  async stage(ctx, draft): Promise<StageResult> {
    const publicationId = publicationOf(ctx);
    if (draft.remoteId) {
      try {
        const data = await gql(ctx, MUTATION_UPDATE, { input: { draftId: draft.remoteId, ...draftFields(draft.payload) } });
        const { id } = idOf(data, 'updateDraft', 'draft');
        return { remoteId: id, previewUrl: null };
      } catch (err) {
        // The private copy is gone (deleted, or published elsewhere): make a new private one. Nothing live is touched.
        if (!(err instanceof PlatformError) || err.kind !== 'not_found') throw err;
      }
    }
    const data = await gql(ctx, MUTATION_CREATE, { input: { publicationId, ...draftFields(draft.payload) } });
    const { id } = idOf(data, 'createDraft', 'draft');
    return { remoteId: id, previewUrl: null };
  },

  async publish(ctx, draft): Promise<PublishResult> {
    if (!draft.remoteId) throw new PlatformError('config', 'There is no private Hashnode draft to publish. Stage it first.', { notSent: true });
    // Step 1 only edits the private draft, so a failure here means nothing is public.
    try {
      await gql(ctx, MUTATION_UPDATE, { input: { draftId: draft.remoteId, ...draftFields(draft.payload) } });
    } catch (err) {
      throw err instanceof PlatformError ? err.asNotSent() : err;
    }
    // Step 2 is the one request that can make it public.
    const data = await gql(ctx, MUTATION_PUBLISH, { input: { draftId: draft.remoteId } });
    const post = idOf(data, 'publishDraft', 'post');
    return { remoteId: post.id, remoteUrl: post.url };
  },

  async check(ctx, draft): Promise<CheckResult> {
    if (!draft.remoteId) return { state: 'not_found' };
    try {
      await gql(ctx, QUERY_DRAFT, { id: draft.remoteId });
      return { state: 'private' };
    } catch (err) {
      if (!(err instanceof PlatformError) || err.kind !== 'not_found') throw err;
    }
    // A published draft is removed, so look for the post by title and canonical URL among the latest posts.
    const publicationId = publicationOf(ctx);
    const data = await gql(ctx, QUERY_POSTS, { id: publicationId });
    const edges = ((((data.publication as Json | null)?.posts as Json | undefined)?.edges ?? []) as { node?: Json }[]).map((e) => e.node).filter((n): n is Json => !!n);
    const hit = edges.find((node) => node.title === draft.payload.title && (!draft.payload.canonicalUrl || node.canonicalUrl === draft.payload.canonicalUrl));
    if (hit && typeof hit.id === 'string') return { state: 'published', remoteId: hit.id, remoteUrl: typeof hit.url === 'string' ? hit.url : null };
    return { state: 'not_found' };
  },
};
