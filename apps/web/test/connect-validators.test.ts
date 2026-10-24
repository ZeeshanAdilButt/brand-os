import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CONNECTOR_LIST, CONNECTORS } from '../src/lib/connectors';
import type { ConnectorId } from '../src/lib/connectors/ids';
import { testConfig } from './helpers';
import type { ConnectEnv } from '../src/server/connect/env';
import { ConnectFailure } from '../src/server/connect/request';
import { ghostToken, secretsIn, validatorFor, VALIDATORS, type ValidationInput } from '../src/server/connect/validators';
import { createFakeDevto } from './helpers/fake-devto';
import { createFakeGithub } from './helpers/fake-github';
import { createFakeHashnode } from './helpers/fake-hashnode';
import { createFakeProviders, json, type FakeProviders } from './helpers/fake-providers';

// Built at run time: the repository forbids key-shaped literals in tests.
const W = (...parts: string[]) => parts.join('-');
const KEY = W('fake', 'key', 'validator', '7c1d9e');
const TOKEN = W('fake', 'access', 'validator', '3b8a52');

const NOW = new Date('2026-10-24T10:00:00Z');
const envWith = (fetchFn: typeof fetch, config = testConfig()): ConnectEnv => ({ config, fetchFn, now: () => NOW, timeoutMs: 2000 });

async function run(id: ConnectorId, fake: { fetch: typeof fetch }, input: Partial<ValidationInput>, config = testConfig()) {
  const def = CONNECTORS[id];
  const validator = validatorFor(id);
  if (!validator) throw new Error(`no validator for ${id}`);
  return validator({ env: envWith(fake.fetch, config), def, fields: {}, ...input });
}

async function failure(promise: Promise<unknown>): Promise<ConnectFailure> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectFailure);
    return err as ConnectFailure;
  }
  throw new Error('expected a failure');
}

describe('every connector with something to connect has a validate() that matches its definition', () => {
  it('has a validator for each verified or unverified connector and none for manual ones', () => {
    for (const def of CONNECTOR_LIST) {
      if (def.kind === 'manual_only') expect(validatorFor(def.id), def.id).toBeNull();
      else expect(validatorFor(def.id), def.id).toBeTypeOf('function');
    }
    expect(Object.keys(VALIDATORS).every((id) => CONNECTORS[id as ConnectorId].kind !== 'manual_only')).toBe(true);
  });

  it('LinkedIn video checks through the LinkedIn validator, so there is one request and one place', () => {
    expect(validatorFor('linkedin_video')).toBe(VALIDATORS.linkedin);
  });
});

describe('the three connectors that publish reuse their adapters’ read-only probes', () => {
  it('DEV.to answers with the account name and sends the key only in the api-key header', async () => {
    const fake = createFakeDevto({ apiKey: KEY });
    const ok = await run('devto', fake, { fields: { apiKey: KEY } });
    expect(ok.account).toBe('@fakeauthor');
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/users/me']);
    expect(fake.requests[0]?.headers['api-key']).toBe(KEY);
  });

  it('DEV.to refuses a wrong key in plain words and the message never carries the key', async () => {
    const fake = createFakeDevto({ apiKey: KEY });
    const bad = W('wrong', 'key', 'validator', '99');
    const err = await failure(run('devto', fake, { fields: { apiKey: bad } }));
    expect(err.code).toBe('rejected');
    expect(err.message).not.toContain(bad);
  });

  it('Hashnode answers with the account and the publications it can reach', async () => {
    const fake = createFakeHashnode({ token: KEY, publications: [{ id: 'pub1', title: 'Notes' }] });
    const ok = await run('hashnode', fake, { fields: { token: KEY } });
    expect(ok.account).toContain('fakewriter');
    expect(ok.config?.publications).toEqual([{ id: 'pub1', title: 'Notes' }]);
  });

  it('the personal site reads its one repository and refuses a token that cannot push', async () => {
    const fake = createFakeGithub({ token: KEY, repo: 'example-owner/example-site' });
    const ok = await run('site', fake, { fields: { token: KEY }, site: { repo: 'example-owner/example-site', baseBranch: 'main' } });
    expect(ok.account).toContain('example-owner/example-site');
    const readOnly = createFakeGithub({ token: KEY, repo: 'example-owner/example-site', permissions: { push: false } });
    const err = await failure(run('site', readOnly, { fields: { token: KEY }, site: { repo: 'example-owner/example-site', baseBranch: 'main' } }));
    expect(['forbidden', 'rejected', 'bad_input']).toContain(err.code);
  });
});

describe('GitHub Releases', () => {
  const repo = 'example-owner/example-project';
  it('reads the repository with the token and says whose it is', async () => {
    const fake = createFakeProviders();
    fake.on('GET', `https://api.github.com/repos/${repo}`, { body: { full_name: repo, permissions: { push: true } } });
    const ok = await run('github_releases', fake, { fields: { repo, token: KEY } });
    expect(ok.account).toBe(repo);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(fake.requests[0]?.headers['user-agent']).toBe('brand-os');
  });
  it('asks for write access when the token can only read, and rejects a wrong token', async () => {
    const fake = createFakeProviders();
    fake.on('GET', `https://api.github.com/repos/${repo}`, { body: { full_name: repo, permissions: { push: false } } });
    expect((await failure(run('github_releases', fake, { fields: { repo, token: KEY } }))).code).toBe('forbidden');
    const refused = createFakeProviders();
    refused.on('GET', `https://api.github.com/repos/${repo}`, { status: 401, body: { message: `Bad credentials ${KEY}` } });
    const err = await failure(run('github_releases', refused, { fields: { repo, token: KEY } }));
    expect(err.code).toBe('rejected');
    expect(err.message).not.toContain(KEY);
  });
});

describe('site credentials', () => {
  it('Ghost signs a short-lived token from the key and reads one post', async () => {
    const id = 'a'.repeat(24);
    const secret = 'b'.repeat(64);
    const fake = createFakeProviders();
    fake.on('GET', 'https://example-blog.dev/ghost/api/admin/posts/', { body: { posts: [] } });
    const ok = await run('ghost', fake, { fields: { siteUrl: 'https://example-blog.dev', adminKey: `${id}:${secret}` } });
    expect(ok.account).toBe('example-blog.dev');
    const sent = fake.requests[0]!;
    expect(sent.url).toBe('https://example-blog.dev/ghost/api/admin/posts/?limit=1');
    const jwt = sent.headers.authorization!.replace(/^Ghost /, '');
    const [head, body, signature] = jwt.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(head, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT', kid: id });
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as { iat: number; exp: number; aud: string };
    expect(claims.aud).toBe('/admin/');
    expect(claims.exp - claims.iat).toBe(300);
    expect(signature).toBe(createHmac('sha256', Buffer.from(secret, 'hex')).update(`${head}.${body}`).digest('base64url'));
    expect(sent.headers['accept-version']).toBe('v5.0');
    expect(sent.body).toBe('');
  });
  it('Ghost refuses a malformed key before any request, and a rejected key in plain words', async () => {
    const fake = createFakeProviders();
    expect((await failure(run('ghost', fake, { fields: { siteUrl: 'https://example-blog.dev', adminKey: 'nothex' } }))).code).toBe('bad_input');
    expect(fake.requests).toHaveLength(0);
    expect(() => ghostToken('x:zz', NOW)).toThrow();
    fake.on('GET', 'https://example-blog.dev/ghost/api/admin/posts/', { status: 401, body: { errors: [{ message: 'Unauthorized' }] } });
    const err = await failure(run('ghost', fake, { fields: { siteUrl: 'https://example-blog.dev', adminKey: `${'a'.repeat(24)}:${'b'.repeat(64)}` } }));
    expect(err.code).toBe('rejected');
    expect(err.message).not.toContain('b'.repeat(64));
  });
  it('WordPress sends the application password as Basic auth with the spaces removed and names the user', async () => {
    const fake = createFakeProviders();
    fake.on('GET', 'https://example-blog.dev/wp-json/wp/v2/users/me', { body: { name: 'Fake Author', slug: 'fakeauthor' } });
    const ok = await run('wordpress', fake, { fields: { siteUrl: 'https://example-blog.dev/', username: 'fakeauthor', appPassword: 'abcd efgh ijkl mnop qrst uvwx' } });
    expect(ok.account).toBe('Fake Author on example-blog.dev');
    expect(fake.requests[0]?.url).toContain('?context=edit');
    const basic = fake.requests[0]?.headers.authorization?.replace('Basic ', '') ?? '';
    expect(Buffer.from(basic, 'base64').toString()).toBe('fakeauthor:abcdefghijklmnopqrstuvwx');
  });
  it('WordPress says so when the site does not accept the password', async () => {
    const fake = createFakeProviders();
    fake.on('GET', 'https://example-blog.dev/wp-json/wp/v2/users/me', { status: 401, body: { code: 'incorrect_password', message: 'The password is wrong' } });
    const err = await failure(run('wordpress', fake, { fields: { siteUrl: 'https://example-blog.dev', username: 'fakeauthor', appPassword: 'abcdefghijklmnopqrstuvwx' } }));
    expect(err.code).toBe('rejected');
    expect(err.message).not.toContain('abcdefghijklmnopqrstuvwx');
  });
  it('a hosted server refuses a private or plain-http site before it calls anything', async () => {
    const hosted = testConfig({ mode: 'hosted', authSecret: 'x'.repeat(40), appSecret: 'y'.repeat(40), databaseUrl: 'postgres://example.invalid/db', driver: 'postgres' });
    for (const siteUrl of ['http://example-blog.dev', 'https://10.0.0.5', 'https://localhost', 'https://169.254.169.254']) {
      const fake = createFakeProviders();
      const err = await failure(run('wordpress', fake, { fields: { siteUrl, username: 'a', appPassword: 'abcdefghijklmnopqrstuvwx' } }, hosted));
      expect(err.code, siteUrl).toBe('bad_input');
      expect(fake.requests, siteUrl).toHaveLength(0);
    }
  });
  it('a local install may use a site on this machine', async () => {
    const fake = createFakeProviders();
    fake.on('GET', 'http://localhost:2368/ghost/api/admin/posts/', { body: { posts: [] } });
    const ok = await run('ghost', fake, { fields: { siteUrl: 'http://localhost:2368', adminKey: `${'a'.repeat(24)}:${'b'.repeat(64)}` } });
    expect(ok.account).toBe('localhost:2368');
  });
});

describe('keys', () => {
  it('Beehiiv lists publications with a bearer key and names the first', async () => {
    const fake = createFakeProviders();
    fake.on('GET', 'https://api.beehiiv.com/v2/publications', { body: { data: [{ id: 'pub_1', name: 'The Notes' }] } });
    expect((await run('beehiiv', fake, { fields: { apiKey: KEY } })).account).toBe('The Notes');
    expect(fake.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    const refused = createFakeProviders();
    refused.on('GET', 'https://api.beehiiv.com/v2/publications', { status: 401, body: { message: 'no' } });
    expect((await failure(run('beehiiv', refused, { fields: { apiKey: KEY } }))).code).toBe('rejected');
  });
  it('Buffer asks for the organizations with the documented query and counts them', async () => {
    const fake = createFakeProviders();
    fake.on('POST', 'https://api.buffer.com/', { body: { data: { account: { organizations: [{ id: 'o1' }, { id: 'o2' }] } } } });
    expect((await run('buffer', fake, { fields: { apiKey: KEY } })).account).toBe('Buffer account (2 organizations)');
    expect(JSON.parse(fake.requests[0]!.body).query).toContain('organizations');
    const errors = createFakeProviders();
    errors.on('POST', 'https://api.buffer.com/', { body: { errors: [{ message: 'Unauthorized' }] } });
    expect((await failure(run('buffer', errors, { fields: { apiKey: KEY } }))).code).toBe('rejected');
  });
  it('Postiz sends the key with no prefix and counts channels', async () => {
    const fake = createFakeProviders();
    fake.on('GET', 'https://api.postiz.com/public/v1/integrations', { body: [{ id: 'c1' }] });
    expect((await run('postiz', fake, { fields: { apiKey: KEY } })).account).toBe('Postiz, 1 channel');
    expect(fake.requests[0]?.headers.authorization).toBe(KEY);
  });
  it('Postiz calls a self-hosted address the person typed', async () => {
    const fake = createFakeProviders();
    fake.on('GET', 'https://postiz.example.test/api/public/v1/integrations', { body: [] });
    const ok = await run('postiz', fake, { fields: { apiKey: KEY, baseUrl: 'https://postiz.example.test/api/public/v1' } });
    expect(ok.account).toBe('Postiz, 0 channels');
  });
});

describe('app password and webhooks', () => {
  it('Bluesky signs in once with the handle and the app password, keeps no session, and names the handle', async () => {
    const fake = createFakeProviders();
    fake.on('POST', 'https://bsky.social/xrpc/com.atproto.server.createSession', (r) => {
      const body = JSON.parse(r.body) as { identifier: string; password: string };
      return body.password === KEY ? json({ handle: 'writer.bsky.social', did: 'did:plc:fake', accessJwt: 'a', refreshJwt: 'b' }) : json({ error: 'AuthenticationRequired', message: 'Invalid identifier or password' }, 401);
    });
    expect((await run('bluesky', fake, { fields: { handle: '@writer.bsky.social', appPassword: KEY } })).account).toBe('@writer.bsky.social');
    expect(JSON.parse(fake.requests[0]!.body).identifier).toBe('writer.bsky.social');
    const err = await failure(run('bluesky', fake, { fields: { handle: 'writer.bsky.social', appPassword: W('wrong', 'password', '12') } }));
    expect(err.code).toBe('rejected');
    expect(err.message).toMatch(/app password/);
  });
  it('Discord reads the webhook without signing in and shows its name and channel', async () => {
    const fake = createFakeProviders();
    const address = 'https://discord.com/api/webhooks/123456789/' + W('fake', 'webhook', 'part', '55');
    fake.on('GET', address.replace(/\?.*/, ''), { body: { name: 'Announcements', channel_id: '777' } });
    const ok = await run('discord', fake, { fields: { webhookUrl: address } });
    expect(ok.account).toBe('Announcements in channel 777');
    expect(fake.requests[0]?.headers.authorization).toBeUndefined();
    const gone = createFakeProviders();
    gone.on('GET', address, { status: 404, body: { message: 'Unknown Webhook' } });
    const err = await failure(run('discord', gone, { fields: { webhookUrl: address } }));
    expect(err.code).toBe('not_found');
    expect(err.message).not.toContain('fake-webhook');
  });
  it('Discord refuses an address that is not a Discord webhook before any request', async () => {
    const fake = createFakeProviders();
    const err = await failure(run('discord', fake, { fields: { webhookUrl: 'https://evil.example.test/api/webhooks/1/abc' } }));
    expect(err.code).toBe('bad_input');
    expect(fake.requests).toHaveLength(0);
  });
});

describe('sign-ins', () => {
  it('LinkedIn reads the OpenID Connect profile with the bearer token', async () => {
    const fake = createFakeProviders();
    fake.on('GET', 'https://api.linkedin.com/v2/userinfo', { body: { sub: 'abc123', name: 'Fake Person' } });
    expect((await run('linkedin', fake, { accessToken: TOKEN })).account).toBe('Fake Person');
    expect(fake.requests[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const refused = createFakeProviders();
    refused.on('GET', 'https://api.linkedin.com/v2/userinfo', { status: 401, body: {} });
    const err = await failure(run('linkedin', refused, { accessToken: TOKEN }));
    expect(err.code).toBe('rejected');
  });
  it('X reads the signed-in user', async () => {
    const fake = createFakeProviders();
    fake.on('GET', 'https://api.x.com/2/users/me', { body: { data: { id: '1', name: 'Fake', username: 'fakewriter' } } });
    expect((await run('x', fake, { accessToken: TOKEN })).account).toBe('@fakewriter');
  });
  it('Threads sends the token as the documented query parameter and names the user', async () => {
    const fake = createFakeProviders();
    fake.on('GET', 'https://graph.threads.com/me', { body: { id: '1', username: 'fakewriter' } });
    const ok = await run('threads', fake, { accessToken: TOKEN });
    expect(ok.account).toBe('@fakewriter');
    expect(new URL(fake.requests[0]!.url).searchParams.get('access_token')).toBe(TOKEN);
    expect(new URL(fake.requests[0]!.url).searchParams.get('fields')).toBe('id,username');
  });
  it('Threads never repeats the token in an error', async () => {
    const fake = createFakeProviders();
    fake.on('GET', 'https://graph.threads.com/me', { status: 400, body: { error: { message: `Invalid OAuth access token ${TOKEN}` } } });
    const err = await failure(run('threads', fake, { accessToken: TOKEN }));
    expect(err.message).not.toContain(TOKEN);
  });
  it('Mastodon reads the account from the person’s own instance', async () => {
    const fake = createFakeProviders();
    fake.on('GET', 'https://mastodon.example.test/api/v1/accounts/verify_credentials', { body: { acct: 'writer', username: 'writer' } });
    const ok = await run('mastodon', fake, { accessToken: TOKEN, instance: 'https://mastodon.example.test' });
    expect(ok.account).toBe('@writer@mastodon.example.test');
  });
  it('YouTube reads the signed-in channel title, and says so when the account has no channel', async () => {
    const fake = createFakeProviders();
    fake.on('GET', 'https://www.googleapis.com/youtube/v3/channels', { body: { items: [{ snippet: { title: 'Fake Channel' } }] } });
    expect((await run('youtube', fake, { accessToken: TOKEN })).account).toBe('Fake Channel');
    expect(new URL(fake.requests[0]!.url).searchParams.get('mine')).toBe('true');
    const empty = createFakeProviders();
    empty.on('GET', 'https://www.googleapis.com/youtube/v3/channels', { body: { items: [] } });
    expect((await run('youtube', empty, { accessToken: TOKEN })).account).toMatch(/no YouTube channel/);
  });
  it('without a sign-in there is nothing to check and no request is made', async () => {
    const fake = createFakeProviders();
    expect((await failure(run('x', fake, {}))).code).toBe('rejected');
    expect(fake.requests).toHaveLength(0);
  });
});

describe('connectors that are not confirmed on an official page send nothing', () => {
  it.each(['buttondown', 'product_hunt', 'slack'] as const)('%s', async (id) => {
    const fake = createFakeProviders();
    const err = await failure(run(id, fake, { fields: { apiKey: KEY, token: KEY, webhookUrl: 'https://hooks.slack.com/services/T0/B0/xyz' } }));
    expect(err.code).toBe('unverified');
    expect(fake.requests).toHaveLength(0);
  });
});

describe('what a validator sends matches what its definition says', () => {
  const cases: { id: ConnectorId; fields?: Record<string, string>; accessToken?: string; instance?: string; routes: [string, string][] }[] = [
    { id: 'beehiiv', fields: { apiKey: KEY }, routes: [['GET', 'https://api.beehiiv.com/v2/publications']] },
    { id: 'linkedin', accessToken: TOKEN, routes: [['GET', 'https://api.linkedin.com/v2/userinfo']] },
    { id: 'x', accessToken: TOKEN, routes: [['GET', 'https://api.x.com/2/users/me']] },
    { id: 'threads', accessToken: TOKEN, routes: [['GET', 'https://graph.threads.com/me']] },
    { id: 'youtube', accessToken: TOKEN, routes: [['GET', 'https://www.googleapis.com/youtube/v3/channels']] },
    { id: 'bluesky', fields: { handle: 'a.bsky.social', appPassword: KEY }, routes: [['POST', 'https://bsky.social/xrpc/com.atproto.server.createSession']] },
    { id: 'buffer', fields: { apiKey: KEY }, routes: [['POST', 'https://api.buffer.com/']] },
    { id: 'github_releases', fields: { repo: 'example-owner/example-project', token: KEY }, routes: [['GET', 'https://api.github.com/repos/example-owner/example-project']] },
    { id: 'mastodon', accessToken: TOKEN, instance: 'https://mastodon.example.test', routes: [['GET', 'https://mastodon.example.test/api/v1/accounts/verify_credentials']] },
  ];
  it.each(cases)('$id makes exactly the one request the definition describes', async ({ id, fields, accessToken, instance, routes }) => {
    const def = CONNECTORS[id];
    const fake = createFakeProviders();
    for (const [method, url] of routes) fake.on(method, url.replace(/\/$/, '') + (url.endsWith('/') ? '/' : ''), { status: 401, body: {} });
    await run(id, fake, { ...(fields ? { fields } : {}), ...(accessToken ? { accessToken } : {}), ...(instance ? { instance } : {}) }).catch(() => undefined);
    expect(fake.requests, id).toHaveLength(1);
    const sent = fake.requests[0]!;
    expect(sent.method).toBe(def.validation?.method);
    const template = (def.validation?.url ?? '').replace('{repo}', 'example-owner/example-project').replace('{instance}', 'https://mastodon.example.test');
    expect(`${sent.origin}${sent.path}`.replace(/\/$/, '')).toBe(new URL(template).origin + new URL(template).pathname.replace(/\/$/, ''));
  });
  it('lists the secrets to redact for each call', () => {
    expect(secretsIn({ def: CONNECTORS.ghost, fields: { siteUrl: 'https://example-blog.dev', adminKey: 'id:secret' } })).toEqual(['id:secret']);
    expect(secretsIn({ def: CONNECTORS.x, fields: {}, accessToken: TOKEN })).toEqual([TOKEN]);
  });
});
