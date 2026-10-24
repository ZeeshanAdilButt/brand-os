/**
 * A tiny fake of the platforms the connection code talks to. It is a test helper only: tests pass `fake.fetch` as the
 * injected fetch, so no request ever leaves the process. Routes are registered per method and address; every request
 * is logged with its headers and body so tests can check exactly what was sent, and that a secret went only where it
 * should.
 */

export interface FakeRequest {
  method: string;
  /** The full address, query included. */
  url: string;
  origin: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  form: Record<string, string>;
}

type Reply = Response | { status?: number; body?: unknown; headers?: Record<string, string> };
export type FakeHandler = (request: FakeRequest) => Reply | Promise<Reply>;

interface Route {
  method: string;
  match: string | RegExp;
  handler: FakeHandler;
  times: number;
}

export interface FakeProviders {
  fetch: typeof fetch;
  requests: FakeRequest[];
  /** Register a route. `match` is `origin + path` (a string) or a pattern tested against it. */
  on(method: string, match: string | RegExp, handler: FakeHandler | Reply, times?: number): void;
  callsTo(match: string | RegExp): FakeRequest[];
  /** Every request, as one searchable text. */
  transcript(): string;
  clear(): void;
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function asResponse(reply: Reply): Response {
  if (reply instanceof Response) return reply;
  return json(reply.body ?? {}, reply.status ?? 200, reply.headers ?? {});
}

export function createFakeProviders(): FakeProviders {
  const routes: Route[] = [];
  const requests: FakeRequest[] = [];
  const fake: FakeProviders = {
    requests,
    on(method, match, handler, times = Infinity) {
      // The newest route wins, so a test can change what a platform answers half way through.
      routes.unshift({ method: method.toUpperCase(), match, handler: typeof handler === 'function' ? handler : () => handler, times });
    },
    callsTo(match) {
      return requests.filter((r) => (typeof match === 'string' ? `${r.origin}${r.path}` === match : match.test(`${r.origin}${r.path}`)));
    },
    transcript() {
      return requests.map((r) => `${r.method} ${r.url}\n${Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}\n${r.body}`).join('\n---\n');
    },
    clear() {
      requests.length = 0;
      routes.length = 0;
    },
    fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      const body = typeof init?.body === 'string' ? init.body : '';
      const form: Record<string, string> = {};
      if ((headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')) new URLSearchParams(body).forEach((v, k) => (form[k] = v));
      const request: FakeRequest = { method: (init?.method ?? 'GET').toUpperCase(), url: url.toString(), origin: url.origin, path: url.pathname, headers, body, form };
      requests.push(request);
      if (init?.redirect !== 'error') throw new Error('connection code must refuse redirects');
      const key = `${url.origin}${url.pathname}`;
      const route = routes.find((r) => r.method === request.method && r.times > 0 && (typeof r.match === 'string' ? r.match === key : r.match.test(key)));
      if (!route) return json({ error: 'no fake route', key }, 404);
      route.times -= 1;
      return asResponse(await route.handler(request));
    }) as typeof fetch,
  };
  return fake;
}
