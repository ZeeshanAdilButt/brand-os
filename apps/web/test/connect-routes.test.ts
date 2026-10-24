import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as callbackGet } from '../src/app/api/connect/[platform]/callback/route';
import { DELETE as disconnectDelete } from '../src/app/api/connect/[platform]/route';
import { POST as agentCredentialPost } from '../src/app/api/agent-credentials/route';
import { saveIntegrationSecret } from '../src/server/actions/integrations';
import { sessionToOwner } from '../src/server/actions/owner';
import { defaultLimits } from '../src/server/connect/env';
import {
  handleConnectCallback,
  handleConnectDeviceCancel,
  handleConnectDevicePoll,
  handleConnectDeviceStart,
  handleConnectDisconnect,
  handleConnectFields,
  handleConnectorsGet,
  handleConnectStart,
  handleConnectTest,
  type ConnectHandlerDeps,
} from '../src/server/http/connect-handlers';
import { hostedHarness, HOSTED_URL, type HostedHarness, type TestUser } from './hosted-harness';
import { sqlRows } from './helpers';
import { createFakeProviders, json, type FakeProviders } from './helpers/fake-providers';

const W = (...parts: string[]) => parts.join('-');
const API_KEY = W('fake', 'beehiiv', 'key', 'routes', '1a2b3c');
const CLIENT_ID = W('fake', 'client', 'id', 'routes', '77');
const CLIENT_SECRET = W('fake', 'client', 'secret', 'routes', '88');
const ACCESS = W('fake', 'access', 'routes', 'c4d5e6');

let h: HostedHarness;
let a: TestUser;
let b: TestUser;
let fake: FakeProviders;
let deps: ConnectHandlerDeps;

type Body = Record<string, unknown> & { error?: string; connectors?: { id: string; state: string }[] };
const body = async (res: Response) => (await res.json()) as Body;

beforeAll(async () => {
  h = await hostedHarness({ appSecret: 'a-long-test-app-secret-0123456789abcdefghijklmnop' });
  a = await h.signUp('connect.a@example.test', 'Writer A');
  b = await h.signUp('connect.b@example.test', 'Writer B');
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.handle.db.execute(sql`delete from connect_flows`);
  await h.handle.db.execute(sql`delete from platform_connections`);
  await h.handle.db.execute(sql`delete from integration_secrets`);
  fake = createFakeProviders();
  deps = { connect: { fetchFn: fake.fetch, limits: defaultLimits(), timeoutMs: 2000 } };
});

const params = (platform: string) => ({ params: Promise.resolve({ platform }) });
const bearer = (path: string, method = 'POST', payload?: unknown) =>
  new Request(`${HOSTED_URL}${path}`, { method, headers: { host: new URL(HOSTED_URL).host, authorization: 'Bearer bos_not_a_real_agent_secret_0123456789', origin: HOSTED_URL, 'content-type': 'application/json' }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });

describe('the connection routes need a signed-in person', () => {
  it('answers 401 to every route without a session', async () => {
    const id = '4f1b6c1e-9a3d-4e2b-8c55-0d7a1f2e3b4c';
    const results = await Promise.all([
      handleConnectorsGet(h.request(null, 'GET', '/api/connect'), deps),
      handleConnectFields(h.request(null, 'POST', '/api/connect/beehiiv/fields', { fields: { apiKey: API_KEY } }), 'beehiiv', deps),
      handleConnectStart(h.request(null, 'POST', '/api/connect/x/start', {}), 'x', deps),
      handleConnectDeviceStart(h.request(null, 'POST', '/api/connect/site/device', {}), 'site', deps),
      handleConnectDevicePoll(h.request(null, 'POST', '/api/connect/site/device/poll', { flowId: id }), 'site', deps),
      handleConnectDeviceCancel(h.request(null, 'DELETE', '/api/connect/site/device'), 'site', deps),
      handleConnectTest(h.request(null, 'POST', '/api/connect/beehiiv/test', {}), 'beehiiv', deps),
      handleConnectDisconnect(h.request(null, 'DELETE', '/api/connect/beehiiv'), 'beehiiv', deps),
    ]);
    expect(results.map((r) => r.status)).toEqual([401, 401, 401, 401, 401, 401, 401, 401]);
    expect(fake.requests).toHaveLength(0);
  });

  it('sends a signed-out callback to the sign-in page without touching anything', async () => {
    const res = await handleConnectCallback(h.request(null, 'GET', `/api/connect/x/callback?code=abc&state=${'a'.repeat(43)}`), 'x', deps);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/sign-in');
    expect(fake.requests).toHaveLength(0);
  });
});

describe('only the browser can connect: an agent credential or a foreign page cannot', () => {
  it('refuses a request that carries an Authorization header, on every route, even with a good session', async () => {
    const withHeader = (method: string, path: string, payload?: unknown) => h.request(a, method, path, payload, { authorization: 'Bearer bos_not_a_real_agent_secret_0123456789' });
    const results = await Promise.all([
      handleConnectorsGet(withHeader('GET', '/api/connect'), deps),
      handleConnectFields(withHeader('POST', '/api/connect/beehiiv/fields', { fields: { apiKey: API_KEY } }), 'beehiiv', deps),
      handleConnectStart(withHeader('POST', '/api/connect/x/start', {}), 'x', deps),
      handleConnectDeviceStart(withHeader('POST', '/api/connect/site/device', {}), 'site', deps),
      handleConnectDevicePoll(withHeader('POST', '/api/connect/site/device/poll', { flowId: 'x' }), 'site', deps),
      handleConnectDeviceCancel(withHeader('DELETE', '/api/connect/site/device'), 'site', deps),
      handleConnectTest(withHeader('POST', '/api/connect/beehiiv/test', {}), 'beehiiv', deps),
      handleConnectDisconnect(withHeader('DELETE', '/api/connect/beehiiv'), 'beehiiv', deps),
    ]);
    expect(results.map((r) => r.status)).toEqual([403, 403, 403, 403, 403, 403, 403, 403]);
    const callback = await handleConnectCallback(withHeader('GET', `/api/connect/x/callback?code=abc&state=${'a'.repeat(43)}`), 'x', deps);
    expect(callback.headers.get('location')).toContain('result=error');
    expect(fake.requests).toHaveLength(0);
  });

  it('an agent credential alone is signed out: 401, never a connection', async () => {
    const minted = await agentCredentialPost(h.request(a, 'POST', '/api/agent-credentials', { name: 'claude', scopes: ['read', 'write_articles', 'ai_tasks', 'platform_drafts'] }));
    const secret = ((await minted.json()) as { secret: string }).secret;
    const asAgent = (method: string, path: string, payload?: unknown) =>
      new Request(`${HOSTED_URL}${path}`, { method, headers: { host: new URL(HOSTED_URL).host, authorization: `Bearer ${secret}`, origin: HOSTED_URL, 'content-type': 'application/json' }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    expect((await handleConnectFields(asAgent('POST', '/api/connect/beehiiv/fields', { fields: { apiKey: API_KEY } }), 'beehiiv', deps)).status).toBe(401);
    expect((await handleConnectorsGet(asAgent('GET', '/api/connect'), deps)).status).toBe(401);
    expect((await handleConnectDisconnect(asAgent('DELETE', '/api/connect/beehiiv'), 'beehiiv', deps)).status).toBe(401);
    expect((await handleConnectStart(bearer('/api/connect/x/start'), 'x', deps)).status).toBe(401);
  });

  it('refuses a change that does not say which page it came from, and one from another site', async () => {
    const noOrigin = new Request(`${HOSTED_URL}/api/connect/beehiiv/fields`, { method: 'POST', headers: { host: new URL(HOSTED_URL).host, cookie: a.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ fields: { apiKey: API_KEY } }) });
    expect((await handleConnectFields(noOrigin, 'beehiiv', deps)).status).toBe(403);
    const foreign = h.request(a, 'POST', '/api/connect/beehiiv/fields', { fields: { apiKey: API_KEY } }, { origin: 'https://evil.example.test' });
    expect((await handleConnectFields(foreign, 'beehiiv', deps)).status).toBe(403);
    const crossSite = h.request(a, 'DELETE', '/api/connect/beehiiv', undefined, { 'sec-fetch-site': 'cross-site', origin: '' });
    expect([403]).toContain((await handleConnectDisconnect(crossSite, 'beehiiv', deps)).status);
    expect(fake.requests).toHaveLength(0);
  });

  it('the mounted route files wire the same handlers', async () => {
    expect((await disconnectDelete(bearer('/api/connect/beehiiv', 'DELETE'), params('beehiiv'))).status).toBe(401);
    const res = await callbackGet(h.request(null, 'GET', `/api/connect/x/callback?code=abc&state=${'a'.repeat(43)}`), params('x'));
    expect(res.status).toBe(303);
  });
});

describe('a full sign-in through the routes, as a hosted user', () => {
  it('lists, saves keys, signs in, tests and disconnects, and no response ever carries a secret', async () => {
    fake.on('GET', 'https://api.beehiiv.com/v2/publications', { body: { data: [{ id: 'p', name: 'The Notes' }] } });
    const connected = await handleConnectFields(h.request(a, 'POST', '/api/connect/beehiiv/fields', { fields: { apiKey: API_KEY } }), 'beehiiv', deps);
    expect(connected.status).toBe(200);
    const connectedBody = JSON.stringify(await body(connected));
    expect(connectedBody).toContain('The Notes');
    expect(connectedBody).not.toContain(API_KEY);

    const listed = await body(await handleConnectorsGet(h.request(a, 'GET', '/api/connect'), deps));
    expect(listed.connectors).toHaveLength(45);
    expect(listed.connectors?.find((c) => c.id === 'beehiiv')?.state).toBe('connected');
    expect(listed.connectors?.find((c) => c.id === 'x')?.state).toBe('set_up');
    const other = await body(await handleConnectorsGet(h.request(b, 'GET', '/api/connect'), deps));
    expect(other.connectors?.find((c) => c.id === 'beehiiv')?.state).toBe('needs_key');

    // The other account cannot test or disconnect it.
    expect((await handleConnectTest(h.request(b, 'POST', '/api/connect/beehiiv/test', {}), 'beehiiv', deps)).status).toBe(404);
    expect((await handleConnectDisconnect(h.request(b, 'DELETE', '/api/connect/beehiiv'), 'beehiiv', deps)).status).toBe(404);

    expect((await handleConnectTest(h.request(a, 'POST', '/api/connect/beehiiv/test', {}), 'beehiiv', deps)).status).toBe(200);
    const gone = await handleConnectDisconnect(h.request(a, 'DELETE', '/api/connect/beehiiv'), 'beehiiv', deps);
    expect(gone.status).toBe(200);
    expect(JSON.stringify(await body(gone))).not.toContain(API_KEY);
    expect(await sqlRows(h.handle.db, sql`select id from platform_connections where owner_id = ${a.userId}`)).toEqual([]);
  });

  it('binds the state to the session: the right browser finishes, another account only gets a result code', async () => {
    await saveIntegrationSecret(sessionToOwner({ userId: a.userId }, h.ctx), { config: h.ctx.config }, { platform: 'x', kind: 'oauth_client', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    let challenge = '';
    fake.on('POST', 'https://api.x.com/2/oauth2/token', (r) => (createHash('sha256').update(r.form.code_verifier ?? '').digest('base64url') === challenge ? json({ access_token: ACCESS, refresh_token: 'r', expires_in: 7200, scope: 'users.read tweet.read offline.access' }) : json({ error: 'invalid_grant' }, 400)));
    fake.on('GET', 'https://api.x.com/2/users/me', { body: { data: { username: 'fakewriter' } } });

    const started = await body(await handleConnectStart(h.request(a, 'POST', '/api/connect/x/start', {}), 'x', deps));
    expect(started.redirectUri).toBe(`${HOSTED_URL}/api/connect/x/callback`);
    const url = new URL(String(started.authorizeUrl));
    challenge = url.searchParams.get('code_challenge') ?? '';
    const state = url.searchParams.get('state') ?? '';

    // Another account holding the same state value gets nothing, and cannot use up the real one.
    const stolen = await handleConnectCallback(h.request(b, 'GET', `/api/connect/x/callback?code=abc&state=${state}`), 'x', deps);
    expect(stolen.headers.get('location')).toBe('/platforms/integrations?connect=x&result=state');
    expect(fake.requests).toHaveLength(0);

    const ok = await handleConnectCallback(h.request(a, 'GET', `/api/connect/x/callback?code=${W('fake', 'code', 'zz')}&state=${state}`), 'x', deps);
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/platforms/integrations?connect=x&result=connected');
    // The redirect carries a result code and nothing else: no code, no token, no state.
    expect(ok.headers.get('location')).not.toMatch(/code=|state=|token|fake/);

    const replay = await handleConnectCallback(h.request(a, 'GET', `/api/connect/x/callback?code=abc&state=${state}`), 'x', deps);
    expect(replay.headers.get('location')).toBe('/platforms/integrations?connect=x&result=state');
    const view = (await body(await handleConnectorsGet(h.request(a, 'GET', '/api/connect'), deps))).connectors?.find((c) => c.id === 'x');
    expect(view?.state).toBe('connected');
    expect(JSON.stringify(view)).not.toContain(ACCESS);
  });

  it('uses the host’s own OAuth app from the environment on a hosted server, with no app saved', async () => {
    const hosted: ConnectHandlerDeps = { connect: { ...deps.connect, processEnv: { BRAND_OS_OAUTH_LINKEDIN_CLIENT_ID: CLIENT_ID, BRAND_OS_OAUTH_LINKEDIN_CLIENT_SECRET: CLIENT_SECRET } } };
    const before = (await body(await handleConnectorsGet(h.request(a, 'GET', '/api/connect'), deps))).connectors?.find((c) => c.id === 'linkedin');
    expect(before?.state).toBe('set_up');
    const view = (await body(await handleConnectorsGet(h.request(a, 'GET', '/api/connect'), hosted))).connectors?.find((c) => c.id === 'linkedin') as unknown as { state: string; app: { source: string } };
    expect(view.state).toBe('needs_key');
    expect(view.app.source).toBe('host');
    const started = await body(await handleConnectStart(h.request(a, 'POST', '/api/connect/linkedin/start', {}), 'linkedin', hosted));
    expect(new URL(String(started.authorizeUrl)).searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(String(started.authorizeUrl)).not.toContain(CLIENT_SECRET);
  });

  it('limits sign-in attempts and callbacks', async () => {
    await saveIntegrationSecret(sessionToOwner({ userId: a.userId }, h.ctx), { config: h.ctx.config }, { platform: 'x', kind: 'oauth_client', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    for (let i = 0; i < 10; i++) expect((await handleConnectStart(h.request(a, 'POST', '/api/connect/x/start', {}), 'x', deps)).status).toBe(200);
    expect((await handleConnectStart(h.request(a, 'POST', '/api/connect/x/start', {}), 'x', deps)).status).toBe(429);
    for (let i = 0; i < 20; i++) await handleConnectCallback(h.request(a, 'GET', `/api/connect/x/callback?code=abc&state=${'b'.repeat(43)}`), 'x', deps);
    const limited = await handleConnectCallback(h.request(a, 'GET', `/api/connect/x/callback?code=abc&state=${'b'.repeat(43)}`), 'x', deps);
    expect(limited.headers.get('location')).toContain('result=error');
  });
});

describe('nothing an agent can reach can connect, read, refresh or disconnect', () => {
  const webRoot = path.resolve(import.meta.dirname, '..');
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
    return out;
  };

  it('no file under the agent API names a connection action, handler or table', () => {
    const files = walk(path.join(webRoot, 'src', 'app', 'api', 'agent'));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/actions\/connect|connect-handlers|server\/connect|handleConnect|integrationSecrets|connectors\./);
    }
    const agentHandlers = fs.readFileSync(path.join(webRoot, 'src', 'server', 'http', 'agent-handlers.ts'), 'utf8');
    expect(agentHandlers).not.toMatch(/actions\/connect|server\/connect|handleConnect|disconnect|refresh/i);
  });

  it('the agent key scopes do not include anything about connections', async () => {
    const { AGENT_SCOPES } = await import('../src/lib/agent');
    expect(AGENT_SCOPES.join(' ')).not.toMatch(/connect|credential|token|oauth/i);
  });

  it('the brand-os MCP server has no tool whose name is about connecting', () => {
    const source = fs.readFileSync(path.resolve(webRoot, '..', '..', 'packages', 'brand-mcp', 'src', 'server.ts'), 'utf8');
    const names = [...source.matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map((m) => m[1] as string);
    expect(names.length).toBeGreaterThan(10);
    expect(names.join(' ')).not.toMatch(/connect|disconnect|refresh|oauth|token|credential|integration/);
  });

  it('only the connection actions read an app’s client secret or a stored sign-in', () => {
    const allowed = new Set(['src/server/actions/connect.ts', 'src/server/actions/integrations.ts', 'src/server/connect/oauth.ts', 'src/server/connect/tokens.ts', 'src/server/connect/bundle.ts', 'src/server/data/connect.ts', 'src/server/data/integrations.ts', 'src/server/db/schema.ts']);
    const offenders = walk(path.join(webRoot, 'src'))
      .map((f) => ({ file: path.relative(webRoot, f).split(path.sep).join('/'), text: fs.readFileSync(f, 'utf8') }))
      .filter((f) => /getWithSecret|refresh_token|refreshToken|clientSecret/.test(f.text))
      .map((f) => f.file)
      .filter((f) => !allowed.has(f) && !f.startsWith('src/components/') && !f.startsWith('src/lib/') && !f.startsWith('src/server/connect/'));
    expect(offenders).toEqual([]);
  });

  it('connection code never logs', () => {
    const files = [...walk(path.join(webRoot, 'src', 'server', 'connect')), path.join(webRoot, 'src', 'server', 'actions', 'connect.ts'), path.join(webRoot, 'src', 'server', 'http', 'connect-handlers.ts'), path.join(webRoot, 'src', 'server', 'data', 'connect.ts')];
    for (const file of files) expect(fs.readFileSync(file, 'utf8'), file).not.toMatch(/console\.(log|error|warn|info|debug)/);
  });

  it('reads the host’s OAuth app from the environment in one place only', () => {
    const offenders = walk(path.join(webRoot, 'src'))
      .filter((f) => /BRAND_OS_(OAUTH|DEVICE)\b/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(webRoot, f).split(path.sep).join('/'));
    expect(offenders.sort()).toEqual(['src/server/connect/oauth.ts']);
  });
});
