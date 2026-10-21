import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DraftPayload } from '../src/lib/publishing';
import { forOwner, NotFoundError, PublishRefusal } from '../src/server/data/tenant';
import type { DbHandle } from '../src/server/db/client';
import { users } from '../src/server/db/schema';
import { payloadHashOf, sourceHashOf } from '../src/server/publishing/source';
import { memoryDb } from './helpers';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
let handle: DbHandle;

const a = () => forOwner(A, handle.db);
const b = () => forOwner(B, handle.db);

const payloadFor = (title: string): DraftPayload => ({
  title,
  description: 'About the thing',
  tags: ['go'],
  canonicalUrl: 'https://example-blog.dev/posts/thing',
  coverImageUrl: null,
  series: null,
  bodyMarkdown: `# ${title}\n\nBody.`,
});

/** An owner with a connected DEV.to connection, an article and a staged draft waiting for approval. */
async function stagedDraft(owner: typeof a, title: string, opts: { payloadTitle?: string } = {}) {
  const article = await owner().articles.create({ title, slug: `slug-${randomUUID().slice(0, 8)}`, bodyMarkdown: `# ${title}\n\nBody.` });
  const existing = await owner().connections.getByPlatform('devto');
  const connection =
    existing ??
    (await owner().connections.save({ id: randomUUID(), platform: 'devto', encryptedKey: 'v1.x.y.z', keyLast4: 'abcd', status: 'connected', who: '@someone', config: {}, message: null }));
  const payload = payloadFor(opts.payloadTitle ?? title);
  const hash = payloadHashOf('devto', '@someone', payload);
  const draft = await owner().platformDrafts.create({
    articleId: article.id,
    platform: 'devto',
    connectionId: connection.id,
    account: '@someone',
    payload,
    payloadSha256: hash,
    tagReport: { original: ['go'], sent: ['go'], changes: [] },
    lint: [],
    sourceRevision: article.revision,
    sourceHash: sourceHashOf(article),
  });
  const staged = await owner().platformDrafts.markStaged(draft.id, hash, { remoteId: '1001', previewUrl: 'https://dev.to/x/preview' });
  expect(staged?.status).toBe('staged');
  return { article, draft: staged!, hash, connection };
}

const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000);

async function approvalFor(owner: typeof a, draftId: string, hash: string, expiresAt = inMinutes(30)) {
  const approval = await owner().platformDrafts.openApproval(draftId, { tag: '#ABCDEF01', expiresAt, requestedBy: 'owner', expectedHash: hash });
  expect(approval).not.toBeNull();
  return approval!;
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

describe('tenant isolation of publishing data', () => {
  it('keeps connections, drafts, approvals and attempts apart', async () => {
    const { draft, hash, connection } = await stagedDraft(a, 'Isolation');
    const approval = await approvalFor(a, draft.id, hash);
    const attempt = await a().platformDrafts.startAttempt(draft.id, 'stage', hash);

    expect(await b().connections.get(connection.id)).toBeNull();
    expect(await b().connections.getWithKey(connection.id)).toBeNull();
    expect(await b().connections.list()).toEqual([]);
    expect(await b().connections.remove(connection.id)).toBe(false);
    await expect(b().connections.recordCheck(connection.id, { status: 'error', message: 'x' })).rejects.toBeInstanceOf(NotFoundError);

    expect(await b().platformDrafts.get(draft.id)).toBeNull();
    expect(await b().platformDrafts.list()).toEqual([]);
    expect(await b().platformDrafts.getApproval(approval.id)).toBeNull();
    expect(await b().platformDrafts.listAttempts(draft.id)).toEqual([]);
    expect(await b().platformDrafts.markStaged(draft.id, hash, { remoteId: '9', previewUrl: null })).toBeNull();
    expect(await b().platformDrafts.deny(approval.id)).toBeNull();
    expect(await b().platformDrafts.openApproval(draft.id, { tag: '#X', expiresAt: inMinutes(5), requestedBy: 'owner', expectedHash: hash })).toBeNull();
    await expect(b().platformDrafts.authorizePublish({ draftId: draft.id, approvalId: approval.id, checked: [], now: new Date() })).rejects.toBeInstanceOf(PublishRefusal);

    // Nothing of A's changed.
    const still = await a().platformDrafts.get(draft.id);
    expect(still?.status).toBe('pending_approval');
    expect((await a().platformDrafts.getApproval(approval.id))?.status).toBe('pending');
    expect(attempt.ownerId).toBe(A);
  });

  it('refuses a draft for an article that belongs to someone else', async () => {
    const mine = await a().articles.create({ title: 'Mine', slug: 'mine-only' });
    await expect(
      b().platformDrafts.create({
        articleId: mine.id,
        platform: 'devto',
        connectionId: null,
        account: null,
        payload: payloadFor('x'),
        payloadSha256: 'f'.repeat(64),
        tagReport: { original: [], sent: [], changes: [] },
        lint: [],
        sourceRevision: 1,
        sourceHash: 'h',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('keeps one connection per platform and replaces its key when saved again', async () => {
    const first = await b().connections.save({ id: randomUUID(), platform: 'hashnode', encryptedKey: 'v1.a.b.c', keyLast4: '1111', status: 'connected', who: '@one', config: { publicationId: 'p1' }, message: null });
    const second = await b().connections.save({ id: randomUUID(), platform: 'hashnode', encryptedKey: 'v1.d.e.f', keyLast4: '2222', status: 'connected', who: '@two', config: { publicationId: 'p2' }, message: null });
    expect(second.id).toBe(first.id);
    expect(second.keyLast4).toBe('2222');
    expect((await b().connections.list()).filter((c) => c.platform === 'hashnode')).toHaveLength(1);
    const withKey = await b().connections.getWithKey(first.id);
    expect(withKey?.encryptedKey).toBe('v1.d.e.f');
    // The listing shape never carries the encrypted key.
    expect(Object.keys((await b().connections.list())[0]!)).not.toContain('encryptedKey');
  });
});

describe('authorizing a publish', () => {
  it('consumes the approval and marks the draft publishing together, once', async () => {
    const { draft, hash } = await stagedDraft(a, 'Single use');
    const approval = await approvalFor(a, draft.id, hash);
    const first = await a().platformDrafts.authorizePublish({ draftId: draft.id, approvalId: approval.id, checked: ['ok'], now: new Date() });
    expect(first.draft.status).toBe('publishing');
    expect(first.approval.status).toBe('used');
    expect(first.approval.checked).toEqual(['ok']);
    expect(first.attempt).toMatchObject({ kind: 'publish', status: 'started', approvalId: approval.id });

    await expect(a().platformDrafts.authorizePublish({ draftId: draft.id, approvalId: approval.id, checked: [], now: new Date() })).rejects.toMatchObject({ code: 'ALREADY_OUT' });
  });

  it('lets exactly one of two concurrent authorizations through', async () => {
    const { draft, hash } = await stagedDraft(a, 'Concurrent');
    const approval = await approvalFor(a, draft.id, hash);
    const run = () => a().platformDrafts.authorizePublish({ draftId: draft.id, approvalId: approval.id, checked: [], now: new Date() });
    const results = await Promise.allSettled([run(), run(), run()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(2);
    const attempts = (await a().platformDrafts.listAttempts(draft.id)).filter((x) => x.kind === 'publish');
    expect(attempts).toHaveLength(1);
  });

  it('refuses an expired approval', async () => {
    const { draft, hash } = await stagedDraft(a, 'Expired');
    const approval = await approvalFor(a, draft.id, hash, inMinutes(30));
    await expect(a().platformDrafts.authorizePublish({ draftId: draft.id, approvalId: approval.id, checked: [], now: inMinutes(31) })).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
    expect((await a().platformDrafts.get(draft.id))?.status).toBe('pending_approval');
  });

  it('voids the approval when the draft is rebuilt with a different payload', async () => {
    const { article, draft, hash } = await stagedDraft(a, 'Rebuilt');
    const approval = await approvalFor(a, draft.id, hash);
    const payload = payloadFor('Rebuilt, edited');
    const rebuilt = await a().platformDrafts.rebuild(draft.id, {
      connectionId: draft.connectionId,
      account: draft.account,
      payload,
      payloadSha256: payloadHashOf('devto', draft.account, payload),
      tagReport: draft.tagReport,
      lint: [],
      sourceRevision: article.revision,
      sourceHash: draft.sourceHash,
    });
    expect(rebuilt?.status).toBe('draft');
    expect(rebuilt?.remoteId).toBe('1001');
    expect((await a().platformDrafts.getApproval(approval.id))?.status).toBe('invalidated');
    await expect(a().platformDrafts.authorizePublish({ draftId: draft.id, approvalId: approval.id, checked: [], now: new Date() })).rejects.toBeInstanceOf(PublishRefusal);
  });

  it('flags the draft and voids the approval when the article is edited, and refuses to publish', async () => {
    const { article, draft, hash } = await stagedDraft(a, 'Edited later');
    const approval = await approvalFor(a, draft.id, hash);
    await a().articles.save(article.id, article.revision, { bodyMarkdown: 'Changed after approval.' }, 'manual');
    const changed = await a().platformDrafts.syncSource(article.id);
    expect(changed.map((d) => d.id)).toEqual([draft.id]);
    const after = await a().platformDrafts.get(draft.id);
    expect(after).toMatchObject({ status: 'source_changed', stale: true });
    expect((await a().platformDrafts.getApproval(approval.id))?.status).toBe('invalidated');
    await expect(a().platformDrafts.authorizePublish({ draftId: draft.id, approvalId: approval.id, checked: [], now: new Date() })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  });

  it('refuses at authorization time even if nobody synced the edit', async () => {
    const { article, draft, hash } = await stagedDraft(a, 'Unsynced');
    const approval = await approvalFor(a, draft.id, hash);
    await a().articles.save(article.id, article.revision, { title: 'A new title' }, 'manual');
    await expect(a().platformDrafts.authorizePublish({ draftId: draft.id, approvalId: approval.id, checked: [], now: new Date() })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    // The refusal rolled back: the approval is still unspent.
    expect((await a().platformDrafts.getApproval(approval.id))?.status).toBe('pending');
  });

  it('refuses when the connection is not healthy', async () => {
    const { draft, hash, connection } = await stagedDraft(a, 'Unhealthy');
    const approval = await approvalFor(a, draft.id, hash);
    await a().connections.recordCheck(connection.id, { status: 'needs_reconnect', message: 'The key was refused.' });
    await expect(a().platformDrafts.authorizePublish({ draftId: draft.id, approvalId: approval.id, checked: [], now: new Date() })).rejects.toMatchObject({ code: 'UNHEALTHY' });
    await a().connections.recordCheck(connection.id, { status: 'connected', message: null });
  });

  it('never lets a second draft with the same payload be published', async () => {
    const one = await stagedDraft(a, 'Same payload one', { payloadTitle: 'Identical payload' });
    const two = await stagedDraft(a, 'Same payload two', { payloadTitle: 'Identical payload' });
    expect(one.hash).toBe(two.hash);
    const approvalOne = await approvalFor(a, one.draft.id, one.hash);
    const approvalTwo = await approvalFor(a, two.draft.id, two.hash);
    await a().platformDrafts.authorizePublish({ draftId: one.draft.id, approvalId: approvalOne.id, checked: [], now: new Date() });
    await expect(a().platformDrafts.authorizePublish({ draftId: two.draft.id, approvalId: approvalTwo.id, checked: [], now: new Date() })).rejects.toMatchObject({ code: 'DUPLICATE' });
    // Rolled back whole: the second approval is unspent and the second draft untouched.
    expect((await a().platformDrafts.getApproval(approvalTwo.id))?.status).toBe('pending');
    expect((await a().platformDrafts.get(two.draft.id))?.status).toBe('pending_approval');
  });

  it('allows the same payload for another owner', async () => {
    const mine = await stagedDraft(a, 'Shared payload', { payloadTitle: 'Cross owner payload' });
    const theirs = await stagedDraft(b, 'Shared payload', { payloadTitle: 'Cross owner payload' });
    const ma = await approvalFor(a, mine.draft.id, mine.hash);
    const mb = await approvalFor(b, theirs.draft.id, theirs.hash);
    await a().platformDrafts.authorizePublish({ draftId: mine.draft.id, approvalId: ma.id, checked: [], now: new Date() });
    await expect(b().platformDrafts.authorizePublish({ draftId: theirs.draft.id, approvalId: mb.id, checked: [], now: new Date() })).resolves.toBeDefined();
  });

  it('requires a staged remote copy', async () => {
    const article = await a().articles.create({ title: 'Never staged', slug: 'never-staged' });
    const connection = (await a().connections.getByPlatform('devto'))!;
    const payload = payloadFor('Never staged');
    const hash = payloadHashOf('devto', '@someone', payload);
    const draft = await a().platformDrafts.create({
      articleId: article.id,
      platform: 'devto',
      connectionId: connection.id,
      account: '@someone',
      payload,
      payloadSha256: hash,
      tagReport: { original: [], sent: [], changes: [] },
      lint: [],
      sourceRevision: article.revision,
      sourceHash: sourceHashOf(article),
    });
    // A draft that was never staged cannot even open an approval.
    expect(await a().platformDrafts.openApproval(draft.id, { tag: '#T', expiresAt: inMinutes(5), requestedBy: 'owner', expectedHash: hash })).toBeNull();
  });
});

describe('late answers and recovery', () => {
  it('a stage failure arriving after publishing started cannot flip the draft', async () => {
    const { draft, hash } = await stagedDraft(a, 'Late failure');
    const approval = await approvalFor(a, draft.id, hash);
    await a().platformDrafts.authorizePublish({ draftId: draft.id, approvalId: approval.id, checked: [], now: new Date() });
    expect(await a().platformDrafts.markStageFailed(draft.id, hash, { kind: 'server', message: 'late', nextAction: null })).toBeNull();
    expect(await a().platformDrafts.markStaged(draft.id, hash, { remoteId: '5', previewUrl: null })).toBeNull();
    expect((await a().platformDrafts.get(draft.id))?.status).toBe('publishing');
  });

  it('a stage failure cannot flip a published or pending draft either', async () => {
    const one = await stagedDraft(a, 'Late failure published');
    const approval = await approvalFor(a, one.draft.id, one.hash);
    const auth = await a().platformDrafts.authorizePublish({ draftId: one.draft.id, approvalId: approval.id, checked: [], now: new Date() });
    await a().platformDrafts.settlePublish(one.draft.id, auth.attempt.id, { status: 'published', remoteId: '1001', remoteUrl: 'https://dev.to/x/live', httpStatus: 200, now: new Date() });
    expect(await a().platformDrafts.markStageFailed(one.draft.id, one.hash, { kind: 'server', message: 'late', nextAction: null })).toBeNull();
    expect((await a().platformDrafts.get(one.draft.id))?.status).toBe('published');

    const two = await stagedDraft(a, 'Late failure pending');
    await approvalFor(a, two.draft.id, two.hash);
    expect(await a().platformDrafts.markStageFailed(two.draft.id, two.hash, { kind: 'server', message: 'late', nextAction: null })).toBeNull();
    expect((await a().platformDrafts.get(two.draft.id))?.status).toBe('pending_approval');
  });

  it('a publish that ends in failed or unknown is recorded once and never silently re-approvable', async () => {
    const { draft, hash } = await stagedDraft(a, 'Went unknown');
    const approval = await approvalFor(a, draft.id, hash);
    const auth = await a().platformDrafts.authorizePublish({ draftId: draft.id, approvalId: approval.id, checked: [], now: new Date() });
    const settled = await a().platformDrafts.settlePublish(draft.id, auth.attempt.id, {
      status: 'unknown',
      failure: { kind: 'timeout', message: 'No answer in 30 seconds', nextAction: 'Check on platform' },
      httpStatus: null,
      now: new Date(),
    });
    expect(settled?.status).toBe('unknown');
    // Neither a new approval nor an authorization can start from unknown.
    expect(await a().platformDrafts.openApproval(draft.id, { tag: '#U', expiresAt: inMinutes(5), requestedBy: 'owner', expectedHash: hash })).toBeNull();
    await expect(a().platformDrafts.authorizePublish({ draftId: draft.id, approvalId: approval.id, checked: [], now: new Date() })).rejects.toMatchObject({ code: 'ALREADY_OUT' });
    // A second settle (a duplicate callback) changes nothing.
    expect(await a().platformDrafts.settlePublish(draft.id, auth.attempt.id, { status: 'failed', failure: { kind: 'server', message: 'x', nextAction: null }, httpStatus: 500, now: new Date() })).toBeNull();
    expect((await a().platformDrafts.get(draft.id))?.status).toBe('unknown');
  });

  it('resolves unknown only by an explicit resolution, and only from unknown', async () => {
    const { draft, hash } = await stagedDraft(a, 'Resolve me');
    const approval = await approvalFor(a, draft.id, hash);
    const auth = await a().platformDrafts.authorizePublish({ draftId: draft.id, approvalId: approval.id, checked: [], now: new Date() });
    expect(await a().platformDrafts.resolveUnknown(draft.id, { outcome: 'not_published' }, { kind: 'check', message: 'x', now: new Date() })).toBeNull();
    await a().platformDrafts.settlePublish(draft.id, auth.attempt.id, { status: 'unknown', failure: { kind: 'network', message: 'dropped', nextAction: null }, httpStatus: null, now: new Date() });
    const resolved = await a().platformDrafts.resolveUnknown(draft.id, { outcome: 'published', remoteId: '1001', remoteUrl: 'https://dev.to/x/live' }, { kind: 'check', message: 'Found live.', now: new Date() });
    expect(resolved).toMatchObject({ status: 'published', remoteUrl: 'https://dev.to/x/live' });
    const article = await a().articles.get(resolved!.articleId);
    expect(article?.publishedAt).not.toBeNull();
  });

  it('turns a publish that never answered into unknown, not failed', async () => {
    const { draft, hash } = await stagedDraft(a, 'Crashed mid publish');
    const approval = await approvalFor(a, draft.id, hash);
    await a().platformDrafts.authorizePublish({ draftId: draft.id, approvalId: approval.id, checked: [], now: new Date() });
    expect(await a().platformDrafts.sweepStalePublishing(new Date())).toHaveLength(0);
    const swept = await a().platformDrafts.sweepStalePublishing(inMinutes(10));
    expect(swept.map((d) => d.id)).toContain(draft.id);
    expect((await a().platformDrafts.get(draft.id))?.status).toBe('unknown');
  });

  it('denying returns the draft to staged and spends nothing', async () => {
    const { draft, hash } = await stagedDraft(a, 'Denied');
    const approval = await approvalFor(a, draft.id, hash);
    expect((await a().platformDrafts.deny(approval.id))?.status).toBe('denied');
    expect((await a().platformDrafts.get(draft.id))?.status).toBe('staged');
    expect(await a().platformDrafts.deny(approval.id)).toBeNull();
    await expect(a().platformDrafts.authorizePublish({ draftId: draft.id, approvalId: approval.id, checked: [], now: new Date() })).rejects.toBeInstanceOf(PublishRefusal);
  });

  it('a newer approval request voids the older one', async () => {
    const { draft, hash } = await stagedDraft(a, 'Two requests');
    const first = await approvalFor(a, draft.id, hash);
    const second = await approvalFor(a, draft.id, hash);
    expect((await a().platformDrafts.getApproval(first.id))?.status).toBe('invalidated');
    await expect(a().platformDrafts.authorizePublish({ draftId: draft.id, approvalId: first.id, checked: [], now: new Date() })).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    await expect(a().platformDrafts.authorizePublish({ draftId: draft.id, approvalId: second.id, checked: [], now: new Date() })).resolves.toBeDefined();
  });
});
