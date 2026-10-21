import { describe, expect, it } from 'vitest';
import { DaemonApiError, DaemonClient, DaemonProtocolError, DaemonUnavailableError } from '../src/index.js';

const TOKEN = `cph_mcp_${'x'.repeat(43)}`;

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function setup(reply: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const entry: Seen = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    seen.push(entry);
    return reply(entry);
  }) as typeof fetch;
  return { client: new DaemonClient({ baseUrl: 'http://127.0.0.1:4646/', token: TOKEN, fetchFn }), seen };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('DaemonClient', () => {
  it('sends the bearer token and the JSON body to /api and parses the answer', async () => {
    const { client, seen } = setup(() => json({ approvalId: 'a-1', status: 'pending', approveUrl: 'http://127.0.0.1:4646/approvals/a-1', instructions: 'x' }, 201));
    const res = await client.requestApproval('d-1');
    expect(res.approvalId).toBe('a-1');
    expect(seen[0]).toMatchObject({ url: 'http://127.0.0.1:4646/api/approvals', method: 'POST', body: { draftId: 'd-1' } });
    expect(seen[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('puts ids in the path and filters in the query, encoded', async () => {
    const { client, seen } = setup((s) => (s.url.includes('/drafts?') ? json({ drafts: [] }) : json({ payload: {}, lint: [] })));
    await client.preview('a b', 'linkedin');
    await client.listDrafts({ slug: 'p', status: 'pending_approval' });
    expect(seen[0]?.url).toBe('http://127.0.0.1:4646/api/preview/a%20b/linkedin');
    expect(seen[1]?.url).toBe('http://127.0.0.1:4646/api/drafts?slug=p&status=pending_approval');
  });

  it('sends publish and hand-off with exactly the ids', async () => {
    const { client, seen } = setup((s) => (s.url.endsWith('/publish') ? json({ status: 'published', remoteUrl: 'https://dev.to/x' }) : json({ copiedText: 't', openUrl: 'https://x', checklist: [] })));
    await client.publish('d-1', 'a-1');
    await client.handOff('d-1', 'a-1');
    expect(seen[0]?.body).toEqual({ draftId: 'd-1', approvalId: 'a-1' });
    expect(seen[1]).toMatchObject({ url: 'http://127.0.0.1:4646/api/drafts/d-1/handoff', body: { approvalId: 'a-1' } });
  });

  it('turns a non-2xx answer into DaemonApiError with status, code and message', async () => {
    const { client } = setup(() => json({ code: 'PUBLISHING_DISABLED', message: 'off' }, 409));
    await expect(client.publish('d', 'a')).rejects.toMatchObject({ name: 'DaemonApiError', status: 409, code: 'PUBLISHING_DISABLED', message: 'off' });
    await expect(client.publish('d', 'a')).rejects.toBeInstanceOf(DaemonApiError);
  });

  it('keeps the status when the error body is not the contract shape', async () => {
    const { client } = setup(() => new Response('<html>nope</html>', { status: 502 }));
    await expect(client.listContent()).rejects.toMatchObject({ status: 502, code: 'HTTP_502' });
  });

  it('rejects a 2xx body that breaks the contract', async () => {
    const { client } = setup(() => json({ nope: true }));
    await expect(client.listContent()).rejects.toBeInstanceOf(DaemonProtocolError);
  });

  it('reports a refused connection as DaemonUnavailableError', async () => {
    const fetchFn = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }) as typeof fetch;
    const client = new DaemonClient({ baseUrl: 'http://127.0.0.1:4646', token: TOKEN, fetchFn });
    await expect(client.sync()).rejects.toBeInstanceOf(DaemonUnavailableError);
  });

  it('never puts the token in an error message', async () => {
    const fetchFn = (async () => {
      throw new TypeError(`fetch failed for Bearer ${TOKEN}`);
    }) as typeof fetch;
    const client = new DaemonClient({ baseUrl: 'http://127.0.0.1:4646', token: TOKEN, fetchFn });
    const error = await client.sync().catch((e: unknown) => e);
    expect(String((error as Error).message)).not.toContain(TOKEN);
  });
});
