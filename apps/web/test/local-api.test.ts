import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as exportGet } from '../src/app/api/export/route';
import { GET as itemsGet, POST as itemsPost } from '../src/app/api/knowledge/route';
import { checkRequest } from '../src/server/http/guard';
import { installContext, type AppContext } from '../src/server/context';
import { ensureLocalOwner, LOCAL_OWNER_ID } from '../src/server/data/users';
import type { DbHandle } from '../src/server/db/client';
import { memoryDb, testConfig } from './helpers';

let handle: DbHandle;
let uninstall: () => void;
const APP = 'http://localhost:3100';

const req = (method: string, path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) =>
  new Request(`${APP}${path}`, {
    method,
    headers: { host: 'localhost:3100', ...(method === 'GET' ? {} : { origin: APP, 'content-type': 'application/json' }), ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

beforeAll(async () => {
  handle = await memoryDb();
  await ensureLocalOwner(handle.db);
  const ctx: AppContext = { config: testConfig(), db: handle.db, auth: null };
  uninstall = installContext(ctx);
});

afterAll(async () => {
  uninstall();
  await handle.close();
});

describe('local mode API', () => {
  it('needs no login: the owner is implicit and every row carries a real user id', async () => {
    const created = await itemsPost(req('POST', '/api/knowledge', { body: { kind: 'note', title: 'local item' } }));
    expect(created.status).toBe(201);
    expect((await created.json()).ownerId).toBe(LOCAL_OWNER_ID);
    const list = await (await itemsGet(req('GET', '/api/knowledge'))).json();
    expect(list.items.map((i: { title: string }) => i.title)).toContain('local item');
    expect((await exportGet(req('GET', '/api/export'))).status).toBe(200);
  });

  it('ignores any identity the request claims', async () => {
    const res = await itemsPost(
      req('POST', '/api/knowledge', {
        body: { kind: 'note', title: 'claimed', ownerId: '99999999-9999-4999-8999-999999999999' },
        headers: { cookie: 'session=forged', 'x-user-id': '99999999-9999-4999-8999-999999999999' },
      }),
    );
    expect((await res.json()).ownerId).toBe(LOCAL_OWNER_ID);
  });

  it('refuses a cross-site page posting to the local app', async () => {
    const res = await itemsPost(req('POST', '/api/knowledge', { body: { kind: 'note', title: 'drive-by' }, headers: { origin: 'https://evil.example.test' } }));
    expect(res.status).toBe(403);
  });

  it('refuses a rebinding host name, which would otherwise reach the owner data from a hostile page', async () => {
    const res = await exportGet(req('GET', '/api/export', { headers: { host: 'evil.example.test' } }));
    expect(res.status).toBe(403);
  });
});

describe('request guard', () => {
  const local = { mode: 'local' as const, appUrl: APP };
  const hosted = { mode: 'hosted' as const, appUrl: 'https://app.example.test' };
  const r = (method: string, host: string, headers: Record<string, string> = {}) => new Request(`http://${host}/x`, { method, headers: { host, ...headers } });

  it('allows loopback names in local mode and any host in hosted mode', () => {
    for (const host of ['localhost:3100', '127.0.0.1:3100', '[::1]:3100']) expect(checkRequest(r('GET', host), local).ok).toBe(true);
    expect(checkRequest(r('GET', 'app.example.test'), hosted).ok).toBe(true);
    expect(checkRequest(r('GET', 'evil.example.test'), local).ok).toBe(false);
  });

  it('requires same-origin for mutations, using Origin or Sec-Fetch-Site', () => {
    expect(checkRequest(r('POST', 'localhost:3100', { origin: 'http://localhost:3100' }), local).ok).toBe(true);
    expect(checkRequest(r('POST', 'localhost:3100', { origin: 'http://localhost:9999' }), local).ok).toBe(false);
    expect(checkRequest(r('POST', 'localhost:3100', { origin: 'not a url' }), local).ok).toBe(false);
    expect(checkRequest(r('DELETE', 'app.example.test', { 'sec-fetch-site': 'cross-site' }), hosted).ok).toBe(false);
    expect(checkRequest(r('DELETE', 'app.example.test', { 'sec-fetch-site': 'same-origin' }), hosted).ok).toBe(true);
    expect(checkRequest(r('DELETE', 'app.example.test'), hosted).ok).toBe(true);
  });
});
