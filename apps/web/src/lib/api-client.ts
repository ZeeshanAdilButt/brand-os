import type { ArticleDTO } from './articles';
import type { Draft, SendOutcome, SendRequest } from './autosave';

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string; code?: string | undefined; fields: Record<string, string>; data?: unknown; network: boolean };

interface ApiInit {
  method?: string;
  json?: unknown;
  body?: FormData;
  keepalive?: boolean;
  signal?: AbortSignal;
}

/** Request to our own API. Never throws: a failed connection comes back as `network: true`. */
export async function api<T>(path: string, init: ApiInit = {}): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      method: init.method ?? (init.json !== undefined || init.body ? 'POST' : 'GET'),
      headers: init.json !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: init.body ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined),
      keepalive: init.keepalive,
      signal: init.signal,
    });
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    if (res.ok) return { ok: true, status: res.status, data: payload as T };
    const body = (payload ?? {}) as { error?: string; code?: string; fields?: Record<string, string>; data?: unknown };
    return {
      ok: false,
      status: res.status,
      error: body.error ?? `The server answered ${res.status}.`,
      code: body.code,
      fields: body.fields ?? {},
      data: body.data,
      network: false,
    };
  } catch {
    return { ok: false, status: 0, error: 'Could not reach the server.', fields: {}, network: true };
  }
}

export function toDraft(article: ArticleDTO): Draft {
  return {
    title: article.title,
    slug: article.slug,
    description: article.description,
    tags: article.tags,
    canonicalUrl: article.canonicalUrl,
    coverAssetId: article.coverAssetId,
    status: article.status,
    bodyMarkdown: article.bodyMarkdown,
  };
}

/** The controller's `send`: one PATCH, turned into an outcome the controller understands. */
export async function sendSave(articleId: string, request: SendRequest): Promise<SendOutcome> {
  const body = { expectedRevision: request.expectedRevision, reason: request.reason, ...request.patch };
  const result = await api<ArticleDTO>(`/api/articles/${articleId}`, {
    method: 'PATCH',
    json: body,
    // Lets a save started as the page closes finish; browsers cap such bodies at 64 KB.
    keepalive: JSON.stringify(body).length < 60_000,
  });
  if (result.ok) return { kind: 'ok', revision: result.data.revision, draft: toDraft(result.data) };
  if (result.network) {
    return { kind: 'error', message: 'You appear to be offline. Your changes are kept in this tab and will be saved when the connection returns.', offline: true };
  }
  if (result.status === 409 && result.code === 'conflict') {
    const current = (result.data as { current?: ArticleDTO } | undefined)?.current;
    if (current) return { kind: 'conflict', revision: current.revision, draft: toDraft(current) };
  }
  if (result.status === 400) return { kind: 'invalid', message: result.error, fields: result.fields };
  if (result.status === 401) return { kind: 'error', message: 'You are signed out. Sign in again; your changes are still in this tab.', offline: false };
  if (result.status === 404) return { kind: 'error', message: 'This article no longer exists.', offline: false };
  return { kind: 'error', message: 'The server could not save. Trying again shortly.', offline: false };
}
