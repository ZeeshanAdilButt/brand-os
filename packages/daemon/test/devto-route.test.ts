import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Draft, DraftStatus, DevtoPayload } from '@cph/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.js';
import { createRepos } from '../src/db/repos.js';
import { GateError } from '../src/gate/errors.js';
import { mintVerifiedApproval, type VerifiedApproval } from '../src/gate/verified.js';
import { DevtoRoute } from '../src/routes/devto.js';
import { RouteRegistry } from '../src/routes/registry.js';
import { parseRetryAfter, PlatformError, StageRefused } from '../src/routes/types.js';
import { MemoryKeyStore } from '../src/secrets/keystore.js';
import { SecretStore } from '../src/secrets/secret-store.js';

const FAKE_KEY = 'not-a-real-key-0123456789abcdef';
const NOW = new Date('2026-10-19T10:00:00.000Z');
const LIVE_MESSAGE = 'article is live on dev.to; editing it is a publish and needs its own approval';

const fixture = <T = unknown>(name: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/http/${name}.json`, import.meta.url)), 'utf8')) as T;

interface Req {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: { article: Record<string, unknown> } | undefined;
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

/** A scripted dev.to. Records every request; `override` can answer first to inject faults. */
class FakeDevto {
  readonly requests: Req[] = [];
  unpublished: { id: number }[] = fixture('devto-articles-unpublished');
  published: { id: number }[] = fixture('devto-articles-published');
  override: ((req: Req) => Reply | undefined) | undefined;

  readonly fetchFn: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const raw = init?.body;
    const req: Req = {
      method: init?.method ?? 'GET',
      url,
      headers,
      body: typeof raw === 'string' ? (JSON.parse(raw) as Req['body']) : undefined,
    };
    this.requests.push(req);
    const reply = this.override?.(req) ?? this.#answer(req);
    const payload = reply.body === undefined ? null : JSON.stringify(reply.body);
    return Promise.resolve(
      new Response(payload, { status: reply.status, headers: { 'content-type': 'application/json', ...reply.headers } }),
    );
  };

  #answer(req: Req): Reply {
    const { method, url, headers } = req;
    if (headers['api-key'] !== FAKE_KEY) return { status: 401, body: fixture('devto-error-401') };
    if (method === 'GET' && url.pathname === '/api/users/me') return { status: 200, body: fixture('devto-user-me') };
    if (method === 'POST' && url.pathname === '/api/articles') return { status: 201, body: fixture('devto-article-created') };
    const list = /^\/api\/articles\/me\/(published|unpublished)$/.exec(url.pathname)?.[1];
    if (method === 'GET' && list !== undefined) {
      const all = list === 'published' ? this.published : this.unpublished;
      const page = Number(url.searchParams.get('page') ?? '1');
      const perPage = Number(url.searchParams.get('per_page') ?? '30');
      return { status: 200, body: all.slice((page - 1) * perPage, page * perPage) };
    }
    if (method === 'PUT' && /^\/api\/articles\/\d+$/.test(url.pathname)) {
      return { status: 200, body: fixture(req.body?.article['published'] === true ? 'devto-article-published' : 'devto-article-updated') };
    }
    return { status: 404, body: { error: 'not found', status: 404 } };
  }

  get puts(): Req[] {
    return this.requests.filter((r) => r.method === 'PUT');
  }
}

const SHA = 'a'.repeat(64);

function payload(over: Partial<DevtoPayload> = {}): DevtoPayload {
  return {
    title: 'Fixture post title',
    body_markdown: 'Body with `code` and ρ 🙂',
    published: false,
    canonical_url: 'https://www.example-blog.dev/blog/fixture',
    main_image: 'https://www.example-blog.dev/blog/fixture/cover.png',
    description: 'Fixture description',
    tags: ['typescript', 'testing'],
    series: 'Fixture series',
    ...over,
  };
}

function draft(over: Partial<Draft<DevtoPayload>> = {}): Draft<DevtoPayload> {
  return {
    id: 'draft-1',
    slug: 'fixture',
    platform: 'devto',
    account: 'default',
    route: 'direct',
    kind: 'article',
    status: 'draft',
    payload: payload(),
    payloadSha256: SHA,
    authorship: 'reformatted',
    lint: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...over,
  };
}

function approval(over: Partial<{ draftId: string; payloadSha256: string }> = {}): VerifiedApproval {
  return mintVerifiedApproval({
    approvalId: 'approval-1',
    draftId: over.draftId ?? 'draft-1',
    payloadSha256: over.payloadSha256 ?? SHA,
    mode: 'publish_now',
    scheduledAt: null,
  });
}

let db: Db;
let secrets: SecretStore;
let fake: FakeDevto;
let failed: { draftId: string; reason: string }[];
let route: DevtoRoute;

beforeEach(() => {
  db = openDb(':memory:');
  secrets = new SecretStore(new MemoryKeyStore(), createRepos(db, { now: () => NOW.toISOString() }));
  secrets.ensureMasterKey();
  secrets.put('devto', 'default', { apiKey: FAKE_KEY });
  fake = new FakeDevto();
  failed = [];
  route = new DevtoRoute({
    secrets,
    fetchFn: fake.fetchFn,
    now: () => NOW,
    markFailed: (draftId, reason) => {
      failed.push({ draftId, reason });
    },
  });
});

afterEach(() => {
  db.close();
});

describe('DevtoRoute identity', () => {
  it('is a direct route for devto that costs nothing', () => {
    expect(route.kind).toBe('direct');
    expect(route.platform).toBe('devto');
    expect(route.costEstimate(draft())).toBe(0);
  });
});

describe('connect and health', () => {
  it('validates with GET /api/users/me, then stores only the api key', async () => {
    secrets.delete('devto', 'default');
    const health = await route.connect('default', { apiKey: FAKE_KEY, extra: 'ignored' });
    expect(health).toMatchObject({ state: 'connected', who: '@owner_test' });
    expect(secrets.get('devto', 'default')).toEqual({ apiKey: FAKE_KEY });

    expect(fake.requests).toHaveLength(1);
    const [req] = fake.requests;
    expect(req?.method).toBe('GET');
    expect(req?.url.href).toBe('https://dev.to/api/users/me');
    expect(req?.headers).toMatchObject({
      'api-key': FAKE_KEY,
      accept: 'application/vnd.forem.api-v1+json',
      'content-type': 'application/json',
    });
  });

  it('a 401 stores nothing and reports needs_reconnect', async () => {
    secrets.delete('devto', 'default');
    const health = await route.connect('default', { apiKey: 'not-a-real-key-wrong' });
    expect(health.state).toBe('needs_reconnect');
    expect(secrets.get('devto', 'default')).toBeNull();
  });

  it('a rejected key does not overwrite a working stored key', async () => {
    const health = await route.connect('default', { apiKey: 'not-a-real-key-wrong' });
    expect(health.state).toBe('needs_reconnect');
    expect(secrets.get('devto', 'default')).toEqual({ apiKey: FAKE_KEY });
  });

  it('without an apiKey input it is not_configured and makes no request', async () => {
    const health = await route.connect('default', {});
    expect(health.state).toBe('not_configured');
    expect(fake.requests).toHaveLength(0);
  });

  it('health: not_configured without a stored key, connected with one, needs_reconnect on 401', async () => {
    expect((await route.health('nobody')).state).toBe('not_configured');
    expect(fake.requests).toHaveLength(0);

    expect(await route.health('default')).toMatchObject({ state: 'connected', who: '@owner_test' });

    secrets.put('devto', 'default', { apiKey: 'not-a-real-key-revoked' });
    expect((await route.health('default')).state).toBe('needs_reconnect');
  });
});

describe('stage', () => {
  it('creates a private article: published false even when the payload object carries true', async () => {
    const sneaky = { ...payload(), published: true } as unknown as DevtoPayload;
    const ref = await route.stage(draft({ payload: sneaky }));

    expect(ref).toEqual({
      remoteId: '2001',
      previewUrl: 'https://dev.to/owner_test/fixture-post-title-temp-slug-1234567?preview=fixture-preview',
    });
    expect(fake.requests).toHaveLength(1);
    const [req] = fake.requests;
    expect(req?.method).toBe('POST');
    expect(req?.url.href).toBe('https://dev.to/api/articles');
    expect(req?.body?.article['published']).toBe(false);
    expect(req?.headers).toMatchObject({
      'api-key': FAKE_KEY,
      accept: 'application/vnd.forem.api-v1+json',
      'content-type': 'application/json',
    });
  });

  it('sends the canonical_url unchanged and the tags as a comma-joined string', async () => {
    await route.stage(draft({ payload: payload({ canonical_url: 'https://www.example-blog.dev/blog/a-b?x=1#h' }) }));
    const article = fake.requests[0]?.body?.article;
    expect(article?.['canonical_url']).toBe('https://www.example-blog.dev/blog/a-b?x=1#h');
    expect(article?.['tags']).toBe('typescript,testing');
  });

  it('never sends a PUT with published true, in any stage path', async () => {
    const sneaky = { ...payload(), published: true } as unknown as DevtoPayload;
    await route.stage(draft({ payload: sneaky }));
    await route.stage(draft({ payload: sneaky, status: 'staged', remoteRef: '2001' }));
    await route.stage(draft({ payload: sneaky, status: 'staged', remoteRef: '3001' })).catch(() => undefined);
    expect(fake.puts.length).toBeGreaterThan(0);
    for (const put of fake.puts) expect(put.body?.article['published']).toBe(false);
    for (const req of fake.requests) expect(req.body?.article['published'] === true).toBe(false);
  });

  it('re-stage of an unpublished article reads it back first, then makes exactly one PUT with published false', async () => {
    const ref = await route.stage(draft({ status: 'staged', remoteRef: '2001' }));
    expect(ref.remoteId).toBe('2001');
    expect(fake.requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      'GET /api/articles/me/unpublished',
      'PUT /api/articles/2001',
    ]);
    expect(fake.puts[0]?.body?.article['published']).toBe(false);
    expect(failed).toEqual([]);
  });

  it('finds the article on a later page of the unpublished list', async () => {
    fake.unpublished = [...Array.from({ length: 100 }, (_, i) => ({ id: 9000 + i })), { id: 2001 }];
    await route.stage(draft({ status: 'staged', remoteRef: '2001' }));
    const gets = fake.requests.filter((r) => r.method === 'GET');
    expect(gets.map((r) => r.url.searchParams.get('page'))).toEqual(['1', '2']);
    expect(fake.puts).toHaveLength(1);
  });

  it('re-stage when the article is published: no PUT, StageRefused, draft marked failed', async () => {
    const attempt = route.stage(draft({ status: 'staged', remoteRef: '3001' }));
    await expect(attempt).rejects.toBeInstanceOf(StageRefused);
    await expect(attempt).rejects.toThrow(LIVE_MESSAGE);
    expect(fake.puts).toHaveLength(0);
    expect(fake.requests.every((r) => r.method === 'GET')).toBe(true);
    expect(failed).toEqual([{ draftId: 'draft-1', reason: LIVE_MESSAGE }]);
  });

  it('re-stage when the article is in neither list (deleted or unknown) is refused the same way', async () => {
    await expect(route.stage(draft({ status: 'staged', remoteRef: '777' }))).rejects.toThrow(LIVE_MESSAGE);
    expect(fake.puts).toHaveLength(0);
    expect(failed).toHaveLength(1);
  });

  it('refuses a list entry that says published true even if it came from the unpublished list', async () => {
    fake.unpublished = [{ id: 2001, published: true } as { id: number }];
    await expect(route.stage(draft({ status: 'staged', remoteRef: '2001' }))).rejects.toThrow(LIVE_MESSAGE);
    expect(fake.puts).toHaveLength(0);
  });

  it('refuses a remoteRef that is not a numeric id, without any request', async () => {
    await expect(route.stage(draft({ status: 'staged', remoteRef: '../users/me' }))).rejects.toBeInstanceOf(StageRefused);
    expect(fake.requests).toHaveLength(0);
  });

  it.each<DraftStatus>(['pending_approval', 'approved', 'scheduled', 'publishing', 'unknown', 'published', 'handed_off', 'failed', 'held', 'source_changed'])(
    'refuses to stage a draft in status %s without any fetch',
    async (status) => {
      await expect(route.stage(draft({ status }))).rejects.toBeInstanceOf(StageRefused);
      expect(fake.requests).toHaveLength(0);
      expect(failed).toEqual([]);
    },
  );

  it('stages drafts in status draft or staged', async () => {
    await route.stage(draft({ status: 'draft' }));
    await route.stage(draft({ status: 'staged' }));
    expect(fake.requests.filter((r) => r.method === 'POST')).toHaveLength(2);
  });

  it('is loud if the platform answers a stage with a live article', async () => {
    fake.override = (req) => (req.method === 'POST' ? { status: 201, body: fixture('devto-article-published') } : undefined);
    await expect(route.stage(draft())).rejects.toThrow(/live/i);
  });
});

describe('route contract: what is hashed is what is sent', () => {
  it('every DevtoPayload field reaches the wire', async () => {
    const all = {
      title: 'T',
      body_markdown: 'B',
      published: false,
      canonical_url: 'https://www.example-blog.dev/blog/x',
      main_image: 'https://www.example-blog.dev/blog/x/cover.png',
      description: 'D',
      tags: ['a', 'b', 'c', 'd'],
      series: 'S',
    } satisfies Record<keyof DevtoPayload, unknown>;
    expect(Object.keys(all).sort()).toEqual(
      ['body_markdown', 'canonical_url', 'description', 'main_image', 'published', 'series', 'tags', 'title'],
    );

    await route.stage(draft({ payload: all }));
    const sentOnStage = fake.requests[0]?.body?.article;
    expect(sentOnStage).toEqual({ ...all, tags: 'a,b,c,d', published: false });

    fake.requests.length = 0;
    await route.publish(draft({ payload: all, status: 'approved', remoteRef: '2001' }), approval());
    const sentOnPublish = fake.requests[0]?.body?.article;
    expect(sentOnPublish).toEqual({ ...all, tags: 'a,b,c,d', published: true });
  });
});

describe('errors', () => {
  it('429 with Retry-After seconds gives retryAfterMs', async () => {
    fake.override = () => ({ status: 429, body: fixture('devto-error-429'), headers: { 'retry-after': '7' } });
    const err = await route.stage(draft()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect((err as PlatformError).status).toBe(429);
    expect((err as PlatformError).retryAfterMs).toBe(7000);
  });

  it('429 with an HTTP-date Retry-After gives the delta from now', async () => {
    const at = new Date(NOW.getTime() + 42_000).toUTCString();
    fake.override = () => ({ status: 429, body: fixture('devto-error-429'), headers: { 'retry-after': at } });
    const err = await route.stage(draft()).catch((e: unknown) => e);
    expect((err as PlatformError).retryAfterMs).toBe(42_000);
  });

  it('422 gives a PlatformError carrying the response body text', async () => {
    fake.override = () => ({ status: 422, body: fixture('devto-error-422') });
    const err = await route.stage(draft()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformError);
    const platformError = err as PlatformError;
    expect(platformError.status).toBe(422);
    expect(platformError.body).toContain('Validation failed: Canonical url has already been taken');
    expect(platformError.message).toContain('422');
    expect(platformError.retryAfterMs).toBeUndefined();
  });

  it('never leaks the api key through an error message or body', async () => {
    fake.override = () => ({ status: 500, body: { error: `upstream echoed api-key: ${FAKE_KEY} and ${FAKE_KEY}` } });
    const err = (await route.stage(draft()).catch((e: unknown) => e)) as PlatformError;
    expect(err).toBeInstanceOf(PlatformError);
    expect(`${err.message}\n${err.body ?? ''}\n${err.stack ?? ''}`).not.toContain(FAKE_KEY);
  });

  it('never leaks the api key when the network call itself fails', async () => {
    const leaky = new DevtoRoute({
      secrets,
      fetchFn: () => Promise.reject(new Error(`socket hang up (api-key: ${FAKE_KEY})`)),
      now: () => NOW,
      markFailed: () => undefined,
    });
    for (const attempt of [
      leaky.stage(draft()),
      leaky.health('default'),
      leaky.connect('default', { apiKey: FAKE_KEY }),
      leaky.publish(draft({ remoteRef: '2001' }), approval()),
    ]) {
      const err = (await attempt.catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(`${err.message}\n${err.stack ?? ''}`).not.toContain(FAKE_KEY);
    }
  });

  it('stage without a stored key says so and makes no request', async () => {
    await expect(route.stage(draft({ account: 'nobody' }))).rejects.toThrow(/not connected/);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds, HTTP-dates, and ignores junk', () => {
    expect(parseRetryAfter('7', NOW)).toBe(7000);
    expect(parseRetryAfter(' 0 ', NOW)).toBe(0);
    expect(parseRetryAfter(new Date(NOW.getTime() + 30_000).toUTCString(), NOW)).toBe(30_000);
    expect(parseRetryAfter('Mon, 19 Oct 2026 09:00:00 GMT', NOW)).toBe(0);
    expect(parseRetryAfter(null, NOW)).toBeUndefined();
    expect(parseRetryAfter('', NOW)).toBeUndefined();
    expect(parseRetryAfter('soon', NOW)).toBeUndefined();
    expect(parseRetryAfter('-5', NOW)).toBeUndefined();
    expect(parseRetryAfter('1.5', NOW)).toBeUndefined();
  });
});

describe('publish', () => {
  const approved = (over: Partial<Draft<DevtoPayload>> = {}): Draft<DevtoPayload> =>
    draft({ status: 'approved', remoteRef: '2001', ...over });

  it('sends the full approved payload with published true to PUT /api/articles/{id}, once', async () => {
    const publication = await route.publish(approved(), approval());
    expect(publication).toEqual({
      remoteId: '2001',
      remoteUrl: 'https://dev.to/owner_test/fixture-post-title-1a2b',
      costUsd: 0,
    });
    expect(fake.requests).toHaveLength(1);
    const [req] = fake.requests;
    expect(req?.method).toBe('PUT');
    expect(req?.url.href).toBe('https://dev.to/api/articles/2001');
    const { published: _staged, tags, ...rest } = payload();
    expect(req?.body).toEqual({ article: { ...rest, tags: tags.join(','), published: true } });
    expect(req?.headers['api-key']).toBe(FAKE_KEY);
  });

  it('makes exactly one fetch and no retry on 5xx', async () => {
    fake.override = () => ({ status: 503, body: { error: 'down' }, headers: { 'retry-after': '1' } });
    const err = await route.publish(approved(), approval()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect((err as PlatformError).status).toBe(503);
    expect(fake.requests).toHaveLength(1);
  });

  it('rejects a value that was not minted by the gate, before any request', async () => {
    const forged = { ...approval() } as unknown as VerifiedApproval;
    await expect(route.publish(approved(), forged)).rejects.toThrow(TypeError);
    await expect(route.publish(approved(), undefined as unknown as VerifiedApproval)).rejects.toThrow(TypeError);
    expect(fake.requests).toHaveLength(0);
  });

  it('rejects an approval for another draft or for another payload hash, before any request', async () => {
    const wrongDraft = await route.publish(approved(), approval({ draftId: 'draft-2' })).catch((e: unknown) => e);
    expect(wrongDraft).toBeInstanceOf(GateError);
    const wrongHash = await route.publish(approved(), approval({ payloadSha256: 'b'.repeat(64) })).catch((e: unknown) => e);
    expect(wrongHash).toBeInstanceOf(GateError);
    expect((wrongHash as GateError).code).toBe('HASH_MISMATCH');
    expect(fake.requests).toHaveLength(0);
  });

  it('refuses a draft that was never staged, before any request', async () => {
    await expect(route.publish(draft({ status: 'approved' }), approval())).rejects.toThrow(/stage/i);
    expect(fake.requests).toHaveLength(0);
  });

  it('a 401 on publish is a PlatformError and is not retried', async () => {
    secrets.put('devto', 'default', { apiKey: 'not-a-real-key-revoked' });
    const err = await route.publish(approved(), approval()).catch((e: unknown) => e);
    expect((err as PlatformError).status).toBe(401);
    expect(fake.requests).toHaveLength(1);
  });
});

describe('checkOnPlatform', () => {
  it('resolves published, not_found (still private) and unknown', async () => {
    expect(await route.checkOnPlatform(draft({ remoteRef: '3001' }))).toBe('published');
    expect(await route.checkOnPlatform(draft({ remoteRef: '2001' }))).toBe('not_found');
    expect(await route.checkOnPlatform(draft({ remoteRef: '777' }))).toBe('unknown');
    expect(fake.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('is unknown for a draft with no remote ref, without any request', async () => {
    expect(await route.checkOnPlatform(draft())).toBe('unknown');
    expect(fake.requests).toHaveLength(0);
  });
});

describe('RouteRegistry', () => {
  it('registers one route per (platform, route kind)', () => {
    const registry = new RouteRegistry([route]);
    expect(registry.get('devto', 'direct')).toBe(route);
    expect(registry.require('devto', 'direct')).toBe(route);
    expect(registry.get('devto', 'assist')).toBeUndefined();
    expect(registry.get('linkedin', 'direct')).toBeUndefined();
    expect(() => registry.require('linkedin', 'buffer')).toThrow(/no buffer route/);
    expect(() => registry.register(route)).toThrow(/already registered/);
    expect(registry.all()).toEqual([route]);
  });
});

describe('request hardening', () => {
  it('every dev.to request refuses redirects (the api-key never follows one) and carries a timeout signal', async () => {
    const inits: RequestInit[] = [];
    const watched = new DevtoRoute({
      secrets,
      fetchFn: (input, init) => {
        inits.push(init ?? {});
        return fake.fetchFn(input, init);
      },
      now: () => NOW,
      markFailed: () => undefined,
    });
    await watched.connect('default', { apiKey: FAKE_KEY });
    await watched.stage(draft());
    await watched.publish(draft({ status: 'approved', remoteRef: '2001' }), approval());
    await watched.checkOnPlatform(draft({ remoteRef: '2001' }));
    expect(inits.length).toBeGreaterThanOrEqual(4);
    for (const init of inits) {
      expect(init.redirect).toBe('error');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.signal?.aborted).toBe(false);
    }
  });

  it('a redirect answer surfaces as a failed request, without the key in the message', async () => {
    const redirecting = new DevtoRoute({
      secrets,
      fetchFn: () => Promise.reject(new TypeError('fetch failed: unexpected redirect')),
      now: () => NOW,
      markFailed: () => undefined,
    });
    const error = await redirecting.publish(draft({ status: 'approved', remoteRef: '2001' }), approval()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PlatformError);
    expect((error as Error).message).toMatch(/redirect/);
    expect((error as Error).message).not.toContain(FAKE_KEY);
  });
});
