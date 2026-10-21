import { beforeEach, describe, expect, it } from 'vitest';
import type { DraftPayload } from '../src/lib/publishing';
import { hashnodeAdapter } from '../src/server/publishing/adapters/hashnode';
import type { AdapterContext, AdaptInput } from '../src/server/publishing/adapters/types';
import { PlatformError } from '../src/server/publishing/errors';
import { createFakeHashnode, type FakeHashnode } from './helpers/fake-hashnode';

const TOKEN = ['fake', 'hashnode', 'pat', '1a2b3c4d5e6f'].join('-');
const PUBLICATION = '650000000000000000000001';
const NOW = new Date('2026-10-21T12:00:00Z');

let fake: FakeHashnode;
const ctxFor = (overrides: Partial<AdapterContext> = {}): AdapterContext => ({
  secret: TOKEN,
  config: { publicationId: PUBLICATION },
  fetch: fake.fetch,
  now: () => NOW,
  baseUrl: fake.origin,
  timeoutMs: 2000,
  ...overrides,
});

const input = (overrides: Partial<AdaptInput> = {}): AdaptInput => ({
  title: 'Why the write path stalls',
  description: 'A short look at write stalls.',
  tags: ['Go', 'Distributed Systems', 'C++'],
  canonicalUrl: 'https://example-blog.dev/posts/write-path',
  coverImageUrl: 'https://example-blog.dev/img/cover.png',
  series: null,
  bodyMarkdown: '# Heading\n\nSome text.\n',
  ...overrides,
});
const adapted = (overrides: Partial<AdaptInput> = {}): DraftPayload => hashnodeAdapter.adapt(input(overrides)).payload;
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
  fake = createFakeHashnode({ token: TOKEN });
});

describe('adapting for Hashnode', () => {
  it('turns tags into slugs and reports the change; adds no body footer', () => {
    const { payload, tagReport } = hashnodeAdapter.adapt(input());
    expect(payload.tags).toEqual(['go', 'distributed-systems', 'c']);
    expect(tagReport.changes).toEqual(['“Go” became “go”.', '“Distributed Systems” became “distributed-systems”.', '“C++” became “c”.']);
    expect(payload.bodyMarkdown).toBe('# Heading\n\nSome text.\n');
  });

  it('allows up to 15 tags and refuses more', () => {
    const many = Array.from({ length: 16 }, (_, i) => `tag${i}`);
    const issues = hashnodeAdapter.validate(adapted({ tags: many }));
    expect(issues.find((i) => i.code === 'tags_too_many')?.severity).toBe('error');
    expect(hashnodeAdapter.validate(adapted({ tags: many.slice(0, 15) })).some((i) => i.code === 'tags_too_many')).toBe(false);
  });

  it('keeps the article under the documented 100 KB request body', () => {
    const issues = hashnodeAdapter.validate(adapted({ bodyMarkdown: 'x'.repeat(95_000) }));
    expect(issues.find((i) => i.code === 'body_too_long')?.severity).toBe('error');
  });

  it('warns that a series is ignored, and flags local images like every platform', () => {
    const issues = hashnodeAdapter.validate(adapted({ series: 'Storage engines', bodyMarkdown: '![x](asset:abc)' }));
    expect(issues.find((i) => i.code === 'series_unsupported')?.severity).toBe('warning');
    expect(issues.find((i) => i.code === 'image_local')?.severity).toBe('error');
  });
});

describe('Hashnode health', () => {
  it('reads the account and the publication to use', async () => {
    const result = await hashnodeAdapter.health(ctxFor({ config: {} }));
    expect(result.who).toBe('@fakewriter');
    expect(result.config).toMatchObject({ publicationId: PUBLICATION, publicationTitle: 'Example Engineering Blog' });
    const sent = fake.requests[0]!;
    expect(sent.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(sent.headers['x-hashnode-client']).toBeTruthy();
  });

  it('keeps the publication the person chose when there are several', async () => {
    fake = createFakeHashnode({
      token: TOKEN,
      publications: [
        { id: PUBLICATION, title: 'One' },
        { id: '650000000000000000000002', title: 'Two' },
      ],
    });
    const result = await hashnodeAdapter.health(ctxFor({ config: { publicationId: '650000000000000000000002' } }));
    expect(result.config?.publicationId).toBe('650000000000000000000002');
    expect(result.config?.publications).toHaveLength(2);
  });

  it('classifies a bad token as auth without echoing it', async () => {
    const err = await fail(() => hashnodeAdapter.health(ctxFor({ secret: 'wrong-token-value-xyz' })));
    expect(err.kind).toBe('auth');
    expect(err.message).not.toContain('wrong-token-value-xyz');
  });
});

describe('staging on Hashnode', () => {
  it('creates a draft, never a post', async () => {
    const payload = adapted();
    const result = await hashnodeAdapter.stage(ctxFor(), draft(payload));
    expect(fake.drafts.has(result.remoteId)).toBe(true);
    expect(fake.posts).toHaveLength(0);
    expect(fake.operations()).toEqual(['CreateDraft']);
    const sent = fake.requests[0]!.variables.input as Record<string, unknown>;
    expect(sent).toMatchObject({
      publicationId: PUBLICATION,
      title: 'Why the write path stalls',
      originalArticleURL: 'https://example-blog.dev/posts/write-path',
      tags: [{ slug: 'go' }, { slug: 'distributed-systems' }, { slug: 'c' }],
      coverImageOptions: { coverImageURL: 'https://example-blog.dev/img/cover.png' },
      metaTags: { description: 'A short look at write stalls.' },
    });
  });

  it('updates the same draft when staged again', async () => {
    const first = await hashnodeAdapter.stage(ctxFor(), draft(adapted()));
    const second = await hashnodeAdapter.stage(ctxFor(), draft(adapted({ title: 'Changed' }), first.remoteId));
    expect(second.remoteId).toBe(first.remoteId);
    expect(fake.drafts.size).toBe(1);
    expect(fake.drafts.get(first.remoteId)?.input.title).toBe('Changed');
    expect(fake.operations()).toEqual(['CreateDraft', 'UpdateDraft']);
  });

  it('makes a new draft when the old one is gone, and still publishes nothing', async () => {
    const result = await hashnodeAdapter.stage(ctxFor(), draft(adapted(), '650000000000000000009999'));
    expect(fake.drafts.has(result.remoteId)).toBe(true);
    expect(fake.posts).toHaveLength(0);
  });

  it('needs a publication', async () => {
    const err = await fail(() => hashnodeAdapter.stage(ctxFor({ config: {} }), draft(adapted())));
    expect(err).toMatchObject({ kind: 'config', ambiguous: false });
    expect(fake.requests).toHaveLength(0);
  });

  it('explains a missing Pro plan and does not call it a bad token', async () => {
    fake.proPlan = false;
    const err = await fail(() => hashnodeAdapter.stage(ctxFor(), draft(adapted())));
    expect(err).toMatchObject({ kind: 'forbidden_plan', ambiguous: false });
    expect(err.message).toContain('Pro plan');
  });

  it('shows Hashnode’s own validation message', async () => {
    fake.inject({ match: /CreateDraft/, gqlError: { code: 'BAD_USER_INPUT', message: 'tags: too many tags' } });
    const err = await fail(() => hashnodeAdapter.stage(ctxFor(), draft(adapted())));
    expect(err).toMatchObject({ kind: 'validation', ambiguous: false });
    expect(err.message).toContain('too many tags');
  });
});

describe('publishing on Hashnode', () => {
  async function staged(payload = adapted()) {
    const { remoteId } = await hashnodeAdapter.stage(ctxFor(), draft(payload));
    fake.requests.length = 0;
    return { payload, remoteId };
  }

  it('writes the approved payload into the draft, then publishes it, and returns the post link', async () => {
    const { payload, remoteId } = await staged();
    const edited = { ...payload, title: 'Approved title' };
    const result = await hashnodeAdapter.publish(ctxFor(), draft(edited, remoteId));
    expect(fake.operations()).toEqual(['UpdateDraft', 'PublishDraft']);
    expect(fake.requests[0]!.variables.input).toMatchObject({ draftId: remoteId, title: 'Approved title' });
    expect(fake.requests[1]!.variables.input).toEqual({ draftId: remoteId });
    expect(fake.posts).toHaveLength(1);
    expect(fake.posts[0]!.title).toBe('Approved title');
    expect(result.remoteUrl).toBe(fake.posts[0]!.url);
    expect(result.remoteId).toBe(fake.posts[0]!.id);
  });

  it('sends nothing without a staged draft', async () => {
    const err = await fail(() => hashnodeAdapter.publish(ctxFor(), draft(adapted(), null)));
    expect(err).toMatchObject({ kind: 'config', ambiguous: false });
    expect(fake.requests).toHaveLength(0);
  });

  it('treats a failure while editing the draft as clean: nothing is public', async () => {
    const { payload, remoteId } = await staged();
    fake.inject({ match: /UpdateDraft/, drop: true });
    const err = await fail(() => hashnodeAdapter.publish(ctxFor(), draft(payload, remoteId)));
    expect(err.ambiguous).toBe(false);
    expect(fake.posts).toHaveLength(0);
    expect(fake.operations()).toEqual(['UpdateDraft']);
  });

  it('classifies the publish step: 5xx, timeout and a lost answer are ambiguous; auth and Pro are clean', async () => {
    const { payload, remoteId } = await staged();
    fake.inject({ match: /PublishDraft/, http: { status: 502, body: 'bad gateway' } });
    expect(await fail(() => hashnodeAdapter.publish(ctxFor(), draft(payload, remoteId)))).toMatchObject({ kind: 'server', ambiguous: true });
    fake.inject({ match: /PublishDraft/, hang: true });
    expect(await fail(() => hashnodeAdapter.publish(ctxFor({ timeoutMs: 30 }), draft(payload, remoteId)))).toMatchObject({ kind: 'timeout', ambiguous: true });
    fake.inject({ match: /PublishDraft/, gqlError: { code: 'INTERNAL_SERVER_ERROR', message: 'oops' } });
    expect(await fail(() => hashnodeAdapter.publish(ctxFor(), draft(payload, remoteId)))).toMatchObject({ kind: 'server', ambiguous: true });
    fake.inject({ match: /PublishDraft/, gqlError: { code: 'UNAUTHENTICATED', message: 'no' } });
    expect(await fail(() => hashnodeAdapter.publish(ctxFor(), draft(payload, remoteId)))).toMatchObject({ kind: 'auth', ambiguous: false });
    fake.inject({ match: /PublishDraft/, gqlError: { code: 'FORBIDDEN', message: 'Publication does not have an active Pro plan. Upgrade in your dashboard to access this via the API.' } });
    expect(await fail(() => hashnodeAdapter.publish(ctxFor(), draft(payload, remoteId)))).toMatchObject({ kind: 'forbidden_plan', ambiguous: false });
  });

  it('reads Retry-After on 429', async () => {
    const { payload, remoteId } = await staged();
    fake.inject({ match: /PublishDraft/, http: { status: 429, headers: { 'retry-after': '20' }, body: {} } });
    expect(await fail(() => hashnodeAdapter.publish(ctxFor(), draft(payload, remoteId)))).toMatchObject({ kind: 'rate_limit', retryAfterMs: 20_000, ambiguous: false });
  });
});

describe('checking on Hashnode', () => {
  it('sees a private draft', async () => {
    const payload = adapted();
    const { remoteId } = await hashnodeAdapter.stage(ctxFor(), draft(payload));
    expect(await hashnodeAdapter.check(ctxFor(), draft(payload, remoteId))).toEqual({ state: 'private' });
  });

  it('finds the post by title and canonical URL once the draft is gone', async () => {
    const payload = adapted();
    const { remoteId } = await hashnodeAdapter.stage(ctxFor(), draft(payload));
    fake.inject({ match: /PublishDraft/, drop: true, afterApply: true });
    const err = await fail(() => hashnodeAdapter.publish(ctxFor(), draft(payload, remoteId)));
    expect(err.ambiguous).toBe(true);
    const checked = await hashnodeAdapter.check(ctxFor(), draft(payload, remoteId));
    expect(checked).toMatchObject({ state: 'published', remoteUrl: fake.posts[0]!.url });
  });

  it('says not found when neither exists', async () => {
    expect(await hashnodeAdapter.check(ctxFor(), draft(adapted(), '650000000000000000008888'))).toEqual({ state: 'not_found' });
    expect(await hashnodeAdapter.check(ctxFor(), draft(adapted(), null))).toEqual({ state: 'not_found' });
  });

  it('uses only read operations', async () => {
    const payload = adapted();
    const { remoteId } = await hashnodeAdapter.stage(ctxFor(), draft(payload));
    fake.requests.length = 0;
    await hashnodeAdapter.check(ctxFor(), draft(payload, remoteId));
    expect(fake.requests.every((r) => r.query.trimStart().startsWith('query'))).toBe(true);
  });
});

describe('every request', () => {
  it('refuses redirects, has a timeout and keeps the token in the header only', async () => {
    let init: RequestInit | undefined;
    const spying: typeof fetch = async (url, i) => {
      init = i;
      return fake.fetch(url, i);
    };
    await hashnodeAdapter.health(ctxFor({ fetch: spying }));
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(String(init?.body)).not.toContain(TOKEN);
  });

  it('previews the two steps of a publish', () => {
    const preview = hashnodeAdapter.preview(adapted(), true, { publicationId: PUBLICATION }, '650000000000000000000042') as { steps: { operation: string }[] };
    expect(preview.steps.map((s) => s.operation)).toEqual(['updateDraft', 'publishDraft']);
  });
});
