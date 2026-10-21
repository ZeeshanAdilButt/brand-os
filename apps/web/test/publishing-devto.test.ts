import { beforeEach, describe, expect, it } from 'vitest';
import type { DraftPayload } from '../src/lib/publishing';
import { devtoAdapter } from '../src/server/publishing/adapters/devto';
import type { AdapterContext, AdaptInput } from '../src/server/publishing/adapters/types';
import { PlatformError } from '../src/server/publishing/errors';
import { createFakeDevto, type FakeDevto } from './helpers/fake-devto';

const KEY = ['fake', 'devto', 'key', '9f8e7d6c5b4a'].join('-');
const NOW = new Date('2026-10-21T12:00:00Z');

let fake: FakeDevto;
const ctxFor = (overrides: Partial<AdapterContext> = {}): AdapterContext => ({
  secret: KEY,
  config: {},
  fetch: fake.fetch,
  now: () => NOW,
  baseUrl: fake.origin,
  timeoutMs: 2000,
  ...overrides,
});

const input = (overrides: Partial<AdaptInput> = {}): AdaptInput => ({
  title: 'Why the write path stalls',
  description: 'A short look at write stalls.',
  tags: ['Go', 'node.js', 'C++'],
  canonicalUrl: 'https://example-blog.dev/posts/write-path',
  coverImageUrl: 'https://example-blog.dev/img/cover.png',
  series: null,
  bodyMarkdown: '# Heading\n\nSome **text**.\n\n```go\nfmt.Println("hi")\n```\n',
  ...overrides,
});

const adapted = (overrides: Partial<AdaptInput> = {}): DraftPayload => devtoAdapter.adapt(input(overrides)).payload;
const draft = (payload: DraftPayload, remoteId: string | null = null) => ({ id: 'draft-1', payload, remoteId });
const fail = async (run: () => Promise<unknown>) => {
  const err = await run().then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PlatformError);
  return err as PlatformError;
};

beforeEach(() => {
  fake = createFakeDevto({ apiKey: KEY });
});

describe('adapting an article for DEV.to', () => {
  it('sanitizes tags to lower-case letters and digits and reports every change', () => {
    const { payload, tagReport } = devtoAdapter.adapt(input());
    expect(payload.tags).toEqual(['go', 'nodejs', 'c']);
    expect(tagReport.original).toEqual(['Go', 'node.js', 'C++']);
    expect(tagReport.changes).toEqual(['“Go” became “go”.', '“node.js” became “nodejs”.', '“C++” became “c”.']);
  });

  it('drops tags that vanish or repeat, and says so', () => {
    const { payload, tagReport } = devtoAdapter.adapt(input({ tags: ['!!!', 'go', 'GO', 'g-o'] }));
    expect(payload.tags).toEqual(['go']);
    expect(tagReport.changes.join(' ')).toContain('no usable characters');
    expect(tagReport.changes.join(' ')).toContain('already in the list');
  });

  it('adds a short, clearly marked canonical footer only when a canonical URL is set', () => {
    const withUrl = adapted();
    expect(withUrl.bodyMarkdown.endsWith('*Originally published at [example-blog.dev/posts/write-path](https://example-blog.dev/posts/write-path).*\n')).toBe(true);
    expect(withUrl.bodyMarkdown).toContain('\n\n---\n\n*Originally published at');
    const without = adapted({ canonicalUrl: null });
    expect(without.bodyMarkdown).not.toContain('Originally published');
    expect(without.canonicalUrl).toBeNull();
  });

  it('refuses more than four tags after cleaning instead of dropping some', () => {
    const payload = adapted({ tags: ['a1', 'b2', 'c3', 'd4', 'e5'] });
    expect(payload.tags).toHaveLength(5);
    const issues = devtoAdapter.validate(payload);
    expect(issues.find((i) => i.code === 'tags_too_many')?.severity).toBe('error');
  });

  it('flags images that only exist locally, private links, mermaid and template-like text', () => {
    const payload = adapted({
      bodyMarkdown: [
        '![diagram](asset:3c1f4f0e-0000-4000-8000-000000000000)',
        '![shot](./images/shot.png)',
        '![ok](https://example-blog.dev/a.png)',
        '[local](http://localhost:3000/x)',
        '[fine](https://example-blog.dev/y)',
        '```mermaid\ngraph TD; A-->B\n```',
        'Use {% raw %} carefully.',
        '`![inline code](asset:ignored)`',
      ].join('\n\n'),
    });
    const issues = devtoAdapter.validate(payload);
    const byCode = Object.fromEntries(issues.map((i) => [i.code, i]));
    expect(byCode.image_local?.severity).toBe('error');
    expect(byCode.image_local?.items).toEqual(expect.arrayContaining(['asset:3c1f4f0e-0000-4000-8000-000000000000', './images/shot.png']));
    expect(byCode.image_local?.items).not.toContain('asset:ignored');
    expect(byCode.link_not_public?.items).toEqual(['http://localhost:3000/x']);
    expect(byCode.mermaid_unsupported?.severity).toBe('warning');
    expect(byCode.liquid_like?.severity).toBe('warning');
  });

  it('warns about a missing canonical URL, and errors on a cover that is not a public https URL', () => {
    expect(devtoAdapter.validate(adapted({ canonicalUrl: null })).find((i) => i.code === 'canonical_missing')?.severity).toBe('warning');
    expect(devtoAdapter.validate(adapted({ coverImageUrl: 'http://example-blog.dev/c.png' })).find((i) => i.code === 'cover_not_public')?.severity).toBe('error');
    expect(devtoAdapter.validate(adapted({ coverImageUrl: 'https://192.168.1.4/c.png' })).find((i) => i.code === 'cover_not_public')?.severity).toBe('error');
  });

  it('errors on an empty title and an empty body', () => {
    const codes = devtoAdapter.validate(adapted({ title: '  ', bodyMarkdown: ' ' })).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['title_empty', 'body_empty']));
  });

  it('previews exactly the JSON that is sent', async () => {
    const payload = adapted();
    const preview = devtoAdapter.preview(payload, false, {}) as { article: Record<string, unknown> };
    await devtoAdapter.stage(ctxFor(), draft(payload));
    expect(fake.requests.at(-1)?.body).toEqual(preview);
    expect(preview.article).toMatchObject({ published: false, tags: 'go,nodejs,c', canonical_url: 'https://example-blog.dev/posts/write-path', main_image: 'https://example-blog.dev/img/cover.png' });
  });
});

describe('DEV.to health', () => {
  it('reads who the key belongs to with the documented headers', async () => {
    const health = await devtoAdapter.health(ctxFor());
    expect(health.who).toBe('@fakeauthor');
    const request = fake.requests[0]!;
    expect(request.headers['api-key']).toBe(KEY);
    expect(request.headers.accept).toBe('application/vnd.forem.api-v1+json');
    expect(request.method).toBe('GET');
  });

  it('classifies a refused key as auth, without the key in the message', async () => {
    const err = await fail(() => devtoAdapter.health(ctxFor({ secret: 'some-other-key-value' })));
    expect(err).toMatchObject({ kind: 'auth', httpStatus: 401 });
    expect(err.message).not.toContain('some-other-key-value');
  });
});

describe('staging on DEV.to', () => {
  it('creates a private draft', async () => {
    const result = await devtoAdapter.stage(ctxFor(), draft(adapted()));
    expect(result.remoteId).toMatch(/^\d+$/);
    expect(result.previewUrl).toContain(fake.origin);
    const row = fake.articles.get(Number(result.remoteId))!;
    expect(row.published).toBe(false);
    expect(row.tags).toBe('go,nodejs,c');
  });

  it('never sends published true', async () => {
    const payload = adapted();
    await devtoAdapter.stage(ctxFor(), draft(payload));
    const second = await devtoAdapter.stage(ctxFor(), draft(payload, [...fake.articles.keys()][0]!.toString()));
    expect(second.remoteId).toBeDefined();
    const writes = fake.requests.filter((r) => r.method !== 'GET');
    expect(writes.length).toBe(2);
    for (const w of writes) expect((w.body as { article: { published: boolean } }).article.published).toBe(false);
  });

  it('updates the same private copy when staged again', async () => {
    const first = await devtoAdapter.stage(ctxFor(), draft(adapted()));
    const second = await devtoAdapter.stage(ctxFor(), draft(adapted({ title: 'A new title' }), first.remoteId));
    expect(second.remoteId).toBe(first.remoteId);
    expect(fake.articles.size).toBe(1);
    expect(fake.articles.get(Number(first.remoteId))?.title).toBe('A new title');
  });

  it('refuses to touch an article that is live, and sends no write', async () => {
    const live = fake.seed({ title: 'Already live', published: true });
    const err = await fail(() => devtoAdapter.stage(ctxFor(), draft(adapted(), String(live.id))));
    expect(err.kind).toBe('validation');
    expect(err.message).toContain('already live');
    expect(fake.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
    expect(fake.articles.get(live.id)?.title).toBe('Already live');
  });

  it('makes a new private draft when the remote one was deleted', async () => {
    const result = await devtoAdapter.stage(ctxFor(), draft(adapted(), '424242'));
    expect(result.remoteId).not.toBe('424242');
    expect(fake.articles.get(Number(result.remoteId))?.published).toBe(false);
  });

  it('refuses an answer that says the article is live', async () => {
    fake.inject({ match: /POST \/api\/articles$/, status: 201, body: { id: 5, published: true, url: 'https://dev.to/x/y' } });
    const err = await fail(() => devtoAdapter.stage(ctxFor(), draft(adapted())));
    expect(err.kind).toBe('protocol');
  });

  it('shows the platform’s own validation message on 422', async () => {
    const err = await fail(() => devtoAdapter.stage(ctxFor(), draft(adapted({ tags: ['a1', 'b2', 'c3', 'd4', 'e5'] }))));
    expect(err).toMatchObject({ kind: 'validation', httpStatus: 422, ambiguous: false });
    expect(err.message).toContain('maximum of 4 tags');
  });
});

describe('publishing on DEV.to', () => {
  async function staged(payload = adapted()) {
    const { remoteId } = await devtoAdapter.stage(ctxFor(), draft(payload));
    fake.requests.length = 0;
    return { payload, remoteId };
  }

  it('sends exactly one request with published true and the approved payload', async () => {
    const { payload, remoteId } = await staged();
    const result = await devtoAdapter.publish(ctxFor(), draft(payload, remoteId));
    expect(fake.requests).toHaveLength(1);
    const request = fake.requests[0]!;
    expect(request.method).toBe('PUT');
    expect(request.path).toBe(`/api/articles/${remoteId}`);
    expect(request.body).toEqual(devtoAdapter.preview(payload, true, {}));
    expect((request.body as { article: { published: boolean } }).article.published).toBe(true);
    expect(fake.articles.get(Number(remoteId))?.published).toBe(true);
    expect(result).toEqual({ remoteId, remoteUrl: expect.stringContaining(fake.origin) });
  });

  it('sends nothing without a staged private draft', async () => {
    const err = await fail(() => devtoAdapter.publish(ctxFor(), draft(adapted(), null)));
    expect(err).toMatchObject({ kind: 'config', ambiguous: false });
    expect(fake.requests).toHaveLength(0);
  });

  it('classifies 401 as auth and 422 as a clean validation refusal', async () => {
    const { payload, remoteId } = await staged();
    fake.inject({ match: /PUT /, status: 401, body: { error: 'unauthorized' } });
    expect(await fail(() => devtoAdapter.publish(ctxFor(), draft(payload, remoteId)))).toMatchObject({ kind: 'auth', ambiguous: false });
    fake.inject({ match: /PUT /, status: 422, body: { error: 'Canonical url has already been taken', status: 422 } });
    const err = await fail(() => devtoAdapter.publish(ctxFor(), draft(payload, remoteId)));
    expect(err).toMatchObject({ kind: 'validation', ambiguous: false });
    expect(err.message).toContain('Canonical url has already been taken');
    expect(fake.articles.get(Number(remoteId))?.published).toBe(false);
  });

  it('reads Retry-After as seconds and as an HTTP date on 429', async () => {
    const { payload, remoteId } = await staged();
    fake.inject({ match: /PUT /, status: 429, headers: { 'retry-after': '45' }, body: { error: 'slow down' } });
    expect(await fail(() => devtoAdapter.publish(ctxFor(), draft(payload, remoteId)))).toMatchObject({ kind: 'rate_limit', retryAfterMs: 45_000, ambiguous: false });
    fake.inject({ match: /PUT /, status: 429, headers: { 'retry-after': 'Wed, 21 Oct 2026 12:03:00 GMT' }, body: { error: 'slow down' } });
    expect(await fail(() => devtoAdapter.publish(ctxFor(), draft(payload, remoteId)))).toMatchObject({ kind: 'rate_limit', retryAfterMs: 180_000 });
  });

  it('treats 5xx, a dropped connection, a timeout and a redirect as ambiguous', async () => {
    const { payload, remoteId } = await staged();
    fake.inject({ match: /PUT /, status: 503, body: 'down' });
    expect(await fail(() => devtoAdapter.publish(ctxFor(), draft(payload, remoteId)))).toMatchObject({ kind: 'server', ambiguous: true });
    fake.inject({ match: /PUT /, drop: true });
    expect(await fail(() => devtoAdapter.publish(ctxFor(), draft(payload, remoteId)))).toMatchObject({ kind: 'network', ambiguous: true });
    fake.inject({ match: /PUT /, hang: true });
    expect(await fail(() => devtoAdapter.publish(ctxFor({ timeoutMs: 30 }), draft(payload, remoteId)))).toMatchObject({ kind: 'timeout', ambiguous: true });
    fake.inject({ match: /PUT /, redirect: 'https://elsewhere.example/steal' });
    expect(await fail(() => devtoAdapter.publish(ctxFor(), draft(payload, remoteId)))).toMatchObject({ kind: 'redirect', ambiguous: true });
    // The key was never sent anywhere else: the fake saw only its own requests.
    expect(fake.requests.every((r) => r.path.startsWith('/api/'))).toBe(true);
  });

  it('treats an unreadable success answer as ambiguous', async () => {
    const { payload, remoteId } = await staged();
    fake.inject({ match: /PUT /, status: 200, body: 'not json at all' });
    expect(await fail(() => devtoAdapter.publish(ctxFor(), draft(payload, remoteId)))).toMatchObject({ kind: 'protocol', ambiguous: true });
  });

  it('refuses a success answer that still says private', async () => {
    const { payload, remoteId } = await staged();
    fake.inject({ match: /PUT /, status: 200, body: { id: Number(remoteId), published: false } });
    expect(await fail(() => devtoAdapter.publish(ctxFor(), draft(payload, remoteId)))).toMatchObject({ kind: 'protocol' });
  });
});

describe('checking on DEV.to', () => {
  it('finds a published article, a private one and a missing one without writing', async () => {
    const payload = adapted();
    const { remoteId } = await devtoAdapter.stage(ctxFor(), draft(payload));
    expect(await devtoAdapter.check(ctxFor(), draft(payload, remoteId))).toEqual({ state: 'private' });
    await devtoAdapter.publish(ctxFor(), draft(payload, remoteId));
    const checked = await devtoAdapter.check(ctxFor(), draft(payload, remoteId));
    expect(checked).toMatchObject({ state: 'published', remoteId });
    expect(await devtoAdapter.check(ctxFor(), draft(payload, '999999'))).toEqual({ state: 'not_found' });
    expect(await devtoAdapter.check(ctxFor(), draft(payload, null))).toEqual({ state: 'not_found' });
  });

  it('sees that a publish went through even when the answer was lost', async () => {
    const payload = adapted();
    const { remoteId } = await devtoAdapter.stage(ctxFor(), draft(payload));
    fake.inject({ match: /PUT /, drop: true, afterApply: true });
    const err = await fail(() => devtoAdapter.publish(ctxFor(), draft(payload, remoteId)));
    expect(err.ambiguous).toBe(true);
    expect((await devtoAdapter.check(ctxFor(), draft(payload, remoteId))).state).toBe('published');
  });

  it('only ever reads', async () => {
    const payload = adapted();
    const { remoteId } = await devtoAdapter.stage(ctxFor(), draft(payload));
    fake.requests.length = 0;
    await devtoAdapter.check(ctxFor(), draft(payload, remoteId));
    expect(fake.requests.every((r) => r.method === 'GET')).toBe(true);
  });
});

describe('every request', () => {
  it('carries the key only in the api-key header and refuses redirects', async () => {
    let init: RequestInit | undefined;
    const spying: typeof fetch = async (url, i) => {
      init = i;
      return fake.fetch(url, i);
    };
    await devtoAdapter.health(ctxFor({ fetch: spying }));
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(init?.body ?? '')).not.toContain(KEY);
  });
});
