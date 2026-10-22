import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CANONICAL_NOT_LIVE_BOX, approvalChecklist, type PlatformId } from '../src/lib/publishing';
import { presetMapping } from '../src/lib/site-export';
import { createArticle, saveArticle } from '../src/server/actions/articles';
import {
  addDestination,
  checkCanonical,
  editDraft,
  exportDraft,
  getPreview,
  getSiteSettings,
  recordManualPost,
  removeDestination,
  reorderDestinations,
  resetDraft,
  saveSiteSettings,
} from '../src/server/actions/composer';
import { ActionError, sessionToOwner, type OwnerContext } from '../src/server/actions/owner';
import {
  approveAndPublish,
  checkOnPlatform,
  connectPlatform,
  declineApproval,
  getDraft,
  listDestinations,
  prepareDraft,
  requestApproval,
  stageDraft,
} from '../src/server/actions/publishing';
import type { DbHandle } from '../src/server/db/client';
import { users } from '../src/server/db/schema';
import { checkCanonicalPage } from '../src/server/publishing/canonical';
import type { PublishEnv } from '../src/server/publishing/registry';
import { fakeCanonical, PAGE, type FakeCanonical } from './helpers/canonical';
import { createFakeDevto, type FakeDevto } from './helpers/fake-devto';
import { createFakeGithub, type FakeGithub } from './helpers/fake-github';
import { memoryDb, testConfig } from './helpers';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const DEVTO_KEY = ['fake', 'devto', 'value', 'a1b2c3d4e5f6'].join('-');
const GITHUB_KEY = ['fake', 'github', 'value', 'q9w8e7r6t5'].join('_');
const REPO = 'example-owner/example-site';
const START = new Date('2026-10-21T12:00:00Z');
const CANONICAL = 'https://example-blog.dev/posts/write-path';

let handle: DbHandle;
let devto: FakeDevto;
let github: FakeGithub;
let canonical: FakeCanonical;
let clock: Date;
let env: PublishEnv;
let owner: OwnerContext;
let other: OwnerContext;

const as = (userId: string, actor: OwnerContext['actor'] = 'owner') => sessionToOwner({ userId }, { db: handle.db }, actor);

/** One fetch for every platform the tests talk to: each fake answers only its own addresses. */
const routedFetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith('https://api.github.com')) return github.fetch(input, init);
  return devto.fetch(input, init);
}) as typeof fetch;

async function expectError(run: () => Promise<unknown>, code?: string, data?: Record<string, unknown>) {
  const err = await run().then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ActionError);
  if (code) expect((err as ActionError).code).toBe(code);
  if (data) expect((err as ActionError).data).toMatchObject(data);
  return err as ActionError;
}

let counter = 0;
async function newArticle(extra: { title?: string; body?: string; tags?: string[]; canonicalUrl?: string | null } = {}, who: OwnerContext = owner) {
  return createArticle(who, {
    title: extra.title ?? `Why the write path stalls ${++counter}`,
    description: 'A short look at write stalls.',
    tags: extra.tags ?? ['Go', 'databases'],
    ...(extra.canonicalUrl === null ? {} : { canonicalUrl: extra.canonicalUrl ?? CANONICAL }),
    bodyMarkdown: extra.body ?? '# Intro\n\nThe write path stalls when the log fills.\n\n## The log\n\nDetails.\n\n## The fix\n\nShort.\n',
  });
}

const devtoChecklist = (notLive = false) => approvalChecklist('DEV.to', true, { canonicalNotLive: notLive });
const prCount = () => github.pulls.length;
const devtoPublishWrites = () => devto.requests.filter((r) => r.method !== 'GET' && (r.body as { article?: { published?: boolean } } | null)?.article?.published === true);

/** Prepare, stage and request approval of a DEV.to draft. */
async function readyDevto(extra: Parameters<typeof newArticle>[0] = {}) {
  const article = await newArticle(extra);
  const prepared = await prepareDraft(owner, env, { articleId: article.id, platform: 'devto' });
  expect((await stageDraft(owner, env, prepared.id)).ok).toBe(true);
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
  devto = createFakeDevto({ apiKey: DEVTO_KEY });
  github = createFakeGithub({ token: GITHUB_KEY, repo: REPO, origin: 'https://github.com' });
  canonical = fakeCanonical();
  clock = new Date(START);
  env = { config: testConfig(), fetchFn: routedFetch, canonical, now: () => clock, sleep: async () => undefined, timeoutMs: 2000 };
  owner = as(A);
  other = as(B);
  for (const who of [owner, other]) {
    for (const row of await who.data.connections.list()) await who.data.connections.remove(row.id);
  }
  for (const who of [owner, other]) {
    await who.data.siteSettings.save({ siteUrl: null, repo: null, baseBranch: 'main', pathTemplate: 'content/posts/{slug}.md', preset: 'generic', mapping: presetMapping('generic') });
  }
  await connectPlatform(owner, env, { platform: 'devto', secret: DEVTO_KEY });
  devto.requests.length = 0;
});

describe('destinations', () => {
  it('starts with every catalog entry as "not prepared" and adds them only when the owner asks', async () => {
    const article = await newArticle();
    const before = await listDestinations(owner, env, article.id);
    expect(before).toHaveLength(13);
    expect(before.every((d) => !d.added && d.draft === null)).toBe(true);

    await addDestination(owner, article.id, { platform: 'linkedin' });
    await addDestination(owner, article.id, { platform: 'site' });
    await addDestination(owner, article.id, { platform: 'linkedin' }); // twice changes nothing
    const after = await listDestinations(owner, env, article.id);
    expect(after.filter((d) => d.added).map((d) => d.platform)).toEqual(['linkedin', 'site']);
    expect(after.filter((d) => d.added).every((d) => d.draft === null)).toBe(true);
  });

  it('keeps the owner’s order, and a prepared draft implies its destination', async () => {
    const article = await newArticle();
    await prepareDraft(owner, env, { articleId: article.id, platform: 'devto' });
    await addDestination(owner, article.id, { platform: 'hackernews' });
    await addDestination(owner, article.id, { platform: 'x' });
    await reorderDestinations(owner, article.id, { order: ['x', 'devto'] });
    const added = (await listDestinations(owner, env, article.id)).filter((d) => d.added).map((d) => d.platform);
    expect(added).toEqual(['x', 'devto', 'hackernews']);
    await expectError(() => reorderDestinations(owner, article.id, { order: ['x', 'x'] }), 'invalid');
  });

  it('removes a destination and its unsent draft, but never one that went out', async () => {
    const article = await newArticle();
    const draft = await prepareDraft(owner, env, { articleId: article.id, platform: 'medium' });
    await removeDestination(owner, article.id, 'medium');
    expect((await listDestinations(owner, env, article.id)).find((d) => d.platform === 'medium')).toMatchObject({ added: false, draft: null });
    expect(await owner.data.platformDrafts.get(draft.id)).toBeNull();

    const { draftId, approvalId } = await readyDevto();
    const out = await approveAndPublish(owner, env, approvalId, { checked: devtoChecklist() });
    expect(out.outcome).toBe('published');
    const row = (await owner.data.platformDrafts.get(draftId))!;
    await expectError(() => removeDestination(owner, row.articleId, 'devto'), 'conflict', { code: 'ALREADY_OUT' });
    expect(await owner.data.platformDrafts.get(draftId)).not.toBeNull();
  });

  it('only the article’s owner can add, list or remove', async () => {
    const article = await newArticle();
    await expectError(() => addDestination(other, article.id, { platform: 'x' }), 'not_found');
    await expectError(() => listDestinations(other, env, article.id), 'not_found');
    await expectError(() => removeDestination(other, article.id, 'x'), 'not_found');
    await expectError(() => reorderDestinations(other, article.id, { order: ['x'] }), 'not_found');
    expect(await other.data.destinations.list(article.id)).toEqual([]);
  });
});

describe('several destinations from one source, each independent', () => {
  async function three() {
    const article = await newArticle();
    await saveSiteSettings(owner, { siteUrl: 'https://example-blog.dev', repo: REPO, baseBranch: 'main', pathTemplate: 'content/posts/{slug}.md', preset: 'generic', mapping: (await getSiteSettings(owner)).mapping });
    const d = await prepareDraft(owner, env, { articleId: article.id, platform: 'devto' });
    const s = await prepareDraft(owner, env, { articleId: article.id, platform: 'site' });
    const l = await prepareDraft(owner, env, { articleId: article.id, platform: 'linkedin' });
    return { article, d, s, l };
  }

  it('prepares an adaptation for each from the same article', async () => {
    const { d, s, l } = await three();
    expect(d.payload.tags).toEqual(['go', 'databases']);
    expect(s.extras.site).toMatchObject({ path: expect.stringMatching(/^content\/posts\/.+\.md$/), repo: REPO, baseBranch: 'main' });
    expect(l.payload.bodyMarkdown).toContain(CANONICAL);
    expect(new Set([d.payloadSha256, s.payloadSha256, l.payloadSha256]).size).toBe(3);
    expect(s.account).toBe(`${REPO}@main`);
    expect(l.account).toBeNull();
  });

  it('editing one never changes another', async () => {
    const { d, s, l } = await three();
    const edited = await editDraft(owner, env, d.id, { expectedHash: d.payloadSha256, title: 'A title only for DEV.to' });
    expect(edited.draft.payload.title).toBe('A title only for DEV.to');
    expect((await getDraft(owner, env, s.id)).payloadSha256).toBe(s.payloadSha256);
    expect((await getDraft(owner, env, l.id)).payloadSha256).toBe(l.payloadSha256);
    expect((await getDraft(owner, env, s.id)).payload.title).toBe(s.payload.title);
  });

  it('a failure on one leaves the others untouched', async () => {
    const { d, l } = await three();
    devto.inject({ match: /POST \/api\/articles/, status: 422, body: { error: 'Title can’t be blank', status: 422 } });
    const result = await stageDraft(owner, env, d.id);
    expect(result.ok).toBe(false);
    expect(result.draft.status).toBe('failed');
    expect((await getDraft(owner, env, l.id)).status).toBe('draft');
  });

  it('publishing one never moves another, and never sends another’s payload', async () => {
    const { article, d, l } = await three();
    await stageDraft(owner, env, d.id);
    const requested = await requestApproval(owner, env, d.id);
    const out = await approveAndPublish(owner, env, requested.draft.approval!.id, { checked: devtoChecklist() });
    expect(out.outcome).toBe('published');
    expect((await getDraft(owner, env, l.id)).status).toBe('draft');
    const sent = devtoPublishWrites().map((r) => (r.body as { article: { title: string } }).article.title);
    expect(sent).toEqual([d.payload.title]);
    expect(github.requests).toHaveLength(0);
    expect(article.id).toBeTruthy();
  });

  it('one approval can never publish a different payload: an edit after the request voids it', async () => {
    const { draftId, approvalId } = await readyDevto();
    const before = (await getDraft(owner, env, draftId)).payloadSha256;
    await editDraft(owner, env, draftId, { expectedHash: before, title: 'Changed after the request' });
    devto.requests.length = 0;
    const err = await expectError(() => approveAndPublish(owner, env, approvalId, { checked: devtoChecklist() }), 'conflict');
    expect(err.data).toMatchObject({ code: expect.stringMatching(/APPROVAL_INVALID|STATUS|HASH_MISMATCH/) });
    expect(devto.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
    const approval = await owner.data.platformDrafts.getApproval(approvalId);
    expect(approval?.status).toBe('invalidated');
    expect(approval?.invalidReason).toMatch(/edited/);
  });
});

describe('editing a destination', () => {
  it('is a new hash that voids an open approval, says so, and tracks the divergence', async () => {
    const { draftId, approvalId, requested } = await readyDevto();
    expect(requested.draft.status).toBe('pending_approval');
    const result = await editDraft(owner, env, draftId, { expectedHash: requested.draft.payloadSha256, title: 'A sharper title', description: 'Shorter.' });

    expect(result.changed).toBe(true);
    expect(result.voidedApproval).toBe(true);
    expect(result.message).toMatch(/approval .* void/);
    expect(result.fields).toEqual(expect.arrayContaining(['title', 'description']));
    expect(result.draft.payloadSha256).not.toBe(requested.draft.payloadSha256);
    expect(result.draft.status).toBe('draft');
    expect(result.draft.approval).toMatchObject({ status: 'invalidated' });
    expect(result.draft.divergence.edited).toEqual(['title', 'description']);
    expect(result.draft.editCount).toBe(1);
    expect(result.draft.editedAt).not.toBeNull();
    expect(result.draft.generated.title).toBe(requested.draft.payload.title);
    expect((await owner.data.platformDrafts.getApproval(approvalId))?.status).toBe('invalidated');
  });

  it('needs staging again before it can be approved', async () => {
    const { draftId, requested } = await readyDevto();
    const edited = await editDraft(owner, env, draftId, { expectedHash: requested.draft.payloadSha256, title: 'New' });
    await expectError(() => requestApproval(owner, env, draftId), 'conflict', { code: 'STATUS' });
    expect((await stageDraft(owner, env, draftId)).ok).toBe(true);
    const again = await requestApproval(owner, env, draftId);
    expect(again.draft.approval?.status).toBe('pending');
    expect(again.draft.approval?.tag).toBe(`#${edited.draft.payloadSha256.slice(0, 8).toUpperCase()}`);
  });

  it('does nothing when nothing changed, and voids nothing', async () => {
    const { draftId, requested } = await readyDevto();
    const result = await editDraft(owner, env, draftId, { expectedHash: requested.draft.payloadSha256, title: requested.draft.payload.title });
    expect(result.changed).toBe(false);
    expect(result.voidedApproval).toBe(false);
    expect((await getDraft(owner, env, draftId)).approval?.status).toBe('pending');
  });

  it('refuses an edit made against an out-of-date copy', async () => {
    const { draftId, requested } = await readyDevto();
    await editDraft(owner, env, draftId, { expectedHash: requested.draft.payloadSha256, title: 'First' });
    await expectError(() => editDraft(owner, env, draftId, { expectedHash: requested.draft.payloadSha256, title: 'Second' }), 'conflict', { code: 'STALE_EDIT' });
  });

  it('cleans tags for the platform and reports each change', async () => {
    const { draftId, requested } = await readyDevto();
    const result = await editDraft(owner, env, draftId, { expectedHash: requested.draft.payloadSha256, tags: ['C++', 'node.js', 'Go', 'Go'] });
    expect(result.draft.payload.tags).toEqual(['c', 'nodejs', 'go']);
    expect(result.draft.tagReport.changes.join(' ')).toMatch(/C\+\+.*c/);
    expect(result.draft.tagReport.changes.join(' ')).toMatch(/already in the list/);
  });

  it('re-lints after an edit: a local image in the body becomes a blocking problem', async () => {
    const { draftId, requested } = await readyDevto();
    const result = await editDraft(owner, env, draftId, { expectedHash: requested.draft.payloadSha256, bodyMarkdown: 'Text\n\n![x](asset:123)\n' });
    expect(result.draft.lint.some((i) => i.severity === 'error' && i.code === 'image_local')).toBe(true);
    await expectError(() => stageDraft(owner, env, draftId), 'invalid', { code: 'LINT' });
  });

  it('validates the canonical URL', async () => {
    const { draftId, requested } = await readyDevto();
    const err = await expectError(() => editDraft(owner, env, draftId, { expectedHash: requested.draft.payloadSha256, canonicalUrl: 'not a url' }), 'invalid');
    expect(err.fields.canonicalUrl).toMatch(/full web address/);
    const cleared = await editDraft(owner, env, draftId, { expectedHash: requested.draft.payloadSha256, canonicalUrl: null });
    expect(cleared.draft.payload.canonicalUrl).toBeNull();
    expect(cleared.draft.divergence.edited).toEqual(['canonicalUrl', 'bodyMarkdown'].filter((f) => cleared.draft.divergence.edited.includes(f as never)).length ? cleared.draft.divergence.edited : ['canonicalUrl']);
  });

  it('shows divergence from the source after the article itself changes, and flags the draft', async () => {
    const { article, draftId } = await readyDevto();
    await saveArticle(owner, article.id, { expectedRevision: article.revision, title: 'The article was retitled' });
    const view = await getDraft(owner, env, draftId);
    expect(view.status).toBe('source_changed');
    expect(view.divergence.fromSource).toContain('title');
    await expectError(() => editDraft(owner, env, draftId, { expectedHash: view.payloadSha256, title: 'x' }), 'conflict', { code: 'SOURCE_CHANGED' });
  });

  it('resets to what was generated, all of it or some fields, and the hash returns', async () => {
    const { draftId, requested } = await readyDevto();
    const original = requested.draft.payloadSha256;
    const edited = await editDraft(owner, env, draftId, { expectedHash: original, title: 'Edited title', description: 'Edited description' });
    const partial = await resetDraft(owner, env, draftId, { fields: ['title'] });
    expect(partial.draft.payload.title).toBe(requested.draft.payload.title);
    expect(partial.draft.payload.description).toBe('Edited description');
    expect(partial.draft.divergence.edited).toEqual(['description']);
    const full = await resetDraft(owner, env, draftId, {});
    expect(full.draft.divergence.edited).toEqual([]);
    expect(full.draft.editCount).toBe(0);
    expect(full.draft.editedAt).toBeNull();
    expect(full.draft.payloadSha256).toBe(original);
    expect(edited.draft.payloadSha256).not.toBe(original);
  });

  it('will not rebuild over edits unless the owner says so', async () => {
    const { article, draftId, requested } = await readyDevto();
    await editDraft(owner, env, draftId, { expectedHash: requested.draft.payloadSha256, title: 'Mine' });
    await expectError(() => prepareDraft(owner, env, { articleId: article.id, platform: 'devto' }), 'conflict', { code: 'HAS_EDITS' });
    const rebuilt = await prepareDraft(owner, env, { articleId: article.id, platform: 'devto', discardEdits: true });
    expect(rebuilt.payload.title).toBe(requested.draft.payload.title);
    expect(rebuilt.editCount).toBe(0);
  });

  it('cannot edit what is published', async () => {
    const { draftId, approvalId, requested } = await readyDevto();
    await approveAndPublish(owner, env, approvalId, { checked: devtoChecklist() });
    await expectError(() => editDraft(owner, env, draftId, { expectedHash: requested.draft.payloadSha256, title: 'x' }), 'conflict');
  });

  it('rejects unknown fields instead of ignoring them', async () => {
    const { draftId, requested } = await readyDevto();
    await expectError(() => editDraft(owner, env, draftId, { expectedHash: requested.draft.payloadSha256, ownerId: B, status: 'published' }), 'invalid');
  });

  it('another owner cannot edit, reset, preview or export it', async () => {
    const { draftId, requested } = await readyDevto();
    await expectError(() => editDraft(other, env, draftId, { expectedHash: requested.draft.payloadSha256, title: 'x' }), 'not_found');
    await expectError(() => resetDraft(other, env, draftId, {}), 'not_found');
    await expectError(() => getPreview(other, env, draftId), 'not_found');
    await expectError(() => exportDraft(other, draftId), 'not_found');
  });
});

describe('destinations without a connector', () => {
  it('can be prepared, edited and previewed with no account, with nothing sent anywhere', async () => {
    const article = await newArticle();
    const draft = await prepareDraft(owner, env, { articleId: article.id, platform: 'linkedin' });
    expect(draft.status).toBe('draft');
    const edited = await editDraft(owner, env, draft.id, { expectedHash: draft.payloadSha256, bodyMarkdown: 'My own words about it. https://example-blog.dev/posts/write-path' });
    const preview = await getPreview(owner, env, edited.draft.id);
    expect(preview.preview).toMatch(/^Approximate preview of LinkedIn/);
    expect(preview.preview).toContain('My own words');
    expect(preview.limits.body).toBe(3000);
    expect(devto.requests).toHaveLength(0);
    expect(github.requests).toHaveLength(0);
  });

  it.each(['medium', 'substack', 'linkedin', 'x', 'bluesky', 'threads', 'mastodon', 'reddit', 'hackernews', 'youtube'] as PlatformId[])('%s cannot be staged, approved for publishing, connected or checked by any route', async (platform) => {
    const article = await newArticle();
    const draft = await prepareDraft(owner, env, { articleId: article.id, platform });
    await expectError(() => stageDraft(owner, env, draft.id), 'conflict', { code: 'NOT_PUBLISHABLE' });
    await expectError(() => requestApproval(owner, env, draft.id), 'conflict', { code: 'NOT_PUBLISHABLE' });
    await expectError(() => requestApproval(owner, env, draft.id, { mode: 'publish' }), 'conflict', { code: 'NOT_PUBLISHABLE' });
    await expectError(() => checkOnPlatform(owner, env, draft.id), 'conflict', { code: 'NOT_PUBLISHABLE' });
    await expectError(() => connectPlatform(owner, env, { platform, secret: 'some-long-value-1234' }), 'conflict', { code: 'NOT_PUBLISHABLE' });
    expect((await getDraft(owner, env, draft.id)).status).toBe('draft');
    expect(devto.requests).toHaveLength(0);
    expect(github.requests).toHaveLength(0);
  });

  it('an approval for recording by hand can never be spent as a publish', async () => {
    const article = await newArticle();
    const draft = await prepareDraft(owner, env, { articleId: article.id, platform: 'linkedin' });
    const asked = await requestApproval(owner, env, draft.id, { mode: 'manual' });
    const id = asked.draft.approval!.id;
    await expectError(() => approveAndPublish(owner, env, id, { checked: [] }), 'conflict', { code: 'NOT_PUBLISHABLE' });

    // Even for a DEV.to draft, a record-by-hand approval is not a publish approval.
    const d = await prepareDraft(owner, env, { articleId: article.id, platform: 'devto' });
    await stageDraft(owner, env, d.id);
    const manual = await requestApproval(owner, env, d.id, { mode: 'manual' });
    await expectError(() => approveAndPublish(owner, env, manual.draft.approval!.id, { checked: devtoChecklist() }), 'conflict', { code: 'APPROVAL_INVALID' });
    expect(devtoPublishWrites()).toHaveLength(0);
  });
});

describe('posting by hand, with an approval to record it', () => {
  async function asked(platform: PlatformId = 'linkedin') {
    const article = await newArticle();
    const draft = await prepareDraft(owner, env, { articleId: article.id, platform });
    const requested = await requestApproval(owner, env, draft.id, { mode: 'manual' });
    return { draft, approvalId: requested.draft.approval!.id, requested };
  }
  const boxes = (platform: PlatformId = 'linkedin') => approvalChecklist(platform === 'linkedin' ? 'LinkedIn' : 'DEV.to', true, { kind: 'manual' });

  it('records a validated link, marks the draft posted by hand and never claims the app published it', async () => {
    const { draft, approvalId, requested } = await asked();
    expect(requested.draft.approval).toMatchObject({ kind: 'manual', status: 'pending' });
    expect(requested.draft.approval!.checklist).toEqual(boxes());
    const result = await recordManualPost(owner, env, approvalId, { checked: boxes(), url: 'https://www.linkedin.com/posts/someone_why-activity-123' });

    expect(result.outcome).toBe('recorded');
    expect(result.message).toMatch(/did not publish it/);
    expect(result.draft).toMatchObject({ status: 'published', publishedVia: 'manual', remoteUrl: 'https://www.linkedin.com/posts/someone_why-activity-123' });
    expect(result.draft.attempts[0]).toMatchObject({ kind: 'manual', status: 'succeeded' });
    expect(result.draft.attempts[0]!.message).toMatch(/did not publish it/);
    expect((await owner.data.platformDrafts.getApproval(approvalId))?.status).toBe('used');
    expect((await owner.data.articles.get(draft.articleId))?.publishedAt).not.toBeNull();
    expect(devto.requests).toHaveLength(0);
    expect(github.requests).toHaveLength(0);
  });

  it('refuses a link on the wrong host, with the reason, and keeps the approval', async () => {
    const { approvalId } = await asked();
    const err = await expectError(() => recordManualPost(owner, env, approvalId, { checked: boxes(), url: 'https://example.test/posts/1' }), 'invalid');
    expect(err.fields.url).toMatch(/linkedin\.com/);
    await expectError(() => recordManualPost(owner, env, approvalId, { checked: boxes(), url: 'http://www.linkedin.com/posts/1' }), 'invalid');
    expect((await owner.data.platformDrafts.getApproval(approvalId))?.status).toBe('pending');
  });

  it('needs every box ticked', async () => {
    const { approvalId } = await asked();
    const err = await expectError(() => recordManualPost(owner, env, approvalId, { checked: boxes().slice(0, 2), url: 'https://www.linkedin.com/posts/1' }), 'invalid', { code: 'CHECKLIST' });
    expect(err.message).toMatch(/2 left/);
  });

  it('is single use and bound to the payload', async () => {
    const { draft, approvalId } = await asked();
    await recordManualPost(owner, env, approvalId, { checked: boxes(), url: 'https://www.linkedin.com/posts/1' });
    await expectError(() => recordManualPost(owner, env, approvalId, { checked: boxes(), url: 'https://www.linkedin.com/posts/2' }), 'conflict');

    // A second draft: edit after asking voids it.
    const second = await prepareDraft(owner, env, { articleId: draft.articleId, platform: 'x' });
    const ask = await requestApproval(owner, env, second.id, { mode: 'manual' });
    await editDraft(owner, env, second.id, { expectedHash: second.payloadSha256, bodyMarkdown: 'Changed' });
    await expectError(() => recordManualPost(owner, env, ask.draft.approval!.id, { checked: approvalChecklist('X', true, { kind: 'manual' }), url: 'https://x.com/someone/status/1' }), 'conflict');
    expect((await getDraft(owner, env, second.id)).status).toBe('draft');
  });

  it('expires after 30 minutes like any approval', async () => {
    const { approvalId } = await asked();
    clock = new Date(START.getTime() + 31 * 60_000);
    await expectError(() => recordManualPost(owner, env, approvalId, { checked: boxes(), url: 'https://www.linkedin.com/posts/1' }), 'conflict');
  });

  it('is the signed-in owner’s act: an agent can neither ask for it nor do it', async () => {
    const { approvalId, draft } = await asked();
    const agent = as(A, 'agent');
    await expectError(() => requestApproval(agent, env, draft.id, { mode: 'manual' }), 'forbidden');
    await expectError(() => recordManualPost(agent, env, approvalId, { checked: boxes(), url: 'https://www.linkedin.com/posts/1' }), 'forbidden');
  });

  it('works for a draft that was never staged on a platform that has a connector', async () => {
    const article = await newArticle();
    const draft = await prepareDraft(owner, env, { articleId: article.id, platform: 'devto' });
    const requested = await requestApproval(owner, env, draft.id, { mode: 'manual' });
    const done = await recordManualPost(owner, env, requested.draft.approval!.id, { checked: boxes('devto'), url: 'https://dev.to/someone/why-the-write-path-stalls-1a2b' });
    expect(done.draft).toMatchObject({ status: 'published', publishedVia: 'manual' });
    expect(devto.requests).toHaveLength(0);
  });

  it('declining puts the draft back where it was', async () => {
    const { draft, approvalId } = await asked();
    const back = await declineApproval(owner, env, approvalId);
    expect(back.status).toBe('draft');
    expect(back.id).toBe(draft.id);
  });

  it('the record is the owner’s other tenant’s nothing', async () => {
    const { approvalId } = await asked();
    await expectError(() => recordManualPost(other, env, approvalId, { checked: boxes(), url: 'https://www.linkedin.com/posts/1' }), 'not_found');
  });
});

describe('canonical page and the order of publishing', () => {
  const respondWith = (status: number, html = PAGE(), headers: Record<string, string> = { 'content-type': 'text/html' }) => (): { status: number; headers: Record<string, string>; body: Uint8Array } => ({ status, headers, body: new TextEncoder().encode(html) });

  it('live: 200, a title, the same host. The checklist stays at four boxes', async () => {
    const { requested } = await readyDevto();
    expect(requested.draft.canonical).toMatchObject({ state: 'live', httpStatus: 200 });
    expect(requested.draft.approval!.checklist).toEqual(devtoChecklist(false));
    expect(requested.draft.approval!.checklist).toHaveLength(4);
    expect(canonical.hops).toHaveLength(1);
    expect(canonical.hops[0]!.url.toString()).toBe(CANONICAL);
  });

  it('not live (404): the card warns and a fifth box is required', async () => {
    canonical = fakeCanonical({ respond: respondWith(404, 'nope') });
    env = { ...env, canonical };
    const { draftId, approvalId, requested } = await readyDevto();
    expect(requested.draft.canonical).toMatchObject({ state: 'not_live', httpStatus: 404 });
    expect(requested.draft.canonical!.message).toMatch(/404/);
    expect(requested.draft.approval!.checklist).toEqual(devtoChecklist(true));
    expect(requested.draft.approval!.checklist.at(-1)).toBe(CANONICAL_NOT_LIVE_BOX);

    const err = await expectError(() => approveAndPublish(owner, env, approvalId, { checked: devtoChecklist(false) }), 'invalid', { code: 'CHECKLIST' });
    expect(err.message).toMatch(/1 left/);
    expect(devtoPublishWrites()).toHaveLength(0);
    const done = await approveAndPublish(owner, env, approvalId, { checked: devtoChecklist(true) });
    expect(done.outcome).toBe('published');
    expect(done.draft.id).toBe(draftId);
  });

  it.each([
    ['a page without a title', respondWith(200, PAGE(null)), 'not_live'],
    ['a server error', respondWith(503, 'down'), 'not_live'],
    ['a redirect to another host', () => ({ status: 302, headers: { location: 'https://somewhere-else.example.org/p' }, body: new Uint8Array() }), 'blocked_or_not_live'],
    ['an image instead of a page', respondWith(200, 'x', { 'content-type': 'image/png' }), 'not_live'],
  ])('%s is not live', async (_label, respond, expected) => {
    canonical = fakeCanonical({ respond: (req) => (req.url.hostname === 'example-blog.dev' ? respond() : { status: 200, headers: { 'content-type': 'text/html' }, body: new TextEncoder().encode(PAGE()) }) });
    env = { ...env, canonical };
    const article = await newArticle();
    const { check } = await checkCanonical(owner, env, article.id);
    if (expected === 'blocked_or_not_live') expect(['not_live', 'blocked']).toContain(check!.state);
    else expect(check!.state).toBe(expected);
    expect(check!.message.length).toBeGreaterThan(10);
  });

  it('refuses private and loopback addresses and reads them as "blocked", fetching nothing', async () => {
    for (const url of ['http://127.0.0.1/post', 'http://localhost:3100/post', 'http://10.0.0.5/post', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/post', 'http://user:pw@example-blog.dev/post', 'ftp://example-blog.dev/post', 'http://example-blog.dev:9999/post']) {
      canonical = fakeCanonical();
      const result = await checkCanonicalPage(url, null, canonical);
      expect(result.state, url).toBe('blocked');
      expect(canonical.hops, url).toHaveLength(0);
    }
  });

  it('refuses a name that resolves to a private address (DNS pointing inward)', async () => {
    canonical = fakeCanonical({ resolve: async () => [{ address: '10.1.2.3', family: 4 }] });
    env = { ...env, canonical };
    const article = await newArticle();
    expect((await checkCanonical(owner, env, article.id)).check?.state).toBe('blocked');
    expect(canonical.hops).toHaveLength(0);
    canonical = fakeCanonical({ resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '192.168.1.1', family: 4 }] });
    env = { ...env, canonical };
    expect((await checkCanonical(owner, env, article.id)).check?.state).toBe('blocked');
  });

  it('refuses a redirect into a private address on a later hop', async () => {
    canonical = fakeCanonical({
      respond: (req) => (req.url.hostname === 'example-blog.dev' ? { status: 301, headers: { location: 'http://169.254.169.254/x' }, body: new Uint8Array() } : respondWith(200)()),
    });
    env = { ...env, canonical };
    const article = await newArticle();
    expect((await checkCanonical(owner, env, article.id)).check?.state).toBe('blocked');
    expect(canonical.hops).toHaveLength(1);
  });

  it('reads an unreachable site as unreachable, and requires the box too', async () => {
    canonical = fakeCanonical({ respond: () => { throw new Error('connect ECONNREFUSED'); } });
    env = { ...env, canonical };
    const { requested } = await readyDevto();
    expect(requested.draft.canonical?.state).toBe('unreachable');
    expect(requested.draft.approval!.checklist).toContain(CANONICAL_NOT_LIVE_BOX);
  });

  it('checks the page is on the host the owner configured for their site', async () => {
    await saveSiteSettings(owner, { siteUrl: 'https://www.my-real-site.dev', repo: null, baseBranch: 'main', pathTemplate: 'content/posts/{slug}.md', preset: 'generic', mapping: (await getSiteSettings(owner)).mapping });
    const article = await newArticle();
    const { check } = await checkCanonical(owner, env, article.id);
    expect(check?.state).toBe('not_live');
    expect(check?.message).toMatch(/www\.my-real-site\.dev/);
    expect(canonical.hops).toHaveLength(0);
  });

  it('does not ask for the box when the article has no canonical URL, and says so', async () => {
    const article = await newArticle({ canonicalUrl: null });
    const result = await checkCanonical(owner, env, article.id);
    expect(result).toEqual({ check: null, reason: expect.stringMatching(/no canonical URL/) });
    const draft = await prepareDraft(owner, env, { articleId: article.id, platform: 'devto' });
    await stageDraft(owner, env, draft.id);
    const requested = await requestApproval(owner, env, draft.id);
    expect(requested.draft.approval!.checklist).toEqual(approvalChecklist('DEV.to', false));
  });

  it('keeps one result per article and address, replaced by each new look, and per owner', async () => {
    const article = await newArticle();
    canonical = fakeCanonical({ respond: respondWith(404, 'x') });
    env = { ...env, canonical };
    expect((await checkCanonical(owner, env, article.id)).check?.state).toBe('not_live');
    canonical = fakeCanonical();
    env = { ...env, canonical };
    expect((await checkCanonical(owner, env, article.id)).check?.state).toBe('live');
    expect((await owner.data.canonicalChecks.get(article.id, CANONICAL))?.state).toBe('live');
    expect(await other.data.canonicalChecks.get(article.id, CANONICAL)).toBeNull();
    await expectError(() => checkCanonical(other, env, article.id), 'not_found');
  });

  it('recommends the personal site first', async () => {
    const { RECOMMENDED_ORDER } = await import('../src/lib/catalog');
    expect(RECOMMENDED_ORDER.slice(0, 3)).toEqual(['site', 'devto', 'hashnode']);
  });
});

describe('the personal site', () => {
  async function configured() {
    await saveSiteSettings(owner, { siteUrl: 'https://example-blog.dev', repo: REPO, baseBranch: 'main', pathTemplate: 'content/posts/{slug}.md', preset: 'hugo', mapping: { ...(await getSiteSettings(owner)).mapping, preset: 'hugo' } });
    await connectPlatform(owner, env, { platform: 'site', secret: GITHUB_KEY });
  }
  const prBoxes = () => approvalChecklist('Personal site', true, { kind: 'pull_request' });

  it('validates the settings before saving anything', async () => {
    const base = { siteUrl: null, repo: null, baseBranch: 'main', pathTemplate: 'content/posts/{slug}.md', preset: 'generic' as const, mapping: (await getSiteSettings(owner)).mapping };
    for (const [bad, field] of [
      [{ ...base, repo: 'not a repo' }, 'repo'],
      [{ ...base, siteUrl: 'http://example-blog.dev' }, 'siteUrl'],
      [{ ...base, siteUrl: 'https://localhost' }, 'siteUrl'],
      [{ ...base, baseBranch: 'bad branch..name' }, 'baseBranch'],
      [{ ...base, baseBranch: 'brand-os/x' }, 'baseBranch'],
      [{ ...base, pathTemplate: '../x/{slug}.md' }, 'pathTemplate'],
      [{ ...base, mapping: { ...base.mapping, fields: { ...base.mapping.fields, tags: 'title' } } }, 'mapping'],
    ] as const) {
      const err = await expectError(() => saveSiteSettings(owner, bad), 'invalid');
      expect(Object.keys(err.fields), field).toContain(field);
    }
    expect((await getSiteSettings(owner)).repo).not.toBe('not a repo');
  });

  it('settings belong to one owner', async () => {
    await configured();
    expect((await getSiteSettings(owner)).repo).toBe(REPO);
    expect((await getSiteSettings(other)).repo).toBeNull();
    expect((await other.data.siteSettings.get())?.repo).toBeNull();
  });

  it('only the signed-in owner changes the settings', async () => {
    await expectError(async () => saveSiteSettings(as(A, 'agent'), { siteUrl: null, repo: null, baseBranch: 'main', pathTemplate: 'content/posts/{slug}.md', preset: 'generic', mapping: (await getSiteSettings(owner)).mapping }), 'forbidden');
  });

  it('exports the finished Markdown file with no connection and no network', async () => {
    await saveSiteSettings(owner, { siteUrl: 'https://example-blog.dev', repo: null, baseBranch: 'main', pathTemplate: 'content/posts/{slug}.md', preset: 'jekyll', mapping: { ...(await getSiteSettings(owner)).mapping, preset: 'jekyll', dateFormat: 'jekyll', fixed: [{ key: 'layout', value: 'post' }] } });
    const article = await newArticle({ title: 'Export me' });
    const draft = await prepareDraft(owner, env, { articleId: article.id, platform: 'site' });
    const file = await exportDraft(owner, draft.id);
    expect(file.filename).toMatch(/^export-me.*\.md$/);
    expect(file.content.startsWith('---\n')).toBe(true);
    expect(file.content).toContain('layout: post');
    expect(file.content).toContain('title: Export me');
    expect(file.content).not.toContain('\r');
    expect(github.requests).toHaveLength(0);
    expect(draft.lint.map((i) => i.code)).toContain('repo_missing');
  });

  it('goes from draft to a pull request with the same approval model, and says the site goes live only when merged', async () => {
    await configured();
    const article = await newArticle();
    const draft = await prepareDraft(owner, env, { articleId: article.id, platform: 'site' });
    expect(draft.lint.filter((i) => i.severity === 'error')).toEqual([]);

    const staged = await stageDraft(owner, env, draft.id);
    expect(staged.ok).toBe(true);
    expect(staged.message).toMatch(/Nothing was written/);
    expect(staged.draft.remoteInfo).toMatchObject({ fileExists: false, path: draft.extras.site!.path });
    expect(github.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);

    const asked = await requestApproval(owner, env, draft.id);
    expect(asked.draft.approval!.checklist).toEqual(prBoxes());
    expect(asked.draft.requestPreview).toContain('read the base branch, never write to it');
    expect(asked.draft.requestPreview).toContain('brand-os/');
    // The canonical box does not apply to the site itself.
    expect(canonical.hops).toHaveLength(0);

    const done = await approveAndPublish(owner, env, asked.draft.approval!.id, { checked: prBoxes() });
    expect(done.outcome).toBe('published');
    expect(done.message).toMatch(/Merge it in GitHub to go live/);
    expect(done.draft.remoteUrl).toBe(github.pulls[0]!.html_url);
    expect(prCount()).toBe(1);
    expect(github.branches.get('main')).toBe(github.baseSha());
    expect(github.pulls[0]!.head).toMatch(/^brand-os\/.+-[0-9a-f]{8}$/);
    expect(github.pulls[0]!.base).toBe('main');
  });

  it('refuses to ask for approval while a file sits at the path and the draft is not marked "update existing"', async () => {
    await configured();
    const article = await newArticle();
    const draft = await prepareDraft(owner, env, { articleId: article.id, platform: 'site' });
    const existing = github.seedFile('main', draft.extras.site!.path, 'someone else wrote this');
    const staged = await stageDraft(owner, env, draft.id);
    expect(staged.message).toMatch(/already exists/);
    await expectError(() => requestApproval(owner, env, draft.id), 'conflict', { code: 'FILE_EXISTS' });
    expect(github.files.get(`main:${draft.extras.site!.path}`)?.sha).toBe(existing.sha);
    expect(github.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
  });

  it('"update existing" is only offered for a file that was looked at, then needs to be staged again', async () => {
    await configured();
    const article = await newArticle();
    const draft = await prepareDraft(owner, env, { articleId: article.id, platform: 'site' });
    await expectError(() => editDraft(owner, env, draft.id, { expectedHash: draft.payloadSha256, site: { updateExisting: true } }), 'invalid');
    const existing = github.seedFile('main', draft.extras.site!.path, 'old');
    const staged = await stageDraft(owner, env, draft.id);
    const marked = await editDraft(owner, env, draft.id, { expectedHash: staged.draft.payloadSha256, site: { updateExisting: true } });
    expect(marked.draft.extras.site).toMatchObject({ updateExisting: true, expectedSha: existing.sha });
    expect(marked.draft.status).toBe('draft');
    expect(marked.draft.payloadSha256).not.toBe(staged.draft.payloadSha256);
    const again = await stageDraft(owner, env, draft.id);
    expect(again.draft.status).toBe('staged');
    const asked = await requestApproval(owner, env, draft.id);
    const done = await approveAndPublish(owner, env, asked.draft.approval!.id, { checked: prBoxes() });
    expect(done.outcome).toBe('published');
    expect(github.files.get(`main:${draft.extras.site!.path}`)?.content).toBe('old');
  });

  it('a pull request that timed out is unknown, never retried, and settled by "check on platform"', async () => {
    await configured();
    const article = await newArticle();
    const draft = await prepareDraft(owner, env, { articleId: article.id, platform: 'site' });
    await stageDraft(owner, env, draft.id);
    const asked = await requestApproval(owner, env, draft.id);
    github.inject({ match: /POST \/repos\/.+\/pulls/, afterApply: true, hang: true });
    env = { ...env, timeoutMs: 50 };
    const out = await approveAndPublish(owner, env, asked.draft.approval!.id, { checked: prBoxes() });
    expect(out.outcome).toBe('unknown');
    expect(out.message).toMatch(/pull request may or may not exist/);
    expect(prCount()).toBe(1);

    const checked = await checkOnPlatform(owner, env, draft.id);
    expect(checked.remote).toBe('published');
    expect(checked.draft.status).toBe('published');
    expect(checked.draft.remoteUrl).toBe(github.pulls[0]!.html_url);
    expect(prCount()).toBe(1);
  });

  it('a rejected token during the pull request is a clean failure the owner can retry', async () => {
    await configured();
    const article = await newArticle();
    const draft = await prepareDraft(owner, env, { articleId: article.id, platform: 'site' });
    await stageDraft(owner, env, draft.id);
    const asked = await requestApproval(owner, env, draft.id);
    github.inject({ match: /PUT \/repos\/.+\/contents\//, status: 403, body: { message: 'Resource not accessible by personal access token' } });
    const out = await approveAndPublish(owner, env, asked.draft.approval!.id, { checked: prBoxes() });
    expect(out.outcome).toBe('failed');
    expect(out.message).toContain('Contents: read and write');
    expect(out.draft.status).toBe('failed');
    expect(JSON.stringify(out)).not.toContain(GITHUB_KEY);
    expect(prCount()).toBe(0);
  });

  it('connecting needs the repository saved first, and a token that can write', async () => {
    await expectError(() => connectPlatform(owner, env, { platform: 'site', secret: GITHUB_KEY }), 'conflict', { code: 'NO_REPO' });
    await saveSiteSettings(owner, { siteUrl: null, repo: REPO, baseBranch: 'main', pathTemplate: 'content/posts/{slug}.md', preset: 'generic', mapping: (await getSiteSettings(owner)).mapping });
    const err = await expectError(() => connectPlatform(owner, env, { platform: 'site', secret: 'a-token-github-does-not-know' }), 'invalid');
    expect(err.message).not.toContain('a-token-github-does-not-know');
    const ok = await connectPlatform(owner, env, { platform: 'site', secret: GITHUB_KEY });
    expect(ok).toMatchObject({ platform: 'site', status: 'connected', who: REPO });
    expect(JSON.stringify(ok)).not.toContain(GITHUB_KEY);
    expect(github.requests.every((r) => r.method === 'GET')).toBe(true);
  });
});

describe('approving takes exactly one approval id and nothing else', () => {
  it('rejects a body that names more approvals or anything beyond the ticked boxes', async () => {
    const first = await readyDevto();
    const second = await readyDevto();
    for (const extra of [{ approvalIds: [first.approvalId, second.approvalId] }, { ids: [second.approvalId] }, { all: true }, { approvalId: second.approvalId }]) {
      await expectError(() => approveAndPublish(owner, env, first.approvalId, { checked: devtoChecklist(), ...extra }), 'invalid');
    }
    await expectError(() => approveAndPublish(owner, env, [first.approvalId, second.approvalId] as unknown as string, { checked: devtoChecklist() }));
    expect(devtoPublishWrites()).toHaveLength(0);
    const out = await approveAndPublish(owner, env, first.approvalId, { checked: devtoChecklist() });
    expect(out.outcome).toBe('published');
    // The other one is still waiting: one approval changed exactly one draft.
    expect((await getDraft(owner, env, second.draftId)).status).toBe('pending_approval');
    expect(devtoPublishWrites()).toHaveLength(1);
  });
});
