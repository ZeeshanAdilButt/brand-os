/**
 * A small typed client for the Brand OS agent API (/api/agent/*). The credential is the only identity
 * it sends: no owner id exists anywhere in these calls, because the server decides whose data a request
 * touches from the credential alone. Every failure becomes an ApiError whose message has the credential
 * removed.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly data?: unknown,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface BrandApiOptions {
  /** Where Brand OS runs, for example http://127.0.0.1:3100 or a hosted address. */
  baseUrl: string;
  credential: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export interface ArticleFields {
  title?: string;
  slug?: string;
  description?: string;
  tags?: string[];
  canonicalUrl?: string | null;
  status?: 'draft' | 'ready' | 'archived';
  bodyMarkdown?: string;
}

/** The calls the tools make. A fake of this is all the tool tests need. */
export interface BrandApi {
  me(): Promise<unknown>;
  searchKnowledge(query: { q?: string; kind?: string; limit?: number }): Promise<unknown>;
  listArticles(query: { q?: string; status?: string; limit?: number }): Promise<unknown>;
  getArticle(id: string): Promise<unknown>;
  createArticle(fields: ArticleFields): Promise<unknown>;
  updateArticle(id: string, expectedRevision: number, fields: ArticleFields): Promise<unknown>;
  listAiTasks(query: { status?: string; limit?: number }): Promise<unknown>;
  getAiTask(id: string): Promise<unknown>;
  submitAiTaskResult(id: string, operations: unknown[]): Promise<unknown>;
  createPlatformDraft(input: { articleId: string; platform: string; coverImageUrl?: string | null; series?: string | null }): Promise<unknown>;
  listPlatformDrafts(query: { articleId?: string; status?: string; limit?: number }): Promise<unknown>;
  getPlatformDraft(id: string): Promise<unknown>;
  stageRemoteDraft(id: string): Promise<unknown>;
  requestPublishApproval(id: string): Promise<unknown>;
  getPublicationStatus(id: string): Promise<unknown>;
}

/** Remove the credential, and anything shaped like an auth header, from text that may be shown. */
export function scrub(text: string, credential: string): string {
  let out = credential.length >= 6 ? text.split(credential).join('[credential]') : text;
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [credential]');
  return out;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : '';
}

export function createBrandApi(options: BrandApiOptions): BrandApi {
  const base = options.baseUrl.replace(/\/+$/, '');
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchFn(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${options.credential}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      let origin = base;
      try {
        origin = new URL(base).origin;
      } catch {
        /* keep the raw text */
      }
      throw new ApiError(0, timedOut ? 'timeout' : 'unreachable', timedOut ? `Brand OS at ${origin} did not answer in time.` : `Could not reach Brand OS at ${origin}. Is it running?`);
    }
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (response.ok) return payload;
    const record = (payload && typeof payload === 'object' ? payload : {}) as { error?: unknown; code?: unknown; data?: unknown };
    const message = typeof record.error === 'string' ? record.error : `Brand OS answered ${response.status}.`;
    const retry = Number(response.headers.get('retry-after'));
    throw new ApiError(
      response.status,
      typeof record.code === 'string' ? record.code : `http_${response.status}`,
      scrub(message, options.credential),
      record.data,
      Number.isFinite(retry) && retry > 0 ? retry : undefined,
    );
  }

  return {
    me: () => call('GET', '/api/agent/me'),
    searchKnowledge: (q) => call('GET', `/api/agent/knowledge${query({ q: q.q, kind: q.kind, limit: q.limit })}`),
    listArticles: (q) => call('GET', `/api/agent/articles${query({ q: q.q, status: q.status, limit: q.limit })}`),
    getArticle: (id) => call('GET', `/api/agent/articles/${encodeURIComponent(id)}`),
    createArticle: (fields) => call('POST', '/api/agent/articles', fields),
    updateArticle: (id, expectedRevision, fields) => call('PATCH', `/api/agent/articles/${encodeURIComponent(id)}`, { expectedRevision, ...fields }),
    listAiTasks: (q) => call('GET', `/api/agent/ai-tasks${query({ status: q.status, limit: q.limit })}`),
    getAiTask: (id) => call('GET', `/api/agent/ai-tasks/${encodeURIComponent(id)}`),
    submitAiTaskResult: (id, operations) => call('POST', `/api/agent/ai-tasks/${encodeURIComponent(id)}/result`, { operations }),
    createPlatformDraft: (input) => call('POST', '/api/agent/platform-drafts', input),
    listPlatformDrafts: (q) => call('GET', `/api/agent/platform-drafts${query({ articleId: q.articleId, status: q.status, limit: q.limit })}`),
    getPlatformDraft: (id) => call('GET', `/api/agent/platform-drafts/${encodeURIComponent(id)}`),
    stageRemoteDraft: (id) => call('POST', `/api/agent/platform-drafts/${encodeURIComponent(id)}/stage`, {}),
    requestPublishApproval: (id) => call('POST', `/api/agent/platform-drafts/${encodeURIComponent(id)}/request-approval`, {}),
    getPublicationStatus: (id) => call('GET', `/api/agent/platform-drafts/${encodeURIComponent(id)}/status`),
  };
}
