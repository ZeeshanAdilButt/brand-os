import { createAuth } from '../src/server/auth';
import type { AppContext } from '../src/server/context';
import { installContext } from '../src/server/context';
import type { DbHandle } from '../src/server/db/client';
import { memoryDb, testConfig } from './helpers';

export const HOSTED_SECRET = 'not-a-real-secret-0123456789abcdef0123456789';
export const HOSTED_URL = 'https://app.example.test';
export const TEST_PASSWORD = 'correct horse battery staple';

export interface TestUser {
  userId: string;
  email: string;
  cookie: string;
}

let ip = 0;

export interface HostedHarness {
  handle: DbHandle;
  ctx: AppContext;
  signUp(email: string, name?: string): Promise<TestUser>;
  /** Call a route handler module the way the server would, as the given user (or signed out). */
  request(
    user: TestUser | null,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Request;
  close(): Promise<void>;
}

/** A hosted-mode app on in-memory PGlite with real Better Auth sessions. The context is installed globally. */
export async function hostedHarness(): Promise<HostedHarness> {
  const handle = await memoryDb();
  const config = testConfig({ mode: 'hosted', authSecret: HOSTED_SECRET, appUrl: HOSTED_URL });
  const auth = createAuth(handle.db, config);
  const ctx: AppContext = { config, db: handle.db, auth };
  const uninstall = installContext(ctx);

  return {
    handle,
    ctx,
    async signUp(email, name = 'Test Person') {
      const res = await auth.handler(
        new Request(`${HOSTED_URL}/api/auth/sign-up/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: HOSTED_URL, 'x-forwarded-for': `192.0.2.${(ip++ % 250) + 1}` },
          body: JSON.stringify({ email, password: TEST_PASSWORD, name }),
        }),
      );
      if (res.status !== 200) throw new Error(`sign-up failed with ${res.status}`);
      const cookie = res.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');
      const body = (await res.json()) as { user: { id: string } };
      return { userId: body.user.id, email, cookie };
    },
    request(user, method, path, body, headers = {}) {
      const isRead = method === 'GET' || method === 'HEAD';
      return new Request(`${HOSTED_URL}${path}`, {
        method,
        headers: {
          host: new URL(HOSTED_URL).host,
          ...(isRead ? {} : { origin: HOSTED_URL, 'content-type': 'application/json' }),
          ...(user ? { cookie: user.cookie } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    },
    async close() {
      uninstall();
      await handle.close();
    },
  };
}
