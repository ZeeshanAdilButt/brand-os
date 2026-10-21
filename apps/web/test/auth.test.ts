import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuth, type Auth } from '../src/server/auth';
import { resolveSessionUser } from '../src/server/auth/resolve';
import { ConfigError } from '../src/server/config';
import type { AppContext } from '../src/server/context';
import { ensureLocalOwner, LOCAL_OWNER_ID } from '../src/server/data/users';
import type { DbHandle } from '../src/server/db/client';
import { accounts, users } from '../src/server/db/schema';
import { memoryDb, testConfig } from './helpers';

const SECRET = 'not-a-real-secret-0123456789abcdef0123456789';
const APP_URL = 'https://app.example.test';
const PASSWORD = 'correct horse battery staple';

const open: DbHandle[] = [];
afterEach(async () => {
  while (open.length) await open.pop()?.close();
});

async function hosted(appUrl = APP_URL) {
  const handle = await memoryDb();
  open.push(handle);
  const config = testConfig({ mode: 'hosted', authSecret: SECRET, appUrl });
  const auth = createAuth(handle.db, config);
  const ctx: AppContext = { config, db: handle.db, auth };
  return { handle, auth, ctx, appUrl };
}

let ipCounter = 0;

/** Each call gets its own client address so the per-IP rate limiter does not couple tests. */
function post(auth: Auth, appUrl: string, path: string, body: unknown, extra: Record<string, string> = {}) {
  return auth.handler(
    new Request(`${appUrl}/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: appUrl, 'x-forwarded-for': `203.0.113.${(ipCounter++ % 250) + 1}`, ...extra },
      body: JSON.stringify(body),
    }),
  );
}

/** Collapse Set-Cookie headers into a Cookie header value. */
function cookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

async function signUp(auth: Auth, appUrl: string, email: string, name = 'Test Person') {
  return post(auth, appUrl, '/sign-up/email', { email, password: PASSWORD, name });
}

describe('hosted sign-in', () => {
  it('refuses to start without a long AUTH_SECRET', async () => {
    const handle = await memoryDb();
    open.push(handle);
    expect(() => createAuth(handle.db, testConfig({ mode: 'hosted' }))).toThrow(ConfigError);
    expect(() => createAuth(handle.db, testConfig({ mode: 'hosted', authSecret: 'short' }))).toThrow(/AUTH_SECRET/);
  });

  it('signs up a member and sets a hardened session cookie', async () => {
    const { auth, handle, appUrl } = await hosted();
    const res = await signUp(auth, appUrl, 'First.User@Example.test');
    expect(res.status).toBe(200);
    const setCookie = res.headers.getSetCookie().find((c) => c.includes('session_token'));
    expect(setCookie).toBeDefined();
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//i);
    expect(setCookie?.startsWith('__Secure-')).toBe(true);

    const [row] = await handle.db.select().from(users).where(eq(users.email, 'first.user@example.test'));
    expect(row).toMatchObject({ kind: 'member', isOwner: false, displayName: 'Test Person' });
  });

  it('does not mark the cookie Secure on a plain-http development URL', async () => {
    const { auth, appUrl } = await hosted('http://localhost:3100');
    const res = await signUp(auth, appUrl, 'dev@example.test');
    const setCookie = res.headers.getSetCookie().find((c) => c.includes('session_token')) ?? '';
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).not.toMatch(/Secure/i);
  });

  it('stores a salted hash, never the password', async () => {
    const { auth, handle, appUrl } = await hosted();
    await signUp(auth, appUrl, 'hash@example.test');
    const rows = await handle.db.select().from(accounts);
    expect(rows).toHaveLength(1);
    const stored = rows[0]?.password ?? '';
    expect(stored.length).toBeGreaterThan(60);
    expect(stored).not.toContain(PASSWORD);
    expect(stored).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);

    await signUp(auth, appUrl, 'hash2@example.test');
    const all = await handle.db.select().from(accounts);
    expect(new Set(all.map((a) => a.password)).size).toBe(2);
  });

  it('signs in with the right password, rejects the wrong one, and resolves the session', async () => {
    const { auth, ctx, appUrl } = await hosted();
    await signUp(auth, appUrl, 'login@example.test', 'Login Person');

    const bad = await post(auth, appUrl, '/sign-in/email', { email: 'login@example.test', password: 'wrong password here' });
    expect(bad.status).toBe(401);
    expect(bad.headers.getSetCookie()).toEqual([]);

    const good = await post(auth, appUrl, '/sign-in/email', { email: 'login@example.test', password: PASSWORD });
    expect(good.status).toBe(200);
    const cookie = cookieHeader(good);
    const user = await resolveSessionUser(ctx, new Headers({ cookie }));
    expect(user).toMatchObject({ displayName: 'Login Person', email: 'login@example.test', kind: 'member', isOwner: false });
    expect(await resolveSessionUser(ctx, new Headers())).toBeNull();
  });

  it('signs out and the old cookie stops working', async () => {
    const { auth, ctx, appUrl } = await hosted();
    const up = await signUp(auth, appUrl, 'out@example.test');
    const cookie = cookieHeader(up);
    expect(await resolveSessionUser(ctx, new Headers({ cookie }))).not.toBeNull();

    const out = await post(auth, appUrl, '/sign-out', {}, { cookie });
    expect(out.status).toBe(200);
    expect(await resolveSessionUser(ctx, new Headers({ cookie }))).toBeNull();
  });

  it('rejects a cross-origin mutation that carries the session cookie (CSRF)', async () => {
    const { auth, ctx, appUrl } = await hosted();
    const cookie = cookieHeader(await signUp(auth, appUrl, 'csrf@example.test'));
    const forged = await post(auth, appUrl, '/sign-out', {}, { cookie, origin: 'https://evil.example.test' });
    expect(forged.status).toBeGreaterThanOrEqual(400);
    expect(await resolveSessionUser(ctx, new Headers({ cookie }))).not.toBeNull();
  });

  it('rejects a weak password', async () => {
    const { auth, appUrl } = await hosted();
    const weak = await post(auth, appUrl, '/sign-up/email', { email: 'weak@example.test', password: 'short', name: 'X' });
    expect(weak.status).toBe(400);
  });

  it('rate limits repeated sign-in attempts from one address', async () => {
    const { auth, appUrl } = await hosted();
    const same = { 'x-forwarded-for': '198.51.100.9' };
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await post(auth, appUrl, '/sign-in/email', { email: 'nobody@example.test', password: 'wrong password here' }, same);
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
    expect(statuses[0]).toBe(401);
  });

  it('rejects a duplicate email', async () => {
    const { auth, appUrl } = await hosted();
    expect((await signUp(auth, appUrl, 'dup@example.test')).status).toBe(200);
    expect((await signUp(auth, appUrl, 'dup@example.test')).status).toBeGreaterThanOrEqual(400);
  });
});

describe('local mode needs no login', () => {
  it('resolves the single owner with no cookie, header or account', async () => {
    const handle = await memoryDb();
    open.push(handle);
    const ctx: AppContext = { config: testConfig(), db: handle.db, auth: null };
    const user = await resolveSessionUser(ctx, new Headers());
    expect(user).toMatchObject({ userId: LOCAL_OWNER_ID, kind: 'local_owner', isOwner: true });
  });

  it('gives every request the same real user id and is idempotent', async () => {
    const handle = await memoryDb();
    open.push(handle);
    const a = await ensureLocalOwner(handle.db);
    const b = await ensureLocalOwner(handle.db);
    expect(a.id).toBe(b.id);
    const all = await handle.db.select().from(users);
    expect(all).toHaveLength(1);
  });

  it('ignores a forged cookie: there is no other identity to claim', async () => {
    const handle = await memoryDb();
    open.push(handle);
    const ctx: AppContext = { config: testConfig(), db: handle.db, auth: null };
    const user = await resolveSessionUser(ctx, new Headers({ cookie: 'session=someone-else', 'x-user-id': 'x' }));
    expect(user?.userId).toBe(LOCAL_OWNER_ID);
  });

  it('marks a Day 1 owner row (created before the flag) as owner', async () => {
    const handle = await memoryDb();
    open.push(handle);
    await handle.db.insert(users).values({ id: LOCAL_OWNER_ID, kind: 'local_owner', displayName: 'Local owner' });
    const owner = await ensureLocalOwner(handle.db);
    expect(owner.isOwner).toBe(true);
  });
});
