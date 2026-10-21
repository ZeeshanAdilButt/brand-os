import type { Draft, DevtoPayload } from '@cph/core';
import { GateError } from '../gate/errors.js';
import { assertVerifiedApproval, type VerifiedApproval } from '../gate/verified.js';
import { redact } from '../secrets/redact.js';
import type { SecretStore } from '../secrets/secret-store.js';
import { parseRetryAfter, platformFetchOptions, PlatformError, StageRefused, type Health, type Publication, type RemoteRef, type Route } from './types.js';

const BASE_URL = 'https://dev.to';
const PAGE_SIZE = 100;
/** Upper bound on list pages read while looking for one article; hitting it reads as "not found". */
const MAX_PAGES = 50;
const MAX_BODY_CHARS = 4000;
const STAGEABLE: ReadonlySet<string> = new Set(['draft', 'staged']);
const LIVE_REFUSAL = 'article is live on dev.to; editing it is a publish and needs its own approval';

export interface DevtoRouteDeps {
  secrets: SecretStore;
  fetchFn: typeof fetch;
  now: () => Date;
  /** Records that a draft failed, with the reason. The route never changes a draft's status otherwise. */
  markFailed: (draftId: string, reason: string) => void;
}

interface HttpResult {
  status: number;
  ok: boolean;
  headers: Headers;
  text: string;
}

type Json = Record<string, unknown>;

/**
 * dev.to through its own API. `stage` keeps the article private and refuses to touch a live one;
 * `publish` is the only method that can make an article public, and it needs a `VerifiedApproval`
 * that matches the draft. No method retries: a publish that fails is reported once, never repeated.
 *
 * Every error text passes through the key scrub and `redact`, so the API key never appears in a
 * thrown message, body or stack.
 */
export class DevtoRoute implements Route<DevtoPayload> {
  readonly kind = 'direct' as const;
  readonly platform = 'devto' as const;
  readonly #deps: DevtoRouteDeps;

  constructor(deps: DevtoRouteDeps) {
    this.#deps = deps;
  }

  async health(account: string): Promise<Health> {
    const apiKey = this.#storedKey(account);
    if (apiKey === null) {
      return { state: 'not_configured', nextAction: 'Connect dev.to with an API key from dev.to/settings/extensions.' };
    }
    return this.#probe(apiKey);
  }

  async connect(account: string, input: Record<string, string>): Promise<Health> {
    const apiKey = input['apiKey'];
    if (apiKey === undefined || apiKey.trim() === '') {
      return { state: 'not_configured', detail: 'An apiKey is required.', nextAction: 'Paste a dev.to API key.' };
    }
    const health = await this.#probe(apiKey);
    if (health.state === 'connected') this.#deps.secrets.put('devto', account, { apiKey });
    return health;
  }

  async stage(d: Draft<DevtoPayload>): Promise<RemoteRef> {
    if (!STAGEABLE.has(d.status)) {
      throw new StageRefused(`cannot stage a draft in status "${d.status}"; only draft or staged drafts can be staged`);
    }
    const remoteId = d.remoteRef;
    if (remoteId !== undefined && !/^\d+$/.test(remoteId)) {
      throw new StageRefused(`remote reference "${remoteId}" is not a dev.to article id`);
    }
    const apiKey = this.#requireKey(d.account);
    // Spread last: the private flag overrides whatever the payload object carries.
    const body = { article: { ...this.#article(d.payload), published: false } };

    if (remoteId === undefined) {
      const created = this.#expectOk(await this.#send('POST', '/api/articles', apiKey, body), 'POST /api/articles', apiKey);
      return this.#privateRef(created.text, undefined);
    }

    // Re-stage: read the article back first. Editing a live article is a publish.
    const current = await this.#findArticle(apiKey, 'unpublished', remoteId);
    if (current === null || current['published'] === true) {
      this.#deps.markFailed(d.id, LIVE_REFUSAL);
      throw new StageRefused(LIVE_REFUSAL);
    }
    const path = `/api/articles/${remoteId}`;
    const updated = this.#expectOk(await this.#send('PUT', path, apiKey, body), `PUT ${path}`, apiKey);
    return this.#privateRef(updated.text, remoteId);
  }

  async publish(d: Draft<DevtoPayload>, a: VerifiedApproval): Promise<Publication> {
    assertVerifiedApproval(a);
    if (a.draftId !== d.id) {
      throw new GateError('NO_APPROVAL', 'the approval was granted for a different draft', { draftId: d.id });
    }
    if (a.payloadSha256 !== d.payloadSha256) {
      throw new GateError('HASH_MISMATCH', 'the approval does not cover the draft as it is now', { draftId: d.id });
    }
    const remoteId = d.remoteRef;
    if (remoteId === undefined || !/^\d+$/.test(remoteId)) {
      throw new Error('this draft has no staged dev.to article; stage it before publishing');
    }
    const apiKey = this.#requireKey(d.account);
    const path = `/api/articles/${remoteId}`;
    const body = { article: { ...this.#article(d.payload), published: true } };

    // One request, no retry: a failure here is reported, and recovery goes through checkOnPlatform.
    const done = this.#expectOk(await this.#send('PUT', path, apiKey, body), `PUT ${path}`, apiKey);
    const article = parseJson(done.text);
    if (article?.['published'] === false) {
      throw new Error('dev.to accepted the request but reports the article as still private');
    }
    const publication: Publication = { remoteId: String(article?.['id'] ?? remoteId), costUsd: 0 };
    const url = article?.['url'];
    return typeof url === 'string' ? { ...publication, remoteUrl: url } : publication;
  }

  async checkOnPlatform(d: Draft<DevtoPayload>): Promise<'published' | 'not_found' | 'unknown'> {
    const remoteId = d.remoteRef;
    if (remoteId === undefined || !/^\d+$/.test(remoteId)) return 'unknown';
    const apiKey = this.#requireKey(d.account);
    if ((await this.#findArticle(apiKey, 'published', remoteId)) !== null) return 'published';
    if ((await this.#findArticle(apiKey, 'unpublished', remoteId)) !== null) return 'not_found';
    return 'unknown';
  }

  costEstimate(_d: Draft<DevtoPayload>): number {
    return 0;
  }

  // ------------------------------------------------------------------ internals

  /** The article fields as hashed, with tags in the comma-separated form the API takes. */
  #article(p: DevtoPayload): Json {
    return { ...p, tags: p.tags.join(',') };
  }

  #storedKey(account: string): string | null {
    const apiKey = this.#deps.secrets.get('devto', account)?.['apiKey'];
    return apiKey === undefined || apiKey === '' ? null : apiKey;
  }

  #requireKey(account: string): string {
    const apiKey = this.#storedKey(account);
    if (apiKey === null) throw new Error(`dev.to is not connected for account "${account}"; connect it first`);
    return apiKey;
  }

  async #probe(apiKey: string): Promise<Health> {
    const res = await this.#send('GET', '/api/users/me', apiKey);
    if (res.status === 401 || res.status === 403) {
      return { state: 'needs_reconnect', detail: 'dev.to rejected the API key.', nextAction: 'Create a new API key and reconnect.' };
    }
    this.#expectOk(res, 'GET /api/users/me', apiKey);
    const username = parseJson(res.text)?.['username'];
    return typeof username === 'string' ? { state: 'connected', who: `@${username}` } : { state: 'connected' };
  }

  /** The private article's id and preview link; refuses an answer that says the article is live. */
  #privateRef(text: string, fallbackId: string | undefined): RemoteRef {
    const article = parseJson(text);
    if (article?.['published'] === true) {
      throw new Error('dev.to answered a stage with a live article; stopping so nothing else is sent');
    }
    const id = article?.['id'] ?? fallbackId;
    if (id === undefined) throw new Error('dev.to did not return an article id');
    const url = article?.['url'];
    return typeof url === 'string' ? { remoteId: String(id), previewUrl: url } : { remoteId: String(id) };
  }

  /** Pages through `/api/articles/me/<list>` until the article shows up. */
  async #findArticle(apiKey: string, list: 'published' | 'unpublished', id: string): Promise<Json | null> {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const path = `/api/articles/me/${list}?page=${page}&per_page=${PAGE_SIZE}`;
      const res = this.#expectOk(await this.#send('GET', path, apiKey), `GET ${path}`, apiKey);
      const items: unknown = JSON.parse(res.text);
      if (!Array.isArray(items)) throw new Error(`dev.to returned an unexpected shape for GET ${path}`);
      const hit = items.find((item): item is Json => typeof item === 'object' && item !== null && String((item as Json)['id']) === id);
      if (hit !== undefined) return hit;
      if (items.length < PAGE_SIZE) return null;
    }
    return null;
  }

  async #send(method: string, path: string, apiKey: string, body?: unknown): Promise<HttpResult> {
    const init: RequestInit = {
      method,
      ...platformFetchOptions(),
      headers: {
        'api-key': apiKey,
        accept: 'application/vnd.forem.api-v1+json',
        'content-type': 'application/json',
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    try {
      const res = await this.#deps.fetchFn(`${BASE_URL}${path}`, init);
      return { status: res.status, ok: res.ok, headers: res.headers, text: await res.text() };
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`dev.to request ${method} ${pathOnly(path)} failed: ${this.#scrub(reason, apiKey)}`);
    }
  }

  #expectOk(res: HttpResult, label: string, apiKey: string): HttpResult {
    if (res.ok) return res;
    const body = this.#scrub(res.text, apiKey).slice(0, MAX_BODY_CHARS);
    throw new PlatformError(
      `dev.to ${label} failed with ${res.status}${body === '' ? '' : `: ${body}`}`,
      res.status,
      parseRetryAfter(res.headers.get('retry-after'), this.#deps.now()),
      body,
    );
  }

  #scrub(text: string, apiKey: string): string {
    return redact(apiKey === '' ? text : text.split(apiKey).join('[REDACTED]'));
  }
}

const pathOnly = (path: string): string => path.split('?')[0] ?? path;

function parseJson(text: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
  } catch {
    return undefined;
  }
}
