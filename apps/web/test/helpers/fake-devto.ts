import http from 'node:http';

/**
 * A small fake of the Forem API v1 pieces the DEV.to adapter uses. It is a test helper only: tests call
 * `fake.fetch` as an injected fetch, and `serveFakeDevto` puts the same logic behind a local HTTP port for
 * the manual browser run. It never reaches the network.
 *
 * Failure injection: `fake.inject({ match, ... })` queues a one-time behavior for the next request that
 * matches. `afterApply: true` applies the change first and then drops the answer, which is the "it may have
 * gone out" case.
 */

export interface FakeArticle {
  id: number;
  title: string;
  body_markdown: string;
  description: string;
  published: boolean;
  tags: string;
  canonical_url: string | null;
  main_image: string | null;
  series: string | null;
  slug: string;
  created_at: string;
  published_at: string | null;
}

export interface LoggedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface Injection {
  /** Method and path pattern, for example `/PUT \/api\/articles\/\d+/`. Tested against `METHOD path`. */
  match: RegExp;
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Never answer (until the caller's signal aborts). */
  hang?: boolean;
  /** Throw a network error instead of answering. */
  drop?: boolean;
  /** Answer with a redirect to this location. */
  redirect?: string;
  /** Apply the request's effect, then misbehave as above. */
  afterApply?: boolean;
  /** How many matching requests to affect. Default 1. */
  times?: number;
}

export interface FakeDevto {
  readonly apiKey: string;
  readonly origin: string;
  articles: Map<number, FakeArticle>;
  requests: LoggedRequest[];
  fetch: typeof fetch;
  inject(injection: Injection): void;
  /** Seed an article that exists on the platform already (a live one, for example). */
  seed(partial: Partial<FakeArticle> & { title: string }): FakeArticle;
  handle(request: Request): Promise<Response>;
}

const USERNAME = 'fakeauthor';

function slugOf(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'untitled';
}

export function createFakeDevto(options: { apiKey: string; origin?: string; username?: string }): FakeDevto {
  const origin = (options.origin ?? 'https://fake-devto.example.test').replace(/\/$/, '');
  const username = options.username ?? USERNAME;
  const articles = new Map<number, FakeArticle>();
  const requests: LoggedRequest[] = [];
  const injections: (Injection & { left: number })[] = [];
  let nextId = 1000;

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  const view = (a: FakeArticle) => ({
    type_of: 'article',
    id: a.id,
    title: a.title,
    description: a.description,
    published: a.published,
    published_at: a.published_at,
    created_at: a.created_at,
    slug: a.slug,
    url: `${origin}/${username}/${a.slug}-${a.id}`,
    canonical_url: a.canonical_url ?? `${origin}/${username}/${a.slug}-${a.id}`,
    tag_list: a.tags,
    cover_image: a.main_image,
  });

  function validate(article: Record<string, unknown>): string | null {
    if (typeof article.title !== 'string' || article.title.trim() === '') return 'Title can\'t be blank';
    const tags = typeof article.tags === 'string' && article.tags ? article.tags.split(',') : [];
    if (tags.length > 4) return 'Tag list exceed the maximum of 4 tags';
    if (tags.some((t) => !/^[a-z0-9]+$/i.test(t))) return 'Tags must be letters and numbers only';
    return null;
  }

  function apply(method: string, path: string, body: unknown): Response {
    const article = (body as { article?: Record<string, unknown> } | null)?.article;
    if (method === 'GET' && path === '/api/users/me') return json(200, { type_of: 'user', id: 77, username, name: 'Fake Author' });
    const list = /^\/api\/articles\/me\/(published|unpublished|all)$/.exec(path);
    if (method === 'GET' && list) {
      const wanted = list[1];
      const all = [...articles.values()].filter((a) => (wanted === 'published' ? a.published : wanted === 'unpublished' ? !a.published : true));
      return json(200, all.map(view));
    }
    if (method === 'POST' && path === '/api/articles') {
      if (!article) return json(422, { error: 'param is missing or the value is empty: article', status: 422 });
      const problem = validate(article);
      if (problem) return json(422, { error: problem, status: 422 });
      const id = nextId++;
      const row: FakeArticle = {
        id,
        title: String(article.title),
        body_markdown: String(article.body_markdown ?? ''),
        description: String(article.description ?? ''),
        published: article.published === true,
        tags: String(article.tags ?? ''),
        canonical_url: (article.canonical_url as string | null | undefined) ?? null,
        main_image: (article.main_image as string | null | undefined) ?? null,
        series: (article.series as string | null | undefined) ?? null,
        slug: slugOf(String(article.title)),
        created_at: new Date().toISOString(),
        published_at: article.published === true ? new Date().toISOString() : null,
      };
      articles.set(id, row);
      return json(201, view(row));
    }
    const one = /^\/api\/articles\/(\d+)$/.exec(path);
    if (method === 'PUT' && one) {
      const row = articles.get(Number(one[1]));
      if (!row) return json(404, { error: 'not found', status: 404 });
      if (!article) return json(422, { error: 'param is missing or the value is empty: article', status: 422 });
      const merged = { title: row.title, tags: row.tags, ...article };
      const problem = validate(merged);
      if (problem) return json(422, { error: problem, status: 422 });
      if (typeof article.title === 'string') {
        row.title = article.title;
        row.slug = slugOf(article.title);
      }
      if (typeof article.body_markdown === 'string') row.body_markdown = article.body_markdown;
      if (typeof article.description === 'string') row.description = article.description;
      if (typeof article.tags === 'string') row.tags = article.tags;
      if ('canonical_url' in article) row.canonical_url = (article.canonical_url as string | null) ?? null;
      if ('main_image' in article) row.main_image = (article.main_image as string | null) ?? null;
      if ('series' in article) row.series = (article.series as string | null) ?? null;
      if (typeof article.published === 'boolean') {
        if (article.published && !row.published) row.published_at = new Date().toISOString();
        row.published = article.published;
      }
      return json(200, view(row));
    }
    const page = /^\/([a-z0-9_]+)\/(.+)-(\d+)$/.exec(path);
    if (method === 'GET' && page) {
      const row = articles.get(Number(page[3]));
      if (!row) return new Response('Not found', { status: 404 });
      const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
      return new Response(
        `<!doctype html><meta charset="utf-8"><title>${esc(row.title)}</title><body style="font-family:system-ui;max-width:42rem;margin:2rem auto;padding:0 1rem"><p><strong>Fake DEV.to</strong> (local test server). State: <strong>${row.published ? 'PUBLISHED' : 'PRIVATE DRAFT'}</strong></p><h1>${esc(row.title)}</h1><p>Tags: ${esc(row.tags)}</p><p>Canonical: ${esc(row.canonical_url ?? 'none')}</p><pre style="white-space:pre-wrap">${esc(row.body_markdown)}</pre></body>`,
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    }
    return json(404, { error: 'not found', status: 404 });
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const text = method === 'GET' || method === 'HEAD' ? '' : await request.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const path = url.pathname;
    requests.push({ method, path: path + url.search, headers, body });

    const isPage = method === 'GET' && !path.startsWith('/api/');
    if (!isPage && headers['api-key'] !== options.apiKey) return json(401, { error: 'unauthorized', status: 401 });

    const injection = injections.find((i) => i.left > 0 && i.match.test(`${method} ${path}`));
    if (injection) {
      injection.left -= 1;
      if (injection.afterApply) apply(method, path, body);
      if (injection.hang) {
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason));
        });
      }
      if (injection.drop) throw new TypeError('fetch failed', { cause: new Error('socket hang up') });
      if (injection.redirect) return new Response(null, { status: 302, headers: { location: injection.redirect } });
      return typeof injection.body === 'string'
        ? new Response(injection.body, { status: injection.status ?? 500, headers: injection.headers })
        : json(injection.status ?? 500, injection.body ?? { error: 'injected', status: injection.status ?? 500 }, injection.headers);
    }
    return apply(method, path, body);
  }

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const redirectMode = init?.redirect ?? 'follow';
    const response = await handle(request);
    if (response.status >= 300 && response.status < 400 && redirectMode === 'error') {
      throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
    }
    return response;
  }) as typeof fetch;

  return {
    apiKey: options.apiKey,
    origin,
    articles,
    requests,
    fetch: fetchFn,
    inject(injection) {
      injections.push({ ...injection, left: injection.times ?? 1 });
    },
    seed(partial) {
      const id = nextId++;
      const row: FakeArticle = {
        id,
        body_markdown: '',
        description: '',
        published: false,
        tags: '',
        canonical_url: null,
        main_image: null,
        series: null,
        slug: slugOf(partial.title),
        created_at: new Date().toISOString(),
        published_at: partial.published ? new Date().toISOString() : null,
        ...partial,
      };
      articles.set(id, row);
      return row;
    },
    handle,
  };
}

/** The same fake behind a real local HTTP port, for the manual browser run. Returns the server. */
export function serveFakeDevto(fake: FakeDevto, port: number): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = `http://127.0.0.1:${port}${req.url ?? '/'}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const init: RequestInit = { method: req.method ?? 'GET', headers };
      if (chunks.length > 0) init.body = Buffer.concat(chunks);
      fake.handle(new Request(url, init)).then(
        async (response) => {
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(Buffer.from(await response.arrayBuffer()));
        },
        () => {
          res.writeHead(502);
          res.end();
        },
      );
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
