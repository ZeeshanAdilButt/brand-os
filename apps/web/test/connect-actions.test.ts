import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cancelDevice, completeOAuth, connectWithFields, disconnectConnector, listConnectors, pollDeviceFlow, startDevice, startOAuth, testConnector } from '../src/server/actions/connect';
import { saveIntegrationSecret } from '../src/server/actions/integrations';
import { sessionToOwner, type OwnerContext } from '../src/server/actions/owner';
import type { DbHandle } from '../src/server/db/client';
import { users } from '../src/server/db/schema';
import { decodeBundle } from '../src/server/connect/bundle';
import { defaultLimits, type ConnectEnv } from '../src/server/connect/env';
import { readBundle } from '../src/server/connect/tokens';
import { CONNECTORS } from '../src/lib/connectors';
import { presetMapping } from '../src/lib/site-export';
import { exportMyData } from '../src/server/actions/export';
import { plainSecret } from '../src/server/publishing/registry';
import { createFakeDevto } from './helpers/fake-devto';
import { createFakeProviders, json, type FakeProviders } from './helpers/fake-providers';
import { memoryDb, sqlRows, testConfig } from './helpers';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
// Built at run time: the repository forbids key-shaped literals in tests.
const W = (...parts: string[]) => parts.join('-');
const API_KEY = W('fake', 'beehiiv', 'key', '4d5e6f');
const CLIENT_ID = W('fake', 'client', 'id', '8899aa');
const CLIENT_SECRET = W('fake', 'client', 'secret', 'b1c2d3');
const ACCESS = W('fake', 'access', 'one', 'e4f5a6');
const REFRESH = W('fake', 'refresh', 'one', 'a7b8c9');
const ACCESS2 = W('fake', 'access', 'two', 'd0e1f2');
const REFRESH2 = W('fake', 'refresh', 'two', '13a4b5');

let handle: DbHandle;
let fake: FakeProviders;
let clock: Date;
let env: ConnectEnv;

const as = (id: string, sessionId = 'local', actor: OwnerContext['actor'] = 'owner') => sessionToOwner({ userId: id, sessionId }, { db: handle.db }, actor);
let owner: OwnerContext;
let other: OwnerContext;

const everything = async (o: OwnerContext) => JSON.stringify([await listConnectors(o, env), await o.data.audit.list(500), await exportMyData(o)]);

const connectionRows = (ownerId: string) => sqlRows<Record<string, unknown>>(handle.db, sql`select * from platform_connections where owner_id = ${ownerId}`);
const flowRows = (ownerId: string) => sqlRows<Record<string, unknown>>(handle.db, sql`select * from connect_flows where owner_id = ${ownerId}`);

beforeAll(async () => {
  handle = await memoryDb();
  await handle.db.insert(users).values([
    { id: A, kind: 'member', displayName: 'Author A' },
    { id: B, kind: 'member', displayName: 'Author B' },
  ]);
});
afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await handle.db.execute(sql`delete from connect_flows`);
  await handle.db.execute(sql`delete from platform_connections`);
  await handle.db.execute(sql`delete from integration_secrets`);
  await handle.db.execute(sql`delete from site_settings`);
  fake = createFakeProviders();
  clock = new Date('2026-10-24T10:00:00Z');
  env = { config: testConfig(), fetchFn: fake.fetch, now: () => clock, timeoutMs: 2000, limits: defaultLimits(), sleep: async (ms) => void (clock = new Date(clock.getTime() + ms)) };
  owner = as(A);
  other = as(B);
});

const advance = (ms: number) => void (clock = new Date(clock.getTime() + ms));

function beehivReplies() {
  fake.on('GET', 'https://api.beehiiv.com/v2/publications', (r) => (r.headers.authorization === `Bearer ${API_KEY}` ? json({ data: [{ id: 'pub_1', name: 'The Notes' }] }) : json({ message: 'no' }, 401)));
}

describe('pasted keys', () => {
  it('checks the key first, then stores a sealed bundle, and never returns the key', async () => {
    beehivReplies();
    const result = await connectWithFields(owner, env, 'beehiiv', { fields: { apiKey: API_KEY } });
    expect(result.ok).toBe(true);
    expect(result.view.state).toBe('connected');
    expect(result.view.connection).toMatchObject({ platform: 'beehiiv', who: 'The Notes', status: 'connected', authKind: 'api_key', keyLast4: API_KEY.slice(-4) });
    expect(fake.requests).toHaveLength(1);

    const [row] = await connectionRows(A);
    expect(row).toMatchObject({ platform: 'beehiiv', auth_kind: 'api_key', status: 'connected', last_error_code: null, renewable: false, token_expires_at: null });
    expect(String(row!.encrypted_key).startsWith('v1.')).toBe(true);
    expect(JSON.stringify(row)).not.toContain(API_KEY);
    expect(await everything(owner)).not.toContain(API_KEY);
    // The sealed bundle opens only for this owner and this row.
    const stored = await owner.data.connections.getWithKey(String(row!.id));
    expect(readBundle(env, CONNECTORS.beehiiv, stored!).fields).toEqual({ apiKey: API_KEY });
  });

  it('stores nothing when the platform refuses the key, and says so without echoing it', async () => {
    beehivReplies();
    const bad = W('wrong', 'key', 'value', '00');
    const err = await connectWithFields(owner, env, 'beehiiv', { fields: { apiKey: bad } }).then(() => null, (e: unknown) => e as Error & { code: string; fields: Record<string, string> });
    expect(err?.code).toBe('invalid');
    expect(err?.message).toMatch(/did not accept/);
    expect(JSON.stringify(err)).not.toContain(bad);
    expect(await connectionRows(A)).toEqual([]);
    expect((await owner.data.audit.list(50)).some((e) => e.action === 'connect.failed')).toBe(true);
  });

  it('replaces the key of an existing connection in place', async () => {
    beehivReplies();
    await connectWithFields(owner, env, 'beehiiv', { fields: { apiKey: API_KEY } });
    const before = (await connectionRows(A))[0]!;
    const second = W('fake', 'beehiiv', 'key', 'second');
    fake.on('GET', 'https://api.beehiiv.com/v2/publications', { body: { data: [{ id: 'p', name: 'Second' }] } }, 1);
    await connectWithFields(owner, env, 'beehiiv', { fields: { apiKey: second } });
    const rows = await connectionRows(A);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(before.id);
    expect(rows[0]!.who).toBe('Second');
    expect(Number(rows[0]!.refresh_generation)).toBeGreaterThan(Number(before.refresh_generation));
  });

  it('checks the shape of each field before any request', async () => {
    const err = await connectWithFields(owner, env, 'discord', { fields: { webhookUrl: 'https://evil.example.test/x' } }).then(() => null, (e: unknown) => e as { fields: Record<string, string>; code: string });
    expect(err?.code).toBe('invalid');
    expect(Object.keys(err?.fields ?? {})).toContain('webhookUrl');
    const missing = await connectWithFields(owner, env, 'github_releases', { fields: { token: API_KEY } }).then(() => null, (e: unknown) => e as { fields: Record<string, string> });
    expect(missing?.fields.repo).toBeTruthy();
    expect(fake.requests).toHaveLength(0);
  });

  it('refuses a platform that signs in, a manual one and an unverified one', async () => {
    await expect(connectWithFields(owner, env, 'x', { fields: {} })).rejects.toMatchObject({ code: 'conflict', data: { code: 'NOT_PASTED' } });
    await expect(connectWithFields(owner, env, 'medium', { fields: {} })).rejects.toMatchObject({ code: 'conflict' });
    await expect(connectWithFields(owner, env, 'slack', { fields: { webhookUrl: 'https://hooks.slack.com/services/T0/B0/abc' } })).rejects.toMatchObject({ code: 'conflict', data: { code: 'UNVERIFIED' } });
    await expect(connectWithFields(owner, env, 'buttondown', { fields: { apiKey: API_KEY } })).rejects.toMatchObject({ code: 'conflict', data: { code: 'UNVERIFIED' } });
    await expect(connectWithFields(owner, env, 'nowhere', { fields: {} })).rejects.toMatchObject({ code: 'not_found' });
    expect(fake.requests).toHaveLength(0);
  });

  it('rate limits attempts per owner and platform', async () => {
    for (let i = 0; i < 10; i++) await connectWithFields(owner, env, 'beehiiv', { fields: { apiKey: `${API_KEY}${i}` } }).catch(() => undefined);
    await expect(connectWithFields(owner, env, 'beehiiv', { fields: { apiKey: API_KEY } })).rejects.toMatchObject({ code: 'limit' });
    // Another platform and another owner are not slowed down.
    await expect(connectWithFields(owner, env, 'buffer', { fields: { apiKey: API_KEY } })).rejects.not.toMatchObject({ code: 'limit' });
    await expect(connectWithFields(other, env, 'beehiiv', { fields: { apiKey: API_KEY } })).rejects.not.toMatchObject({ code: 'limit' });
  });

  it('is isolated per owner', async () => {
    beehivReplies();
    await connectWithFields(owner, env, 'beehiiv', { fields: { apiKey: API_KEY } });
    expect((await listConnectors(other, env)).find((v) => v.id === 'beehiiv')?.connection).toBeNull();
    await expect(testConnector(other, env, 'beehiiv')).rejects.toMatchObject({ code: 'not_found' });
    await expect(disconnectConnector(other, env, 'beehiiv')).rejects.toMatchObject({ code: 'not_found' });
    expect((await listConnectors(owner, env)).find((v) => v.id === 'beehiiv')?.connection?.who).toBe('The Notes');
  });

  it('removes a key saved by an earlier version once the platform is connected', async () => {
    const id = '55555555-5555-4555-8555-555555555555';
    await owner.data.integrationSecrets.save({ id, platform: 'beehiiv', kind: 'api_key', encrypted: 'v1.x.y.z', hint: 'old1' });
    expect((await listConnectors(owner, env)).find((v) => v.id === 'beehiiv')?.legacyKeyHint).toBe('old1');
    beehivReplies();
    await connectWithFields(owner, env, 'beehiiv', { fields: { apiKey: API_KEY } });
    expect((await listConnectors(owner, env)).find((v) => v.id === 'beehiiv')?.legacyKeyHint).toBeNull();
  });
});

describe('the connectors that publish keep working with their adapters', () => {
  it('DEV.to stores a plain key (as before) that the publishing code still reads', async () => {
    const devto = createFakeDevto({ apiKey: API_KEY });
    const result = await connectWithFields(owner, { ...env, fetchFn: devto.fetch }, 'devto', { fields: { apiKey: API_KEY } });
    expect(result.view.publishes).toBe(true);
    expect(result.view.connection?.who).toBe('@fakeauthor');
    const row = await owner.data.connections.getWithKey(result.view.connection!.id);
    expect(plainSecret({ config: env.config }, row!)).toBe(API_KEY);
  });

  it('a sign-in stored for the personal site is unwrapped to its access token for the adapter', async () => {
    const bundleText = JSON.stringify({ cphBundle: 1, fields: {}, tokens: { accessToken: ACCESS, obtainedAt: clock.toISOString() } });
    expect(decodeBundle(bundleText, 'token').tokens?.accessToken).toBe(ACCESS);
  });
});

describe('testing a connection', () => {
  it('updates who and when after a good check', async () => {
    beehivReplies();
    await connectWithFields(owner, env, 'beehiiv', { fields: { apiKey: API_KEY } });
    advance(3600_000);
    fake.on('GET', 'https://api.beehiiv.com/v2/publications', { body: { data: [{ id: 'p', name: 'Renamed' }] } });
    const result = await testConnector(owner, env, 'beehiiv');
    expect(result).toMatchObject({ ok: true, account: 'Renamed' });
    expect(result.view.connection?.lastCheckedAt).toBe(clock.toISOString());
  });

  it('turns a refused key into Needs reconnect with a plain message, and a network failure into a quiet error', async () => {
    beehivReplies();
    await connectWithFields(owner, env, 'beehiiv', { fields: { apiKey: API_KEY } });
    fake.clear();
    fake.on('GET', 'https://api.beehiiv.com/v2/publications', { status: 401, body: { message: 'revoked' } });
    const refused = await testConnector(owner, env, 'beehiiv');
    expect(refused.ok).toBe(false);
    expect(refused.view.state).toBe('needs_reconnect');
    expect(refused.view.reconnect).toBe(true);
    expect(refused.view.connection?.lastErrorCode).toBe('rejected');
    fake.clear();
    const down = await testConnector(owner, { ...env, fetchFn: (() => Promise.reject(new TypeError('connect ECONNREFUSED'))) as unknown as typeof fetch }, 'beehiiv');
    expect(down.ok).toBe(false);
    expect(down.view.connection?.lastErrorCode).toBe('unreachable');
    // Not being able to reach the platform is not a lost key: it stays Connected with a quiet note.
    expect(down.view.state).toBe('connected');
    expect(down.view.detail).toMatch(/could not reach/);
    expect(down.view.reconnect).toBe(false);
    // A good check afterwards clears it.
    beehivReplies();
    fake.clear();
    beehivReplies();
    expect((await testConnector(owner, env, 'beehiiv')).view.state).toBe('connected');
  });

  it('a passing check from the older connection routes clears the failure code too, so the two never disagree', async () => {
    beehivReplies();
    await connectWithFields(owner, env, 'beehiiv', { fields: { apiKey: API_KEY } });
    fake.on('GET', 'https://api.beehiiv.com/v2/publications', { status: 401, body: {} });
    const refused = await testConnector(owner, env, 'beehiiv');
    expect(refused.view.state).toBe('needs_reconnect');
    await owner.data.connections.recordCheck(refused.view.connection!.id, { status: 'connected', who: 'The Notes', message: null });
    const after = (await listConnectors(owner, env)).find((v) => v.id === 'beehiiv')!;
    expect(after.connection?.lastErrorCode).toBeNull();
    expect(after.state).toBe('connected');
  });

  it('is limited per owner and platform', async () => {
    beehivReplies();
    await connectWithFields(owner, env, 'beehiiv', { fields: { apiKey: API_KEY } });
    for (let i = 0; i < 12; i++) await testConnector(owner, env, 'beehiiv');
    await expect(testConnector(owner, env, 'beehiiv')).rejects.toMatchObject({ code: 'limit' });
  });

  it('has nothing to test for a manual platform, and says to connect first otherwise', async () => {
    await expect(testConnector(owner, env, 'medium')).rejects.toMatchObject({ code: 'conflict' });
    await expect(testConnector(owner, env, 'beehiiv')).rejects.toMatchObject({ code: 'not_found' });
  });
});

// ---- OAuth ----------------------------------------------------------------------------------------------------

const b64u = (hash: Buffer) => hash.toString('base64url');
const challengeOf = (verifier: string) => b64u(createHash('sha256').update(verifier).digest());

async function saveApp(o: OwnerContext, platform: string, kind: 'oauth_client' | 'device_client' = 'oauth_client', secret = true) {
  await saveIntegrationSecret(o, env, { platform, kind, clientId: CLIENT_ID, ...(secret ? { clientSecret: CLIENT_SECRET } : {}) });
}

/** Run start, "approve on the platform" and the callback for X against the fake. */
function xRoutes(tokens: { access?: string; refresh?: string; expiresIn?: number } = {}) {
  let challenge = '';
  fake.on('POST', 'https://api.x.com/2/oauth2/token', (r) => {
    if (r.form.grant_type === 'authorization_code') {
      if (challengeOf(r.form.code_verifier ?? '') !== challenge) return json({ error: 'invalid_grant', error_description: 'bad verifier' }, 400);
      return json({ token_type: 'bearer', access_token: tokens.access ?? ACCESS, refresh_token: tokens.refresh ?? REFRESH, expires_in: tokens.expiresIn ?? 7200, scope: 'users.read tweet.read offline.access' });
    }
    return json({ error: 'unsupported_grant_type' }, 400);
  });
  fake.on('GET', 'https://api.x.com/2/users/me', (r) => (r.headers.authorization?.startsWith('Bearer ') ? json({ data: { id: '1', name: 'Fake', username: 'fakewriter' } }) : json({}, 401)));
  return { setChallenge: (c: string) => void (challenge = c) };
}

function paramsOf(authorizeUrl: string) {
  const url = new URL(authorizeUrl);
  return { url, state: url.searchParams.get('state') ?? '', challenge: url.searchParams.get('code_challenge') ?? '', redirect: url.searchParams.get('redirect_uri') ?? '' };
}

describe('sign in with OAuth and PKCE', () => {
  it('needs the owner’s own app first, with a plain message', async () => {
    await expect(startOAuth(owner, env, 'x')).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/Save your X app first/) });
  });

  it('sends the person to the platform with S256 PKCE, a random state, the exact redirect address and only the scopes asked for', async () => {
    await saveApp(owner, 'x');
    const started = await startOAuth(owner, env, 'x', { scopes: ['tweet.write'] });
    const { url, state, challenge, redirect } = paramsOf(started.authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://x.com/i/oauth2/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(redirect).toBe('http://127.0.0.1:3100/api/connect/x/callback');
    expect(started.redirectUri).toBe(redirect);
    expect(url.searchParams.get('scope')?.split(' ').sort()).toEqual(['offline.access', 'tweet.read', 'tweet.write', 'users.read']);
    expect(url.toString()).not.toContain(CLIENT_SECRET);
  });

  it('keeps the state only as a hash and the verifier only as ciphertext, bound to this session', async () => {
    await saveApp(owner, 'x');
    const { authorizeUrl } = await startOAuth(owner, env, 'x');
    const { state, challenge } = paramsOf(authorizeUrl);
    const [flow] = await flowRows(A);
    expect(flow).toMatchObject({ platform: 'x', kind: 'oauth', status: 'pending' });
    expect(flow!.state_hash).toBe(createHash('sha256').update(state).digest('hex'));
    expect(JSON.stringify(flow)).not.toContain(state);
    expect(String(flow!.code_verifier_enc).startsWith('v1.')).toBe(true);
    expect(flow!.session_hash).toBe(createHash('sha256').update('local').digest('hex'));
    expect(challenge).toHaveLength(43);
  });

  it('uses 127.0.0.1 for a local app even when the browser used localhost', async () => {
    await saveApp(owner, 'x');
    const started = await startOAuth(owner, { ...env, config: testConfig({ appUrl: 'http://localhost:3100' }) }, 'x');
    expect(started.redirectUri).toBe('http://127.0.0.1:3100/api/connect/x/callback');
    const hosted = await startOAuth(owner, { ...env, config: testConfig({ mode: 'hosted', appUrl: 'https://app.example.test', appSecret: 'z'.repeat(40) }), processEnv: {}, limits: defaultLimits() }, 'x').catch((e: unknown) => e);
    expect(hosted).toBeDefined();
  });

  it('completes the sign-in: exchanges the code with the verifier, checks it, and stores the tokens sealed', async () => {
    await saveApp(owner, 'x');
    const route = xRoutes();
    const { authorizeUrl } = await startOAuth(owner, env, 'x');
    const { state, challenge } = paramsOf(authorizeUrl);
    route.setChallenge(challenge);
    const done = await completeOAuth(owner, env, 'x', { code: W('fake', 'code', '123'), state });
    expect(done).toEqual({ platform: 'x', code: 'connected' });

    const tokenCall = fake.callsTo('https://api.x.com/2/oauth2/token')[0]!;
    expect(tokenCall.form).toMatchObject({ grant_type: 'authorization_code', code: W('fake', 'code', '123'), redirect_uri: 'http://127.0.0.1:3100/api/connect/x/callback' });
    expect(tokenCall.form.client_id).toBeUndefined(); // a confidential client signs in with HTTP Basic
    expect(tokenCall.headers.authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`);

    const [row] = await connectionRows(A);
    expect(row).toMatchObject({ platform: 'x', auth_kind: 'oauth2_code_pkce', who: '@fakewriter', renewable: true, status: 'connected', key_last4: '' });
    expect(new Date(String(row!.token_expires_at)).toISOString()).toBe(new Date(clock.getTime() + 7200_000).toISOString());
    expect(row!.scopes_granted).toEqual(['users.read', 'tweet.read', 'offline.access']);
    expect(JSON.stringify(row)).not.toContain(ACCESS);
    expect(JSON.stringify(row)).not.toContain(REFRESH);
    const stored = await owner.data.connections.getWithKey(String(row!.id));
    expect(readBundle(env, CONNECTORS.x, stored!).tokens).toMatchObject({ accessToken: ACCESS, refreshToken: REFRESH });
    expect(await everything(owner)).not.toContain(ACCESS);
    expect(await everything(owner)).not.toContain(REFRESH);
    expect(await everything(owner)).not.toContain(CLIENT_SECRET);
    expect((await listConnectors(owner, env)).find((v) => v.id === 'x')?.state).toBe('connected');
  });

  it('spends a state once: the same callback a second time is refused and nothing more is sent', async () => {
    await saveApp(owner, 'x');
    const route = xRoutes();
    const { authorizeUrl } = await startOAuth(owner, env, 'x');
    const { state, challenge } = paramsOf(authorizeUrl);
    route.setChallenge(challenge);
    expect((await completeOAuth(owner, env, 'x', { code: 'abc', state })).code).toBe('connected');
    fake.requests.length = 0;
    expect((await completeOAuth(owner, env, 'x', { code: 'abc', state })).code).toBe('state');
    expect(fake.requests).toHaveLength(0);
  });

  it('refuses a state that is unknown, malformed, for another platform or from another session', async () => {
    await saveApp(owner, 'x');
    await saveApp(owner, 'linkedin');
    const route = xRoutes();
    const { authorizeUrl } = await startOAuth(owner, env, 'x');
    const { state, challenge } = paramsOf(authorizeUrl);
    route.setChallenge(challenge);
    expect((await completeOAuth(owner, env, 'x', { code: 'abc', state: 'short' })).code).toBe('state');
    expect((await completeOAuth(owner, env, 'x', { code: 'abc', state: 'a'.repeat(43) })).code).toBe('state');
    expect((await completeOAuth(owner, env, 'linkedin', { code: 'abc', state })).code).toBe('state');
    expect((await completeOAuth(owner, env, 'x', { code: 'abc', state: null })).code).toBe('state');
    // The same person in a different browser session cannot finish it, and the state stays usable by the right session.
    const elsewhere = as(A, 'another-session');
    expect((await completeOAuth(elsewhere, env, 'x', { code: 'abc', state })).code).toBe('session');
    expect(fake.callsTo('https://api.x.com/2/oauth2/token')).toHaveLength(0);
    expect((await completeOAuth(owner, env, 'x', { code: 'abc', state })).code).toBe('connected');
    // Another account never finds it at all.
    const { authorizeUrl: second } = await startOAuth(owner, env, 'x');
    expect((await completeOAuth(other, env, 'x', { code: 'abc', state: paramsOf(second).state })).code).toBe('state');
  });

  it('expires a state after ten minutes', async () => {
    await saveApp(owner, 'x');
    xRoutes();
    const { authorizeUrl } = await startOAuth(owner, env, 'x');
    advance(11 * 60_000);
    expect((await completeOAuth(owner, env, 'x', { code: 'abc', state: paramsOf(authorizeUrl).state })).code).toBe('expired');
    expect(fake.requests).toHaveLength(0);
  });

  it('turns a refusal on the platform into a result code and stores nothing', async () => {
    await saveApp(owner, 'x');
    xRoutes();
    const { authorizeUrl } = await startOAuth(owner, env, 'x');
    expect((await completeOAuth(owner, env, 'x', { error: 'access_denied', state: paramsOf(authorizeUrl).state })).code).toBe('denied');
    expect(await connectionRows(A)).toEqual([]);
    const second = await startOAuth(owner, env, 'x');
    // The code is wrong for the verifier (the fake never learned the challenge): the platform says invalid_grant.
    const result = await completeOAuth(owner, env, 'x', { code: 'abc', state: paramsOf(second.authorizeUrl).state });
    expect(result.code).toBe('expired');
    expect(await connectionRows(A)).toEqual([]);
  });

  it('a new attempt replaces an older pending one', async () => {
    await saveApp(owner, 'x');
    const first = await startOAuth(owner, env, 'x');
    await startOAuth(owner, env, 'x');
    const flows = await flowRows(A);
    expect(flows.filter((f) => f.status === 'pending')).toHaveLength(1);
    expect((await completeOAuth(owner, env, 'x', { code: 'abc', state: paramsOf(first.authorizeUrl).state })).code).toBe('state');
  });

  it('LinkedIn sends no PKCE challenge (not documented) and trades the code with the client secret in the body', async () => {
    await saveApp(owner, 'linkedin');
    const { authorizeUrl } = await startOAuth(owner, env, 'linkedin', { scopes: ['w_member_social'] });
    const { url, state } = paramsOf(authorizeUrl);
    expect(url.searchParams.get('code_challenge')).toBeNull();
    expect(url.searchParams.get('scope')).toBe('openid profile w_member_social');
    fake.on('POST', 'https://www.linkedin.com/oauth/v2/accessToken', (r) => (r.form.client_secret === CLIENT_SECRET && r.form.client_id === CLIENT_ID && !r.form.code_verifier ? json({ access_token: ACCESS, expires_in: 5184000, scope: 'openid,profile,w_member_social' }) : json({ error: 'invalid_client' }, 401)));
    fake.on('GET', 'https://api.linkedin.com/v2/userinfo', { body: { sub: 's1', name: 'Fake Person' } });
    expect((await completeOAuth(owner, env, 'linkedin', { code: 'abc', state })).code).toBe('connected');
    const [row] = await connectionRows(A);
    expect(row!.scopes_granted).toEqual(['openid', 'profile', 'w_member_social']);
    expect(row!.renewable).toBe(false);
    const view = (await listConnectors(owner, env)).find((v) => v.id === 'linkedin')!;
    expect(view.expiresInDays).toBe(60);
    // LinkedIn video follows the LinkedIn sign-in because posting was allowed.
    expect((await listConnectors(owner, env)).find((v) => v.id === 'linkedin_video')?.state).toBe('connected');
  });

  it('LinkedIn: 60 days later the sign-in needs reconnecting, and a week before it asks quietly', async () => {
    await saveApp(owner, 'linkedin');
    const { authorizeUrl } = await startOAuth(owner, env, 'linkedin');
    fake.on('POST', 'https://www.linkedin.com/oauth/v2/accessToken', { body: { access_token: ACCESS, expires_in: 5184000, scope: 'openid profile' } });
    fake.on('GET', 'https://api.linkedin.com/v2/userinfo', { body: { sub: 's1', name: 'Fake Person' } });
    await completeOAuth(owner, env, 'linkedin', { code: 'abc', state: paramsOf(authorizeUrl).state });
    advance(55 * 86_400_000);
    const soon = (await listConnectors(owner, env)).find((v) => v.id === 'linkedin')!;
    expect(soon).toMatchObject({ state: 'connected', reconnect: true });
    advance(6 * 86_400_000);
    const lost = await testConnector(owner, env, 'linkedin');
    expect(lost.ok).toBe(false);
    expect(lost.message).toMatch(/sign-in has expired/);
    expect(lost.view).toMatchObject({ state: 'needs_reconnect', reconnect: true });
    expect(fake.callsTo('https://api.linkedin.com/v2/userinfo').length).toBe(1);
  });

  it('Threads trades the first token for a 60 day one and renews it once it is a day old', async () => {
    await saveApp(owner, 'threads');
    const { authorizeUrl } = await startOAuth(owner, env, 'threads');
    const { url, state } = paramsOf(authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://threads.com/oauth/authorize');
    expect(url.searchParams.get('code_challenge')).toBeNull();
    fake.on('POST', 'https://graph.threads.com/oauth/access_token', { body: { access_token: 'short-lived-token-xx', user_id: '1' } });
    fake.on('GET', 'https://graph.threads.com/access_token', (r) => (new URL(r.url).searchParams.get('grant_type') === 'th_exchange_token' && new URL(r.url).searchParams.get('access_token') === 'short-lived-token-xx' ? json({ access_token: ACCESS, token_type: 'bearer', expires_in: 5184000 }) : json({ error: { message: 'bad' } }, 400)));
    fake.on('GET', 'https://graph.threads.com/me', (r) => (new URL(r.url).searchParams.get('access_token') === ACCESS ? json({ id: '1', username: 'fakewriter' }) : json({}, 400)));
    expect((await completeOAuth(owner, env, 'threads', { code: 'abc', state })).code).toBe('connected');
    expect(fake.callsTo('https://graph.threads.com/oauth/access_token')[0]!.form.client_secret).toBe(CLIENT_SECRET);
    expect((await listConnectors(owner, env)).find((v) => v.id === 'threads')?.connection?.renewable).toBe(true);

    // Not renewed while it is young and healthy.
    advance(2 * 86_400_000);
    fake.on('GET', 'https://graph.threads.com/refresh_access_token', { body: { access_token: ACCESS2, token_type: 'bearer', expires_in: 5184000 } });
    await testConnector(owner, env, 'threads');
    expect(fake.callsTo('https://graph.threads.com/refresh_access_token')).toHaveLength(0);
    // In the second half of its life it is renewed.
    advance(35 * 86_400_000);
    fake.on('GET', 'https://graph.threads.com/me', (r) => (new URL(r.url).searchParams.get('access_token') === ACCESS2 ? json({ id: '1', username: 'fakewriter' }) : json({}, 400)));
    expect((await testConnector(owner, env, 'threads')).ok).toBe(true);
    expect(fake.callsTo('https://graph.threads.com/refresh_access_token')).toHaveLength(1);
    expect(new URL(fake.callsTo('https://graph.threads.com/refresh_access_token')[0]!.url).searchParams.get('grant_type')).toBe('th_refresh_token');
  });
});

describe('Mastodon registers a client on the person’s own instance', () => {
  const instance = 'https://mastodon.example.test';
  function mastodonRoutes() {
    fake.on('POST', `${instance}/api/v1/apps`, (r) => json({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: r.form.redirect_uris }));
    fake.on('POST', `${instance}/oauth/token`, { body: { access_token: ACCESS, token_type: 'Bearer', scope: 'read:accounts', created_at: 1 } });
    fake.on('GET', `${instance}/api/v1/accounts/verify_credentials`, { body: { acct: 'writer', username: 'writer' } });
    fake.on('POST', `${instance}/oauth/revoke`, { body: {} });
  }

  it('registers once, reuses the client, sends PKCE, and revokes the token on Disconnect', async () => {
    mastodonRoutes();
    const started = await startOAuth(owner, env, 'mastodon', { instance });
    const { url, state, challenge } = paramsOf(started.authorizeUrl);
    expect(url.origin + url.pathname).toBe(`${instance}/oauth/authorize`);
    expect(challenge).toHaveLength(43);
    const registration = fake.callsTo(`${instance}/api/v1/apps`)[0]!;
    expect(registration.form).toMatchObject({ client_name: 'Brand OS', redirect_uris: 'http://127.0.0.1:3100/api/connect/mastodon/callback', scopes: 'read:accounts' });
    expect(registration.headers.authorization).toBeUndefined();

    expect((await completeOAuth(owner, env, 'mastodon', { code: 'abc', state })).code).toBe('connected');
    expect(fake.callsTo(`${instance}/oauth/token`)[0]!.form).toMatchObject({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code_verifier: expect.any(String) });
    const view = (await listConnectors(owner, env)).find((v) => v.id === 'mastodon')!;
    expect(view.connection).toMatchObject({ who: '@writer@mastodon.example.test', renewable: false, tokenExpiresAt: null });
    expect(view.state).toBe('connected');

    // A second sign-in on the same instance reuses the registered client.
    await startOAuth(owner, env, 'mastodon', { instance });
    expect(fake.callsTo(`${instance}/api/v1/apps`)).toHaveLength(1);

    const gone = await disconnectConnector(owner, env, 'mastodon');
    expect(gone.revoked).toBe('provider');
    expect(fake.callsTo(`${instance}/oauth/revoke`)[0]!.form).toMatchObject({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, token: ACCESS });
    expect(await connectionRows(A)).toEqual([]);
  });

  it('asks for more scopes by registering a new client, and refuses a private address when hosted', async () => {
    mastodonRoutes();
    await startOAuth(owner, env, 'mastodon', { instance });
    await startOAuth(owner, env, 'mastodon', { instance, scopes: ['write:statuses'] });
    expect(fake.callsTo(`${instance}/api/v1/apps`)).toHaveLength(2);
    const hosted = { ...env, config: testConfig({ mode: 'hosted', appUrl: 'https://app.example.test', appSecret: 'z'.repeat(40) }), limits: defaultLimits() };
    await expect(startOAuth(owner, hosted, 'mastodon', { instance: 'https://10.0.0.5' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(startOAuth(owner, hosted, 'mastodon', { instance: 'http://mastodon.example.test' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('rejects a scope the connector does not offer', async () => {
    await expect(startOAuth(owner, env, 'mastodon', { instance, scopes: ['admin:write'] })).rejects.toMatchObject({ code: 'invalid' });
    await saveApp(owner, 'x');
    await expect(startOAuth(owner, env, 'x', { scopes: ['dm.write'] })).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('renewal under a lock', () => {
  async function connectX() {
    await saveApp(owner, 'x');
    const route = xRoutes({ expiresIn: 7200 });
    const { authorizeUrl } = await startOAuth(owner, env, 'x');
    const { state, challenge } = paramsOf(authorizeUrl);
    route.setChallenge(challenge);
    await completeOAuth(owner, env, 'x', { code: 'abc', state });
    fake.clear();
  }

  function refreshRoute(options: { rotate?: boolean } = {}) {
    let calls = 0;
    fake.on('POST', 'https://api.x.com/2/oauth2/token', async (r) => {
      calls += 1;
      await Promise.resolve();
      if (r.form.grant_type !== 'refresh_token' || r.form.refresh_token !== REFRESH) return json({ error: 'invalid_grant', error_description: 'refresh token was used already' }, 400);
      return json({ token_type: 'bearer', access_token: ACCESS2, refresh_token: options.rotate === false ? undefined : REFRESH2, expires_in: 7200, scope: 'users.read tweet.read offline.access' });
    });
    fake.on('GET', 'https://api.x.com/2/users/me', (r) => (r.headers.authorization === `Bearer ${ACCESS2}` ? json({ data: { username: 'fakewriter' } }) : json({}, 401)));
    return { calls: () => calls };
  }

  it('renews an expiring token before the call and stores the rotated refresh token', async () => {
    await connectX();
    const route = refreshRoute();
    advance(7100_000);
    const result = await testConnector(owner, env, 'x');
    expect(result.ok).toBe(true);
    expect(route.calls()).toBe(1);
    const form = fake.callsTo('https://api.x.com/2/oauth2/token')[0]!.form;
    expect(form).toMatchObject({ grant_type: 'refresh_token', refresh_token: REFRESH });
    const [row] = await connectionRows(A);
    const stored = await owner.data.connections.getWithKey(String(row!.id));
    expect(readBundle(env, CONNECTORS.x, stored!).tokens).toMatchObject({ accessToken: ACCESS2, refreshToken: REFRESH2 });
    expect(Number(row!.refresh_generation)).toBe(1);
    expect(row!.refresh_lock_until).toBeNull();
    expect(new Date(String(row!.token_expires_at)).getTime()).toBe(clock.getTime() + 7200_000);
  });

  it('two requests that both see an expiring token renew once: one waits and reads the new token', async () => {
    await connectX();
    const route = refreshRoute();
    advance(7100_000);
    const [one, two] = await Promise.all([testConnector(owner, env, 'x'), testConnector(owner, env, 'x')]);
    expect(one.ok).toBe(true);
    expect(two.ok).toBe(true);
    expect(route.calls()).toBe(1);
    expect(fake.callsTo('https://api.x.com/2/users/me').every((r) => r.headers.authorization === `Bearer ${ACCESS2}`)).toBe(true);
  });

  it('five at once still renew once', async () => {
    await connectX();
    const route = refreshRoute();
    advance(7100_000);
    const all = await Promise.all([1, 2, 3, 4, 5].map(() => testConnector(owner, { ...env, limits: defaultLimits() }, 'x')));
    expect(all.every((r) => r.ok)).toBe(true);
    expect(route.calls()).toBe(1);
  });

  it('does not renew a token that still has time', async () => {
    await connectX();
    const route = refreshRoute();
    advance(3600_000);
    fake.on('GET', 'https://api.x.com/2/users/me', { body: { data: { username: 'fakewriter' } } });
    await testConnector(owner, env, 'x');
    expect(route.calls()).toBe(0);
  });

  it('marks the connection Needs reconnect when the refresh token is refused, frees the lock, and keeps the old secret out of the message', async () => {
    await connectX();
    fake.on('POST', 'https://api.x.com/2/oauth2/token', { status: 400, body: { error: 'invalid_grant', error_description: `refresh token ${REFRESH} was revoked` } });
    advance(7100_000);
    const result = await testConnector(owner, env, 'x');
    expect(result.ok).toBe(false);
    expect(result.view.state).toBe('needs_reconnect');
    expect(result.message).not.toContain(REFRESH);
    const [row] = await connectionRows(A);
    expect(row!.refresh_lock_until).toBeNull();
    expect(row!.last_error_code).toBe('expired');
  });

  it('a lease that was never released is taken over after it expires', async () => {
    await connectX();
    const route = refreshRoute();
    const [row] = await connectionRows(A);
    const taken = await owner.data.connectors.acquireRefreshLease(String(row!.id), clock, 30_000);
    expect(taken).toBe(0);
    expect(await owner.data.connectors.acquireRefreshLease(String(row!.id), clock, 30_000)).toBeNull();
    advance(7100_000 + 31_000);
    expect((await testConnector(owner, env, 'x')).ok).toBe(true);
    expect(route.calls()).toBe(1);
  });

  it('a renewal never overwrites a reconnect made while it was running', async () => {
    await connectX();
    const [row] = await connectionRows(A);
    const generation = await owner.data.connectors.acquireRefreshLease(String(row!.id), clock, 30_000);
    // The person reconnects in the meantime: the generation moves on.
    await owner.data.connectors.save({ id: String(row!.id), platform: 'x', encryptedKey: String(row!.encrypted_key), keyLast4: '', status: 'connected', who: '@fakewriter', config: {}, authKind: 'oauth2_code_pkce', scopesGranted: [], tokenExpiresAt: null, renewable: true, message: null });
    const stored = await owner.data.connectors.completeRefresh(String(row!.id), generation!, { encryptedKey: 'v1.a.b.c', tokenExpiresAt: null, renewable: true, now: clock });
    expect(stored).toBe(false);
    expect((await connectionRows(A))[0]!.encrypted_key).toBe(row!.encrypted_key);
  });
});

describe('sign in with a code (device flow)', () => {
  const GH = 'https://github.com';
  function githubRoutes() {
    fake.on('POST', `${GH}/login/device/code`, { body: { device_code: W('fake', 'device', 'code', '9z'), user_code: 'WDJB-MJHT', verification_uri: `${GH}/login/device`, expires_in: 900, interval: 5 } });
    fake.on('GET', 'https://api.github.com/repos/example-owner/example-site', { body: { full_name: 'example-owner/example-site', permissions: { push: true } } });
  }
  async function saveSite() {
    await owner.data.siteSettings.save({ siteUrl: 'https://example-blog.dev', repo: 'example-owner/example-site', baseBranch: 'main', pathTemplate: 'content/{slug}.md', preset: 'generic', mapping: presetMapping('generic') });
  }

  it('asks for a code, shows it, polls at the platform’s pace and connects when the person has entered it', async () => {
    await saveApp(owner, 'site', 'device_client', false);
    githubRoutes();
    await saveSite();
    const flow = await startDevice(owner, env, 'site');
    expect(flow).toMatchObject({ userCode: 'WDJB-MJHT', verificationUri: `${GH}/login/device`, intervalSec: 5 });
    expect(fake.callsTo(`${GH}/login/device/code`)[0]!.form).toMatchObject({ client_id: CLIENT_ID, scope: 'repo' });
    const [row] = await flowRows(A);
    expect(String(row!.device_code_enc).startsWith('v1.')).toBe(true);
    expect(JSON.stringify(row)).not.toContain(W('fake', 'device', 'code', '9z'));

    // Polling sooner than the interval asks nothing of the platform.
    const early = await pollDeviceFlow(owner, env, 'site', flow.flowId);
    expect(early).toMatchObject({ state: 'pending' });
    expect(fake.callsTo(`${GH}/login/oauth/access_token`)).toHaveLength(0);

    let polls = 0;
    fake.on('POST', `${GH}/login/oauth/access_token`, () => {
      polls += 1;
      if (polls === 1) return json({ error: 'authorization_pending' }, 200);
      if (polls === 2) return json({ error: 'slow_down', interval: 10 }, 200);
      return json({ access_token: ACCESS, token_type: 'bearer', scope: 'repo' });
    });
    advance(6000);
    expect(await pollDeviceFlow(owner, env, 'site', flow.flowId)).toMatchObject({ state: 'pending', intervalSec: 5 });
    expect(fake.callsTo(`${GH}/login/oauth/access_token`)[0]!.form).toMatchObject({ client_id: CLIENT_ID, device_code: W('fake', 'device', 'code', '9z'), grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
    expect(fake.callsTo(`${GH}/login/oauth/access_token`)[0]!.form.client_secret).toBeUndefined();
    advance(6000);
    expect(await pollDeviceFlow(owner, env, 'site', flow.flowId)).toMatchObject({ state: 'pending', intervalSec: 10 });
    advance(11_000);
    const done = await pollDeviceFlow(owner, env, 'site', flow.flowId);
    expect(done.state).toBe('connected');
    const [conn] = await connectionRows(A);
    expect(conn).toMatchObject({ platform: 'site', auth_kind: 'device_flow', status: 'connected' });
    expect(JSON.stringify(conn)).not.toContain(ACCESS);
    // The publishing code receives the access token, not the bundle.
    const stored = await owner.data.connections.getWithKey(String(conn!.id));
    expect(plainSecret({ config: env.config }, stored!)).toBe(ACCESS);
    expect(await everything(owner)).not.toContain(ACCESS);
    expect(await flowRows(A)).toHaveLength(1);
    expect((await flowRows(A))[0]!.status).toBe('used');
  });

  it('shows the pending code in the connector view and stops waiting on Cancel', async () => {
    await saveApp(owner, 'site', 'device_client', false);
    githubRoutes();
    await startDevice(owner, env, 'site');
    expect((await listConnectors(owner, env)).find((v) => v.id === 'site')?.device).toMatchObject({ userCode: 'WDJB-MJHT' });
    const view = await cancelDevice(owner, env, 'site');
    expect(view.device).toBeNull();
    expect((await flowRows(A))[0]!.status).toBe('cancelled');
  });

  it('reports an expired or declined code in plain words', async () => {
    await saveApp(owner, 'site', 'device_client', false);
    githubRoutes();
    const flow = await startDevice(owner, env, 'site');
    fake.on('POST', `${GH}/login/oauth/access_token`, { body: { error: 'access_denied' } }, 1);
    advance(6000);
    expect(await pollDeviceFlow(owner, env, 'site', flow.flowId)).toMatchObject({ state: 'denied' });
    githubRoutes();
    const second = await startDevice(owner, env, 'site');
    advance(16 * 60_000);
    expect(await pollDeviceFlow(owner, env, 'site', second.flowId)).toMatchObject({ state: 'expired' });
  });

  it('only the session that asked can poll, and another account cannot see the flow', async () => {
    await saveApp(owner, 'site', 'device_client', false);
    githubRoutes();
    const flow = await startDevice(owner, env, 'site');
    await expect(pollDeviceFlow(as(A, 'another-session'), env, 'site', flow.flowId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(pollDeviceFlow(other, env, 'site', flow.flowId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(pollDeviceFlow(owner, env, 'x', flow.flowId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(pollDeviceFlow(owner, env, 'site', 'not-a-uuid')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('explains a device flow that is switched off on the platform', async () => {
    await saveApp(owner, 'site', 'device_client', false);
    fake.on('POST', `${GH}/login/device/code`, { status: 200, body: { error: 'device_flow_disabled' } });
    await expect(startDevice(owner, env, 'site')).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/Turn on the device flow/) });
  });

  it('refuses a verification address that is not plain https (it becomes a link), and a code that is not a code', async () => {
    await saveApp(owner, 'site', 'device_client', false);
    for (const uri of ['javascript:alert(1)', 'http://evil.example.test/device', 'https://exa mple.test/device']) {
      fake.on('POST', `${GH}/login/device/code`, { body: { device_code: 'd'.repeat(20), user_code: 'ABCD-1234', verification_uri: uri, expires_in: 900, interval: 5 } });
      await expect(startDevice(owner, env, 'site'), uri).rejects.toMatchObject({ code: 'unavailable' });
    }
    fake.on('POST', `${GH}/login/device/code`, { body: { device_code: 'd'.repeat(20), user_code: '<script>', verification_uri: `${GH}/login/device`, expires_in: 900, interval: 5 } });
    await expect(startDevice(owner, env, 'site')).rejects.toMatchObject({ code: 'unavailable' });
    expect(await flowRows(A)).toEqual([]);
  });

  it('Google needs the secret when polling, offers only the read-only YouTube scope, and revokes on Disconnect', async () => {
    await saveApp(owner, 'youtube', 'device_client', true);
    fake.on('POST', 'https://oauth2.googleapis.com/device/code', { body: { device_code: W('fake', 'google', 'device', '1'), user_code: 'ABCD-EFGH', verification_url: 'https://www.google.com/device', expires_in: 1800, interval: 5 } });
    const flow = await startDevice(owner, env, 'youtube');
    expect(flow.verificationUri).toBe('https://www.google.com/device');
    expect(fake.callsTo('https://oauth2.googleapis.com/device/code')[0]!.form.scope).toBe('https://www.googleapis.com/auth/youtube.readonly');
    await expect(startDevice(owner, env, 'youtube', { scopes: ['https://www.googleapis.com/auth/youtube.upload'] })).rejects.toMatchObject({ code: 'invalid' });
    fake.on('POST', 'https://oauth2.googleapis.com/token', { body: { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, scope: 'https://www.googleapis.com/auth/youtube.readonly', token_type: 'Bearer' } });
    fake.on('GET', 'https://www.googleapis.com/youtube/v3/channels', { body: { items: [{ snippet: { title: 'Fake Channel' } }] } });
    fake.on('POST', 'https://oauth2.googleapis.com/revoke', { body: {} });
    advance(6000);
    expect((await pollDeviceFlow(owner, env, 'youtube', flow.flowId)).state).toBe('connected');
    expect(fake.callsTo('https://oauth2.googleapis.com/token')[0]!.form.client_secret).toBe(CLIENT_SECRET);
    const gone = await disconnectConnector(owner, env, 'youtube');
    expect(gone.revoked).toBe('provider');
    expect(fake.callsTo('https://oauth2.googleapis.com/revoke')[0]!.form.token).toBe(REFRESH);
  });
});

describe('disconnecting', () => {
  it('deletes the stored secret and tells the person what is left to do on the platform', async () => {
    beehivReplies();
    await connectWithFields(owner, env, 'beehiiv', { fields: { apiKey: API_KEY } });
    const result = await disconnectConnector(owner, env, 'beehiiv');
    expect(result.revoked).toBe('manual');
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.message).toMatch(/stored secret was deleted/);
    expect(await connectionRows(A)).toEqual([]);
    expect(result.view.state).toBe('needs_key');
    await expect(disconnectConnector(owner, env, 'beehiiv')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('still deletes the secret when the platform cannot be reached to revoke', async () => {
    await saveApp(owner, 'youtube');
    fake.on('POST', 'https://oauth2.googleapis.com/token', { body: { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, scope: 'https://www.googleapis.com/auth/youtube.readonly' } });
    fake.on('GET', 'https://www.googleapis.com/youtube/v3/channels', { body: { items: [{ snippet: { title: 'Fake Channel' } }] } });
    const { authorizeUrl } = await startOAuth(owner, env, 'youtube');
    expect((await completeOAuth(owner, env, 'youtube', { code: 'abc', state: paramsOf(authorizeUrl).state })).code).toBe('connected');
    const url = paramsOf(authorizeUrl).url;
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/youtube.readonly');
    const down = await disconnectConnector(owner, { ...env, fetchFn: (() => Promise.reject(new TypeError('offline'))) as unknown as typeof fetch }, 'youtube');
    expect(down.revoked).toBe('manual');
    expect(await connectionRows(A)).toEqual([]);
  });

  it('LinkedIn video cannot be disconnected on its own', async () => {
    await expect(disconnectConnector(owner, env, 'linkedin_video')).rejects.toMatchObject({ code: 'conflict', data: { code: 'SHARED' } });
  });
});

describe('who may connect', () => {
  it('refuses an agent or an AI caller for every action', async () => {
    for (const actor of ['agent', 'ai'] as const) {
      const bot = as(A, 'none', actor);
      const calls: Promise<unknown>[] = [
        listConnectors(bot, env),
        connectWithFields(bot, env, 'beehiiv', { fields: { apiKey: API_KEY } }),
        testConnector(bot, env, 'beehiiv'),
        startOAuth(bot, env, 'x'),
        completeOAuth(bot, env, 'x', { code: 'a', state: 'a'.repeat(43) }),
        startDevice(bot, env, 'site'),
        pollDeviceFlow(bot, env, 'site', '66666666-6666-4666-8666-666666666666'),
        cancelDevice(bot, env, 'site'),
        disconnectConnector(bot, env, 'beehiiv'),
        saveIntegrationSecret(bot, env, { platform: 'x', kind: 'oauth_client', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
      ];
      for (const call of calls) await expect(call).rejects.toMatchObject({ code: 'forbidden' });
    }
    expect(fake.requests).toHaveLength(0);
    expect(await connectionRows(A)).toEqual([]);
  });
});
