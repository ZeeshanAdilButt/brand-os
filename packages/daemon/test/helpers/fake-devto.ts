import { fixture } from './fake-buffer.js';

type Json = Record<string, unknown>;

export interface DevtoReq {
  method: string;
  /** Path without the query string. */
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  /** The parsed JSON body, when there was one. */
  body: unknown;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A scripted dev.to (Forem) API: `users/me`, `POST /api/articles`, `PUT /api/articles/:id` and the
 * two "my articles" lists. Articles live in memory, so a stage really creates a private article and a
 * test can flip one to published the way the dev.to website would. Every request is recorded.
 */
export class FakeDevto {
  readonly requests: DevtoReq[] = [];
  readonly articles = new Map<number, Json>();
  #nextId = 2001;

  constructor(readonly apiKey: string) {}

  readonly fetchFn: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body: unknown = typeof init?.body === 'string' && init.body !== '' ? JSON.parse(init.body) : undefined;
    this.requests.push({ method, path: url.pathname, query: url.searchParams, headers, body });
    return Promise.resolve(headers['api-key'] === this.apiKey ? this.#answer(method, url, body) : json(401, fixture('devto-error-401')));
  };

  #answer(method: string, url: URL, body: unknown): Response {
    const path = url.pathname;
    if (method === 'GET' && path === '/api/users/me') return json(200, fixture('devto-user-me'));
    if (method === 'GET' && path === '/api/articles/me/unpublished') return json(200, this.#list(false));
    if (method === 'GET' && path === '/api/articles/me/published') return json(200, this.#list(true));
    const article = ((body as Json | undefined)?.['article'] ?? {}) as Json;
    if (method === 'POST' && path === '/api/articles') {
      const id = this.#nextId++;
      const created = { ...fixture<Json>('devto-article-created'), id, ...article, published: false };
      this.articles.set(id, created);
      return json(201, created);
    }
    const put = /^\/api\/articles\/(\d+)$/.exec(path);
    if (method === 'PUT' && put !== null) {
      const id = Number(put[1]);
      const current = this.articles.get(id);
      if (current === undefined) return json(404, { error: 'not found', status: 404 });
      const updated: Json = { ...current, ...article };
      if (updated['published'] === true) updated['url'] = `https://dev.to/owner_test/live-article-${id}`;
      this.articles.set(id, updated);
      return json(200, updated);
    }
    return json(404, { error: `fake dev.to has no ${method} ${path}`, status: 404 });
  }

  #list(published: boolean): Json[] {
    return [...this.articles.values()].filter((a) => (a['published'] === true) === published);
  }

  /** The author publishes the article on dev.to itself (outside this tool). */
  markPublished(id: number): void {
    const current = this.articles.get(id);
    if (current === undefined) throw new Error(`no fake dev.to article ${id}`);
    this.articles.set(id, { ...current, published: true, url: `https://dev.to/owner_test/live-article-${id}` });
  }

  calls(method: string, path?: string | RegExp): DevtoReq[] {
    return this.requests.filter(
      (r) => r.method === method && (path === undefined || (typeof path === 'string' ? r.path === path : path.test(r.path))),
    );
  }
}
