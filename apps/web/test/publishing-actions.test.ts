import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { approvalChecklist } from '../src/lib/publishing';
import { createArticle, saveArticle } from '../src/server/actions/articles';
import { ActionError, sessionToOwner, type OwnerContext } from '../src/server/actions/owner';
import {
  approveAndPublish,
  checkOnPlatform,
  connectPlatform,
  declineApproval,
  disconnectPlatform,
  getDraft,
  listConnections,
  listDestinations,
  listDrafts,
  markByHand,
  prepareDraft,
  requestApproval,
  stageDraft,
  testConnection,
} from '../src/server/actions/publishing';
import type { DbHandle } from '../src/server/db/client';
import { users } from '../src/server/db/schema';
import { plainSecret, type PublishEnv } from '../src/server/publishing/registry';
import { createFakeDevto, type FakeDevto } from './helpers/fake-devto';
import { memoryDb, testConfig } from './helpers';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const KEY = ['fake', 'devto', 'key', 'a1b2c3d4e5f6'].join('-');
const START = new Date('2026-10-21T12:00:00Z');

let handle: DbHandle;
let fake: FakeDevto;
let clock: Date;
let env: PublishEnv;
let owner: OwnerContext;
let other: OwnerContext;

const as = (userId: string, actor: OwnerContext['actor'] = 'owner') => sessionToOwner({ userId }, { db: handle.db }, actor);
const checklistFor = (canonical = true) => approvalChecklist('DEV.to', canonical);
const writes = () => fake.requests.filter((r) => r.method !== 'GET');
const publishWrites = () => writes().filter((r) => (r.body as { article?: { published?: boolean } } | null)?.article?.published === true);

async function expectError(run: () => Promise<unknown>, code?: string) {
  const err = await run().then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ActionError);
  if (code) expect((err as ActionError).code).toBe(code);
  return err as ActionError;
}

let counter = 0;
async function newArticle(extra: { title?: string; body?: string; tags?: string[]; canonicalUrl?: string } = {}, who: OwnerContext = owner) {
  return createArticle(who, {
    title: extra.title ?? `Why the write path stalls ${++counter}`,
    description: 'A short look at write stalls.',
    tags: extra.tags ?? ['Go', 'databases'],
    canonicalUrl: extra.canonicalUrl ?? 'https://example-blog.dev/posts/write-path',
    bodyMarkdown: extra.body ?? '# Intro\n\nThe write path stalls when the log fills.\n',
  });
}

/** Prepare, stage and request approval for a fresh article. */
async function readyToApprove(extra: Parameters<typeof newArticle>[0] = {}) {
  const article = await newArticle(extra);
  const prepared = await prepareDraft(owner, env, { articleId: article.id, platform: 'devto' });
  const staged = await stageDraft(owner, env, prepared.id);
  expect(staged.ok).toBe(true);
  const requested = await requestApproval(owner, env, prepared.id);
  return { article, draftId: prepared.id, approvalId: requested.draft.approval!.id, requested };
}

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
  fake = createFakeDevto({ apiKey: KEY });
  clock = new Date(START);
  env = { config: testConfig(), fetchFn: fake.fetch, now: () => clock, sleep: async () => undefined, timeoutMs: 2000 };
  owner = as(A);
  other = as(B);
  for (const who of [owner, other]) {
    const existing = await who.data.connections.getByPlatform('devto');
    if (existing) await who.data.connections.remove(existing.id);
  }
  await connectPlatform(owner, env, { platform: 'devto', secret: KEY });
});

describe('connections', () => {
  it('stores the key encrypted, bound to the owner, and never returns it', async () => {
    const [view] = (await listConnections(owner)).filter((v) => v.platform === 'devto');
    expect(view?.connection).toMatchObject({ platform: 'devto', status: 'connected', who: '@fakeauthor', keyLast4: KEY.slice(-4) });
    expect(JSON.stringify(view)).not.toContain(KEY);

    const row = (await owner.data.connections.getByPlatform('devto'))!;
    const withKey = (await owner.data.connections.getWithKey(row.id))!;
    expect(withKey.encryptedKey.startsWith('v1.')).toBe(true);
    expect(withKey.encryptedKey).not.toContain(KEY);
    expect(plainSecret(env, withKey)).toBe(KEY);
    // Copied to another tenant's row it cannot be read: the owner and row are part of the encryption.
    expect(() => plainSecret(env, { ...withKey, ownerId: B })).toThrow();
  });

  it('refuses a key the platform rejects, and stores nothing', async () => {
    const before = (await listConnections(other)).find((v) => v.platform === 'devto');
    expect(before?.connection).toBeNull();
    const err = await expectError(() => connectPlatform(other, env, { platform: 'devto', secret: 'a-key-the-platform-does-not-know' }), 'invalid');
    expect(err.message).not.toContain('a-key-the-platform-does-not-know');
    expect((await listConnections(other)).find((v) => v.platform === 'devto')?.connection).toBeNull();
  });

  it('keeps the key out of the audit log, the connection view and every error', async () => {
    fake.inject({ match: /GET \/api\/users\/me/, status: 500, body: `oops, key was ${KEY}` });
    const result = await testConnection(owner, env, (await owner.data.connections.getByPlatform('devto'))!.id);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(await owner.data.audit.list(500))).not.toContain(KEY);
    expect(JSON.stringify(await owner.data.connections.list())).not.toContain(KEY);
  });

  it('marks a connection that the platform stops accepting', async () => {
    fake.inject({ match: /GET \/api\/users\/me/, status: 401, body: { error: 'unauthorized' } });
    const row = (await owner.data.connections.getByPlatform('devto'))!;
    const result = await testConnection(owner, env, row.id);
    expect(result.ok).toBe(false);
    expect(result.connection.status).toBe('needs_reconnect');
    // And a later good probe recovers it.
    expect((await testConnection(owner, env, row.id)).connection.status).toBe('connected');
  });

  it('replaces the key on the same row when connected again', async () => {
    const first = (await owner.data.connections.getByPlatform('devto'))!;
    const again = await connectPlatform(owner, env, { platform: 'devto', secret: KEY });
    expect(again.id).toBe(first.id);
  });

  it('can only be managed by a signed-in person', async () => {
    for (const actor of ['agent', 'ai'] as const) {
      const bot = as(A, actor);
      await expectError(() => connectPlatform(bot, env, { platform: 'devto', secret: KEY }), 'forbidden');
    }
    const row = (await owner.data.connections.getByPlatform('devto'))!;
    await expectError(() => testConnection(as(A, 'agent'), env, row.id), 'forbidden');
    await expectError(() => disconnectPlatform(as(A, 'agent'), row.id), 'forbidden');
    expect(await owner.data.connections.getByPlatform('devto')).not.toBeNull();
  });

  it('disconnecting removes the key', async () => {
    const row = (await owner.data.connections.getByPlatform('devto'))!;
    await disconnectPlatform(owner, row.id);
    expect(await owner.data.connections.getWithKey(row.id)).toBeNull();
  });

  it('cannot see or change another person’s connection', async () => {
    const row = (await owner.data.connections.getByPlatform('devto'))!;
    await expectError(() => testConnection(other, env, row.id), 'not_found');
    await expectError(() => disconnectPlatform(other, row.id), 'not_found');
    expect((await listConnections(other)).every((v) => v.connection === null)).toBe(true);
  });
});

describe('preparing a draft', () => {
  it('needs a connection', async () => {
    const article = await newArticle({}, other);
    const err = await expectError(() => prepareDraft(other, env, { articleId: article.id, platform: 'devto' }), 'conflict');
    expect(err.message).toContain('Connect DEV.to first');
  });

  it('builds the payload, reports tags and lint, and sends nothing', async () => {
    const article = await newArticle({ tags: ['Go', 'C++', 'node.js'] });
    const before = fake.requests.length;
    const draft = await prepareDraft(owner, env, { articleId: article.id, platform: 'devto' });
    expect(fake.requests.length).toBe(before);
    expect(draft.status).toBe('draft');
    expect(draft.payload.tags).toEqual(['go', 'c', 'nodejs']);
    expect(draft.tagReport.changes.length).toBe(3);
    expect(draft.payload.bodyMarkdown).toContain('Originally published at');
    expect(draft.account).toBe('@fakeauthor');
    expect(draft.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(draft.sourceRevision).toBe(article.revision);
    expect(JSON.parse(draft.requestPreview).article).toMatchObject({ published: true, tags: 'go,c,nodejs' });
    expect(draft.lint.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('blocks a local image: the lint is an error and staging and approval refuse', async () => {
    const article = await newArticle({ body: 'Look:\n\n![chart](asset:3c1f4f0e-0000-4000-8000-000000000000)\n' });
    const draft = await prepareDraft(owner, env, { articleId: article.id, platform: 'devto' });
    const issue = draft.lint.find((i) => i.code === 'image_local');
    expect(issue).toMatchObject({ severity: 'error', message: 'This image only exists on your machine; use a public URL.' });
    await expectError(() => stageDraft(owner, env, draft.id), 'invalid');
    await expectError(() => requestApproval(owner, env, draft.id));
    expect(writes()).toHaveLength(0);
  });

  it('warns about a missing canonical URL without blocking', async () => {
    const article = await createArticle(owner, { title: 'No canonical', bodyMarkdown: 'Text.', tags: ['go'] });
    const draft = await prepareDraft(owner, env, { articleId: article.id, platform: 'devto' });
    expect(draft.lint.find((i) => i.code === 'canonical_missing')?.severity).toBe('warning');
    expect(draft.lint.some((i) => i.severity === 'error')).toBe(false);
    expect((await stageDraft(owner, env, draft.id)).ok).toBe(true);
  });

  it('blocks more than four tags after cleaning instead of dropping some', async () => {
    const article = await newArticle({ tags: ['a1', 'b2', 'c3', 'd4', 'e5'] });
    const draft = await prepareDraft(owner, env, { articleId: article.id, platform: 'devto' });
    expect(draft.payload.tags).toHaveLength(5);
    expect(draft.lint.find((i) => i.code === 'tags_too_many')?.severity).toBe('error');
  });

  it('blocks an empty title', async () => {
    const article = await createArticle(owner, { title: '', bodyMarkdown: 'Text.' });
    const draft = await prepareDraft(owner, env, { articleId: article.id, platform: 'devto' });
    expect(draft.lint.find((i) => i.code === 'title_empty')?.severity).toBe('error');
  });

  it('rebuilding the same article keeps one draft and a different hash after an edit', async () => {
    const article = await newArticle();
    const first = await prepareDraft(owner, env, { articleId: article.id, platform: 'devto' });
    const same = await prepareDraft(owner, env, { articleId: article.id, platform: 'devto' });
    expect(same.id).toBe(first.id);
    expect(same.payloadSha256).toBe(first.payloadSha256);
    await saveArticle(owner, article.id, { expectedRevision: article.revision, title: 'A different title' });
    const rebuilt = await prepareDraft(owner, env, { articleId: article.id, platform: 'devto' });
    expect(rebuilt.id).toBe(first.id);
    expect(rebuilt.payloadSha256).not.toBe(first.payloadSha256);
    expect(rebuilt.status).toBe('draft');
    expect((await listDrafts(owner, env, { articleId: article.id })).length).toBe(1);
  });

  it('shows destinations with capabilities, connection state and the draft', async () => {
    const article = await newArticle();
    const before = await listDestinations(owner, env, article.id);
    expect(before.map((d) => d.platform)).toEqual(['devto', 'hashnode']);
    expect(before[0]).toMatchObject({ connection: { status: 'connected' }, draft: null });
    expect(before[1]!.connection).toBeNull();
    expect(before[0]!.info.capabilities.tagsMax).toBe(4);
    const draft = await prepareDraft(owner, env, { articleId: article.id, platform: 'devto' });
    expect((await listDestinations(owner, env, article.id))[0]!.draft?.id).toBe(draft.id);
  });
});

describe('staging', () => {
  it('creates a private draft and never sends published true', async () => {
    const article = await newArticle();
    const draft = await prepareDraft(owner, env, { articleId: article.id, platform: 'devto' });
    const result = await stageDraft(owner, env, draft.id);
    expect(result.ok).toBe(true);
    expect(result.draft).toMatchObject({ status: 'staged', remoteId: expect.stringMatching(/^\d+$/) });
    expect(fake.articles.get(Number(result.draft.remoteId))?.published).toBe(false);
    expect(publishWrites()).toHaveLength(0);
    expect(result.draft.attempts[0]).toMatchObject({ kind: 'stage', status: 'succeeded' });
  });

  it('updates the same private copy when staged again', async () => {
    const article = await newArticle();
    const draft = await prepareDraft(owner, env, { articleId: article.id, platform: 'devto' });
    const first = await stageDraft(owner, env, draft.id);
    await saveArticle(owner, article.id, { expectedRevision: article.revision, bodyMarkdown: 'Rewritten.' });
    await prepareDraft(owner, env, { articleId: article.id, platform: 'devto' });
    const second = await stageDraft(owner, env, draft.id);
    expect(second.draft.remoteId).toBe(first.draft.remoteId);
    expect(fake.articles.size).toBe(1);
    expect([...fake.articles.values()][0]!.body_markdown).toContain('Rewritten.');
  });

  it('retries a transient failure on an update, with a pause, and then succeeds', async () => {
    const article = await newArticle();
    const draft = await prepareDraft(owner, env, { articleId: article.id, platform: 'devto' });
    await stageDraft(owner, env, draft.id);
    await prepareDraft(owner, env, { articleId: article.id, platform: 'devto' });
    const pauses: number[] = [];
    env = { ...env, sleep: async (ms) => void pauses.push(ms) };
    fake.inject({ match: /PUT /, status: 503, body: 'busy' });
    const result = await stageDraft(owner, env, draft.id);
    expect(result.ok).toBe(true);
    expect(pauses).toEqual([1000]);
    expect(writes().filter((r) => r.method === 'PUT')).toHaveLength(2);
  });

  it('does not repeat a first create that ended ambiguously, so it cannot make two drafts', async () => {
    const article = await newArticle();
    const draft = await prepareDraft(owner, env, { articleId: article.id, platform: 'devto' });
    fake.inject({ match: /POST /, drop: true, afterApply: true });
    const result = await stageDraft(owner, env, draft.id);
    expect(result.ok).toBe(false);
    expect(writes().filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(result.draft.status).toBe('failed');
    expect(result.draft.failureMessage).toBeTruthy();
    expect(result.message).toContain('Try again');
  });

  it('retries a short rate limit but gives up after three tries and says how long to wait', async () => {
    const article = await newArticle();
    const draft = await prepareDraft(owner, env, { articleId: article.id, platform: 'devto' });
    fake.inject({ match: /POST /, status: 429, headers: { 'retry-after': '2' }, body: { error: 'slow' }, times: 5 });
    const result = await stageDraft(owner, env, draft.id);
    expect(result.ok).toBe(false);
    expect(writes().filter((r) => r.method === 'POST')).toHaveLength(3);
    expect(result.message).toContain('about 2 seconds');
    expect(result.draft.failureKind).toBe('rate_limit');
  });

  it('does not retry a long rate limit', async () => {
    const article = await newArticle();
    const draft = await prepareDraft(owner, env, { articleId: article.id, platform: 'devto' });
    fake.inject({ match: /POST /, status: 429, headers: { 'retry-after': '120' }, body: {} });
    const result = await stageDraft(owner, env, draft.id);
    expect(writes().filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(result.message).toContain('about 2 minutes');
  });

  it('on 401 asks to reconnect and flags the connection', async () => {
    const article = await newArticle();
    const draft = await prepareDraft(owner, env, { articleId: article.id, platform: 'devto' });
    fake.inject({ match: /POST /, status: 401, body: { error: 'unauthorized' } });
    const result = await stageDraft(owner, env, draft.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Reconnect DEV.to');
    expect((await owner.data.connections.getByPlatform('devto'))?.status).toBe('needs_reconnect');
    expect(writes().filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('on 422 shows the platform’s message and a next step', async () => {
    const article = await newArticle();
    const draft = await prepareDraft(owner, env, { articleId: article.id, platform: 'devto' });
    fake.inject({ match: /POST /, status: 422, body: { error: 'Canonical url is not a valid URL', status: 422 } });
    const result = await stageDraft(owner, env, draft.id);
    expect(result.message).toContain('Canonical url is not a valid URL');
    expect(result.draft.nextAction).toBeTruthy();
  });

  it('refuses to stage a live article’s remote copy', async () => {
    const article = await newArticle();
    const draft = await prepareDraft(owner, env, { articleId: article.id, platform: 'devto' });
    const live = fake.seed({ title: 'Live', published: true });
    await owner.data.platformDrafts.markStaged(draft.id, draft.payloadSha256, { remoteId: String(live.id), previewUrl: null });
    const result = await stageDraft(owner, env, draft.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('already live');
    expect(writes()).toHaveLength(0);
    expect(fake.articles.get(live.id)?.title).toBe('Live');
  });

  it('cannot stage a draft that is waiting for approval, or whose article changed', async () => {
    const { draftId, article } = await readyToApprove();
    await expectError(() => stageDraft(owner, env, draftId), 'conflict');
    await saveArticle(owner, article.id, { expectedRevision: article.revision, bodyMarkdown: 'changed' });
    const err = await expectError(() => stageDraft(owner, env, draftId), 'conflict');
    expect(err.message).toContain('Rebuild');
  });
});

describe('asking for approval', () => {
  it('needs a staged private draft', async () => {
    const article = await newArticle();
    const draft = await prepareDraft(owner, env, { articleId: article.id, platform: 'devto' });
    const err = await expectError(() => requestApproval(owner, env, draft.id), 'conflict');
    expect(err.message).toContain('Stage the private draft');
  });

  it('creates one pending, hash-bound request with a short tag, a link and a 30 minute life', async () => {
    const { requested, draftId } = await readyToApprove();
    const approval = requested.draft.approval!;
    expect(requested.draft.status).toBe('pending_approval');
    expect(approval).toMatchObject({ status: 'pending', requestedBy: 'owner', payloadSha256: requested.draft.payloadSha256 });
    expect(approval.tag).toBe(`#${requested.draft.payloadSha256.slice(0, 8).toUpperCase()}`);
    expect(Date.parse(approval.expiresAt) - START.getTime()).toBe(30 * 60_000);
    expect(requested.link).toBe(`${env.config.appUrl}/articles/${requested.draft.articleId}?panel=publish`);
    expect((await getDraft(owner, env, draftId)).approval?.id).toBe(approval.id);
  });

  it('a newer request voids the older one, so only one can be spent', async () => {
    const { draftId, approvalId } = await readyToApprove();
    const second = await requestApproval(owner, env, draftId);
    await expectError(() => approveAndPublish(owner, env, approvalId, { checked: checklistFor() }), 'conflict');
    expect(publishWrites()).toHaveLength(0);
    expect(second.draft.approval?.status).toBe('pending');
  });

  it('an agent may ask, and the request says who asked', async () => {
    const article = await newArticle();
    const bot = as(A, 'agent');
    const draft = await prepareDraft(bot, env, { articleId: article.id, platform: 'devto' });
    await stageDraft(bot, env, draft.id);
    const asked = await requestApproval(bot, env, draft.id);
    expect(asked.draft.approval?.requestedBy).toBe('agent');
    expect(asked.draft.status).toBe('pending_approval');
    expect(publishWrites()).toHaveLength(0);
  });

  it('declining returns the draft to staged', async () => {
    const { draftId, approvalId } = await readyToApprove();
    const after = await declineApproval(owner, env, approvalId);
    expect(after.status).toBe('staged');
    expect((await getDraft(owner, env, draftId)).approval?.status).toBe('denied');
    await expectError(() => approveAndPublish(owner, env, approvalId, { checked: checklistFor() }), 'conflict');
  });
});

describe('approve and publish', () => {
  it('publishes exactly the approved payload with one request, and stores the remote id and link', async () => {
    const { draftId, approvalId, requested } = await readyToApprove();
    fake.requests.length = 0;
    const result = await approveAndPublish(owner, env, approvalId, { checked: checklistFor() });
    expect(result.outcome).toBe('published');
    expect(result.draft).toMatchObject({ status: 'published', remoteUrl: expect.stringContaining(fake.origin), remoteId: requested.draft.remoteId });
    expect(result.draft.attempts.find((a) => a.kind === 'publish')).toMatchObject({ status: 'succeeded', remoteUrl: result.draft.remoteUrl });
    const sent = publishWrites();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual(JSON.parse(requested.draft.requestPreview));
    expect(fake.articles.get(Number(requested.draft.remoteId))?.published).toBe(true);
    // The article now records that it is published.
    expect((await owner.data.articles.get(requested.draft.articleId))?.publishedAt).not.toBeNull();
    expect((await getDraft(owner, env, draftId)).approval?.status).toBe('used');
  });

  it('refuses unless every checklist box is ticked, and sends nothing', async () => {
    const { approvalId } = await readyToApprove();
    fake.requests.length = 0;
    const err = await expectError(() => approveAndPublish(owner, env, approvalId, { checked: checklistFor().slice(0, 2) }), 'invalid');
    expect(err.message).toContain('Tick every box');
    expect(writes()).toHaveLength(0);
    expect((await owner.data.platformDrafts.getApproval(approvalId))?.status).toBe('pending');
  });

  it('a second use of the same approval is refused and sends nothing', async () => {
    const { approvalId } = await readyToApprove();
    await approveAndPublish(owner, env, approvalId, { checked: checklistFor() });
    fake.requests.length = 0;
    await expectError(() => approveAndPublish(owner, env, approvalId, { checked: checklistFor() }), 'conflict');
    expect(writes()).toHaveLength(0);
  });

  it('two simultaneous approvals make exactly one remote call', async () => {
    const { approvalId } = await readyToApprove();
    fake.requests.length = 0;
    const results = await Promise.allSettled([1, 2, 3].map(() => approveAndPublish(owner, env, approvalId, { checked: checklistFor() })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(publishWrites()).toHaveLength(1);
  });

  it('an expired approval cannot be used', async () => {
    const { approvalId } = await readyToApprove();
    clock = new Date(START.getTime() + 31 * 60_000);
    fake.requests.length = 0;
    await expectError(() => approveAndPublish(owner, env, approvalId, { checked: checklistFor() }), 'conflict');
    expect(writes()).toHaveLength(0);
  });

  it('editing the article after approval voids it, flags the draft and sends nothing', async () => {
    const { article, draftId, approvalId } = await readyToApprove();
    await saveArticle(owner, article.id, { expectedRevision: article.revision, bodyMarkdown: 'Quietly changed after I asked.' });
    const view = await getDraft(owner, env, draftId);
    expect(view).toMatchObject({ status: 'source_changed', stale: true });
    expect(view.approval?.status).toBe('invalidated');
    fake.requests.length = 0;
    await expectError(() => approveAndPublish(owner, env, approvalId, { checked: checklistFor() }), 'conflict');
    expect(writes()).toHaveLength(0);
  });

  it('a draft rebuilt after an edit needs a new stage and a new approval', async () => {
    const { article, draftId, approvalId } = await readyToApprove();
    await saveArticle(owner, article.id, { expectedRevision: article.revision, title: 'Edited title' });
    const rebuilt = await prepareDraft(owner, env, { articleId: article.id, platform: 'devto' });
    expect(rebuilt.status).toBe('draft');
    expect(rebuilt.stale).toBe(false);
    await expectError(() => requestApproval(owner, env, draftId), 'conflict');
    await expectError(() => approveAndPublish(owner, env, approvalId, { checked: checklistFor() }), 'conflict');
    expect((await stageDraft(owner, env, draftId)).ok).toBe(true);
    const again = await requestApproval(owner, env, draftId);
    const done = await approveAndPublish(owner, env, again.draft.approval!.id, { checked: checklistFor() });
    expect(done.outcome).toBe('published');
    expect(fake.articles.get(Number(done.draft.remoteId))?.title).toBe('Edited title');
  });

  it('refuses to publish when the connection is no longer healthy, keeping the approval pending', async () => {
    const { approvalId } = await readyToApprove();
    fake.inject({ match: /GET \/api\/users\/me/, status: 401, body: { error: 'unauthorized' } });
    fake.requests.length = 0;
    const err = await expectError(() => approveAndPublish(owner, env, approvalId, { checked: checklistFor() }), 'unavailable');
    expect(err.message).toContain('Nothing was sent');
    expect(writes()).toHaveLength(0);
    expect((await owner.data.platformDrafts.getApproval(approvalId))?.status).toBe('pending');
  });

  it('never publishes the same payload twice, even from a second draft', async () => {
    const first = await readyToApprove({ title: 'Identical piece', body: 'Same text.', tags: ['go'] });
    await approveAndPublish(owner, env, first.approvalId, { checked: checklistFor() });
    const second = await readyToApprove({ title: 'Identical piece', body: 'Same text.', tags: ['go'] });
    expect(second.requested.draft.payloadSha256).toBe(first.requested.draft.payloadSha256);
    fake.requests.length = 0;
    const err = await expectError(() => approveAndPublish(owner, env, second.approvalId, { checked: checklistFor() }), 'conflict');
    expect(err.message).toMatch(/already/i);
    expect(publishWrites()).toHaveLength(0);
  });

  it('records a clean refusal (422) as failed, spends the approval, and does not retry', async () => {
    const { draftId, approvalId } = await readyToApprove();
    fake.requests.length = 0;
    fake.inject({ match: /PUT /, status: 422, body: { error: 'Canonical url has already been taken', status: 422 } });
    const result = await approveAndPublish(owner, env, approvalId, { checked: checklistFor() });
    expect(result.outcome).toBe('failed');
    expect(result.message).toContain('Canonical url has already been taken');
    expect(result.draft.status).toBe('failed');
    expect(publishWrites()).toHaveLength(1);
    expect((await getDraft(owner, env, draftId)).approval?.status).toBe('used');
    // The old approval cannot be reused; a new one needs a fresh stage.
    await expectError(() => approveAndPublish(owner, env, approvalId, { checked: checklistFor() }), 'conflict');
    await expectError(() => requestApproval(owner, env, draftId), 'conflict');
    expect((await stageDraft(owner, env, draftId)).ok).toBe(true);
    const next = await requestApproval(owner, env, draftId);
    expect((await approveAndPublish(owner, env, next.draft.approval!.id, { checked: checklistFor() })).outcome).toBe('published');
  });

  it('records 401 as failed and asks to reconnect', async () => {
    const { approvalId } = await readyToApprove();
    fake.inject({ match: /PUT /, status: 401, body: { error: 'unauthorized' } });
    const result = await approveAndPublish(owner, env, approvalId, { checked: checklistFor() });
    expect(result.outcome).toBe('failed');
    expect(result.message).toContain('Reconnect DEV.to');
    expect((await owner.data.connections.getByPlatform('devto'))?.status).toBe('needs_reconnect');
  });

  it('records 429 as failed with the wait', async () => {
    const { approvalId } = await readyToApprove();
    fake.inject({ match: /PUT /, status: 429, headers: { 'retry-after': '90' }, body: {} });
    const result = await approveAndPublish(owner, env, approvalId, { checked: checklistFor() });
    expect(result.outcome).toBe('failed');
    expect(result.message).toMatch(/about (90 seconds|2 minutes)/);
    expect(publishWrites()).toHaveLength(1);
  });

  it.each([
    ['a server error', { status: 503, body: 'down' }],
    ['a dropped connection', { drop: true }],
    ['a redirect', { redirect: 'https://elsewhere.example/x' }],
  ])('treats %s after sending as unknown, never retried', async (_label, injection) => {
    const { approvalId, draftId } = await readyToApprove();
    fake.inject({ match: /PUT /, ...injection });
    fake.requests.length = 0;
    const result = await approveAndPublish(owner, env, approvalId, { checked: checklistFor() });
    expect(result.outcome).toBe('unknown');
    expect(result.message).toContain('may or may not be live');
    expect(result.draft.status).toBe('unknown');
    expect(publishWrites()).toHaveLength(1);
    // Not re-approvable, not re-stageable, not rebuildable, until it is resolved.
    await expectError(() => requestApproval(owner, env, draftId), 'conflict');
    await expectError(() => stageDraft(owner, env, draftId), 'conflict');
    await expectError(() => prepareDraft(owner, env, { articleId: result.draft.articleId, platform: 'devto' }), 'conflict');
    await expectError(() => approveAndPublish(owner, env, approvalId, { checked: checklistFor() }), 'conflict');
    expect(publishWrites()).toHaveLength(1);
  });

  it('treats a timeout as unknown', async () => {
    const { approvalId } = await readyToApprove();
    fake.inject({ match: /PUT /, hang: true });
    const result = await approveAndPublish(owner, { ...env, timeoutMs: 40 }, approvalId, { checked: checklistFor() });
    expect(result.outcome).toBe('unknown');
    expect(result.draft.failureKind).toBe('timeout');
  });
});

describe('resolving an unknown result', () => {
  async function unknownAfter(injection: Parameters<FakeDevto['inject']>[0]) {
    const ready = await readyToApprove();
    fake.inject(injection);
    const result = await approveAndPublish(owner, env, ready.approvalId, { checked: checklistFor() });
    expect(result.outcome).toBe('unknown');
    return { ...ready, result };
  }

  it('a check that finds it live records it as published, with the link', async () => {
    const { draftId } = await unknownAfter({ match: /PUT /, drop: true, afterApply: true });
    const checked = await checkOnPlatform(owner, env, draftId);
    expect(checked.remote).toBe('published');
    expect(checked.draft).toMatchObject({ status: 'published', remoteUrl: expect.stringContaining(fake.origin) });
  });

  it('a check that finds it still private returns it to staged, and only then can approval be asked again', async () => {
    const { draftId } = await unknownAfter({ match: /PUT /, drop: true });
    const checked = await checkOnPlatform(owner, env, draftId);
    expect(checked.remote).toBe('private');
    expect(checked.draft.status).toBe('staged');
    const again = await requestApproval(owner, env, draftId);
    expect(again.draft.approval?.status).toBe('pending');
    expect((await approveAndPublish(owner, env, again.draft.approval!.id, { checked: checklistFor() })).outcome).toBe('published');
  });

  it('a check that cannot find it leaves it unknown', async () => {
    const { draftId, result } = await unknownAfter({ match: /PUT /, drop: true });
    fake.articles.clear();
    const checked = await checkOnPlatform(owner, env, draftId);
    expect(checked.remote).toBe('not_found');
    expect(checked.draft.status).toBe('unknown');
    expect(result.draft.status).toBe('unknown');
  });

  it('marking by hand needs an explicit confirmation and only works from unknown', async () => {
    const { draftId } = await unknownAfter({ match: /PUT /, drop: true });
    await expectError(() => markByHand(owner, env, draftId, { outcome: 'posted' }), 'invalid');
    await expectError(() => markByHand(owner, env, draftId, { outcome: 'posted', confirm: false }), 'invalid');
    const done = await markByHand(owner, env, draftId, { outcome: 'posted', remoteUrl: 'https://dev.to/fakeauthor/by-hand-1', confirm: true });
    expect(done).toMatchObject({ status: 'published', remoteUrl: 'https://dev.to/fakeauthor/by-hand-1' });
    await expectError(() => markByHand(owner, env, draftId, { outcome: 'not_posted', confirm: true }), 'conflict');
  });

  it('marking as not posted returns it to staged', async () => {
    const { draftId } = await unknownAfter({ match: /PUT /, drop: true });
    expect((await markByHand(owner, env, draftId, { outcome: 'not_posted', confirm: true })).status).toBe('staged');
  });

  it('a publish that never recorded an answer shows as unknown, not failed', async () => {
    const { draftId } = await readyToApprove();
    // Simulate a crash between authorization and the answer: the draft is publishing and nothing settled it.
    const draft = (await owner.data.platformDrafts.get(draftId))!;
    const approval = (await owner.data.platformDrafts.latestApproval(draftId))!;
    await owner.data.platformDrafts.authorizePublish({ draftId, approvalId: approval.id, checked: [], now: clock });
    expect((await getDraft(owner, env, draftId)).status).toBe('publishing');
    clock = new Date(clock.getTime() + 10 * 60_000);
    const later = await getDraft(owner, env, draftId);
    expect(later.status).toBe('unknown');
    expect(later.failureKind).toBe('timeout');
    expect(draft.id).toBe(draftId);
  });
});

describe('who may do what', () => {
  it('only a signed-in owner can approve, decline, check or mark by hand', async () => {
    const { draftId, approvalId } = await readyToApprove();
    for (const actor of ['agent', 'ai'] as const) {
      const bot = as(A, actor);
      await expectError(() => approveAndPublish(bot, env, approvalId, { checked: checklistFor() }), 'forbidden');
      await expectError(() => declineApproval(bot, env, approvalId), 'forbidden');
      await expectError(() => checkOnPlatform(bot, env, draftId), 'forbidden');
      await expectError(() => markByHand(bot, env, draftId, { outcome: 'posted', confirm: true }), 'forbidden');
    }
    expect(publishWrites()).toHaveLength(0);
    expect((await owner.data.platformDrafts.getApproval(approvalId))?.status).toBe('pending');
  });
});

describe('tenant isolation of the publishing actions', () => {
  it('another account cannot read, stage, approve, decline, check or mark someone else’s draft', async () => {
    const { article, draftId, approvalId } = await readyToApprove();
    await connectPlatform(other, env, { platform: 'devto', secret: KEY });
    await expectError(() => getDraft(other, env, draftId), 'not_found');
    await expectError(() => stageDraft(other, env, draftId), 'not_found');
    await expectError(() => requestApproval(other, env, draftId), 'not_found');
    await expectError(() => approveAndPublish(other, env, approvalId, { checked: checklistFor() }), 'not_found');
    await expectError(() => declineApproval(other, env, approvalId), 'conflict');
    await expectError(() => checkOnPlatform(other, env, draftId), 'not_found');
    await expectError(() => markByHand(other, env, draftId, { outcome: 'posted', confirm: true }), 'not_found');
    await expectError(() => prepareDraft(other, env, { articleId: article.id, platform: 'devto' }), 'not_found');
    await expectError(() => listDestinations(other, env, article.id), 'not_found');
    expect(await listDrafts(other, env, {})).toEqual([]);
    expect(await listDrafts(other, env, { articleId: article.id })).toEqual([]);
    expect(publishWrites()).toHaveLength(0);
    expect((await getDraft(owner, env, draftId)).status).toBe('pending_approval');
  });

  it('keeps audit rows for publishing apart too', async () => {
    const { draftId, approvalId } = await readyToApprove();
    await approveAndPublish(owner, env, approvalId, { checked: checklistFor() });
    const mine = await owner.data.audit.list(500);
    expect(mine.some((e) => e.action === 'platform.published' && e.entityId === draftId)).toBe(true);
    expect(mine.some((e) => e.action === 'approval.requested')).toBe(true);
    const theirs = await other.data.audit.list(500);
    expect(theirs.some((e) => e.entityId === draftId || e.entityId === approvalId)).toBe(false);
  });

  it('two accounts can publish the same text, each through their own connection', async () => {
    await connectPlatform(other, env, { platform: 'devto', secret: KEY });
    const mine = await readyToApprove({ title: 'Parallel', body: 'Same words.' });
    const article = await newArticle({ title: 'Parallel', body: 'Same words.' }, other);
    const draft = await prepareDraft(other, env, { articleId: article.id, platform: 'devto' });
    await stageDraft(other, env, draft.id);
    const asked = await requestApproval(other, env, draft.id);
    expect((await approveAndPublish(owner, env, mine.approvalId, { checked: checklistFor() })).outcome).toBe('published');
    expect((await approveAndPublish(other, env, asked.draft.approval!.id, { checked: checklistFor() })).outcome).toBe('published');
  });
});

describe('secrets', () => {
  it('never appear in drafts, attempts, audit rows or error text, even when the platform echoes the key', async () => {
    const { draftId, approvalId } = await readyToApprove();
    fake.inject({ match: /PUT /, status: 422, body: { error: `Rejected for key ${KEY}`, status: 422 } });
    const failed = await approveAndPublish(owner, env, approvalId, { checked: checklistFor() });
    fake.inject({ match: /PUT /, status: 500, body: `crash while using ${KEY}` });
    await stageDraft(owner, env, draftId).catch(() => undefined);
    const everything = JSON.stringify([failed, await getDraft(owner, env, draftId), await owner.data.audit.list(500), await owner.data.platformDrafts.listAttempts(draftId), await listConnections(owner)]);
    expect(everything).not.toContain(KEY);
  });
});
