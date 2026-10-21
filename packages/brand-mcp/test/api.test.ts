import { describe, expect, it } from 'vitest';
import { ApiError, createBrandApi, scrub } from '../src/api.js';

const CREDENTIAL = `bos_${'Zq9x'.repeat(10)}abc`;
const ID = '4f1b6c1e-9a3d-4e2b-8c55-0d7a1f2e3b4c';

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fake(respond: (seen: Seen) => Response | Promise<Response>) {
  const calls: Seen[] = [];
  const fn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return respond(calls.at(-1)!);
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('the agent API client', () => {
  it('sends the credential as a bearer header and nothing that names an owner', async () => {
    const { fn, calls } = fake(() => json({ ok: true }));
    const api = createBrandApi({ baseUrl: 'http://127.0.0.1:3100/', credential: CREDENTIAL, fetchFn: fn });
    await api.me();
    await api.searchKnowledge({ q: 'queue wait', limit: 5 });
    await api.listArticles({ q: 'x', status: 'draft', limit: 10 });
    await api.getArticle(ID);
    await api.createArticle({ title: 'T' });
    await api.updateArticle(ID, 3, { title: 'U' });
    await api.listAiTasks({ status: 'pending,running', limit: 5 });
    await api.getAiTask(ID);
    await api.submitAiTaskResult(ID, [{ type: 'insert_after', text: 'x' }]);
    expect(calls.map((c) => `${c.method} ${c.url.replace('http://127.0.0.1:3100', '')}`)).toEqual([
      'GET /api/agent/me',
      'GET /api/agent/knowledge?q=queue+wait&limit=5',
      'GET /api/agent/articles?q=x&status=draft&limit=10',
      `GET /api/agent/articles/${ID}`,
      'POST /api/agent/articles',
      `PATCH /api/agent/articles/${ID}`,
      'GET /api/agent/ai-tasks?status=pending%2Crunning&limit=5',
      `GET /api/agent/ai-tasks/${ID}`,
      `POST /api/agent/ai-tasks/${ID}/result`,
    ]);
    for (const call of calls) {
      expect(call.headers.authorization).toBe(`Bearer ${CREDENTIAL}`);
      expect(JSON.stringify([call.url, call.body])).not.toMatch(/owner|user_?id|tenant/i);
    }
    expect(calls[5]?.body).toEqual({ expectedRevision: 3, title: 'U' });
    expect(calls[8]?.body).toEqual({ operations: [{ type: 'insert_after', text: 'x' }] });
  });

  it('turns an error body into an ApiError with the code, data and retry hint, minus the credential', async () => {
    const { fn } = fake(() => json({ error: `Bad ${CREDENTIAL}`, code: 'conflict', data: { current: { revision: 4 } } }, 409, { 'retry-after': '7' }));
    const api = createBrandApi({ baseUrl: 'http://127.0.0.1:3100', credential: CREDENTIAL, fetchFn: fn });
    const err = (await api.getArticle(ID).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'conflict', retryAfterSec: 7, data: { current: { revision: 4 } } });
    expect(err.message).not.toContain(CREDENTIAL);
  });

  it('reports an unreachable app and a timeout without the address path or the credential', async () => {
    const down = createBrandApi({
      baseUrl: 'http://127.0.0.1:3100/secret/path',
      credential: CREDENTIAL,
      fetchFn: (async () => {
        throw new TypeError(`connect ECONNREFUSED while sending ${CREDENTIAL}`);
      }) as typeof fetch,
    });
    const err = (await down.me().catch((e: unknown) => e)) as ApiError;
    expect(err).toMatchObject({ status: 0, code: 'unreachable' });
    expect(err.message).toBe('Could not reach Brand OS at http://127.0.0.1:3100. Is it running?');

    const slow = createBrandApi({
      baseUrl: 'http://127.0.0.1:3100',
      credential: CREDENTIAL,
      timeoutMs: 20,
      fetchFn: ((_u: unknown, init?: RequestInit) => new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(init.signal?.reason)))) as unknown as typeof fetch,
    });
    expect(((await slow.me().catch((e: unknown) => e)) as ApiError).code).toBe('timeout');
  });

  it('copes with an answer that is not JSON', async () => {
    const { fn } = fake(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    const err = (await createBrandApi({ baseUrl: 'http://x.test', credential: CREDENTIAL, fetchFn: fn }).me().catch((e: unknown) => e)) as ApiError;
    expect(err).toMatchObject({ status: 502, message: 'Brand OS answered 502.' });
  });

  it('scrubs the credential and bearer headers from text', () => {
    expect(scrub(`x ${CREDENTIAL} y`, CREDENTIAL)).toBe('x [credential] y');
    expect(scrub('Authorization: Bearer abcdefghijkl', CREDENTIAL)).toBe('Authorization: Bearer [credential]');
  });
});
