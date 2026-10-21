import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as articleGet, PATCH as articlePatch, DELETE as articleDelete } from '../src/app/api/articles/[id]/route';
import { POST as versionRestore } from '../src/app/api/articles/[id]/versions/[no]/restore/route';
import { GET as versionGet } from '../src/app/api/articles/[id]/versions/[no]/route';
import { GET as versionsGet } from '../src/app/api/articles/[id]/versions/route';
import { GET as slugCheck } from '../src/app/api/articles/check-slug/route';
import { GET as articlesGet, POST as articlesPost } from '../src/app/api/articles/route';
import { GET as exportGet } from '../src/app/api/export/route';
import { forOwner } from '../src/server/data/tenant';
import { hostedHarness, type HostedHarness, type TestUser } from './hosted-harness';

const A_TERM = 'quillfeatherxyzzy';
const B_TERM = 'rotorplinthqwerty';

let h: HostedHarness;
let a: TestUser;
let b: TestUser;
let aId: string;
let aRevision: number;
let bId: string;

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const versionParams = (id: string, no: string) => ({ params: Promise.resolve({ id, no }) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response) => (await res.json()) as Record<string, any>;

beforeAll(async () => {
  h = await hostedHarness();
  a = await h.signUp('writer.a@example.test', 'Writer A');
  b = await h.signUp('writer.b@example.test', 'Writer B');
  const created = await json(
    await articlesPost(h.request(a, 'POST', '/api/articles', { title: `Alpha ${A_TERM}`, bodyMarkdown: `Secret body about ${A_TERM}.`, tags: ['alpha'] })),
  );
  aId = created.id;
  aRevision = created.revision;
  const other = await json(await articlesPost(h.request(b, 'POST', '/api/articles', { title: `Beta ${B_TERM}`, bodyMarkdown: 'Another person.' })));
  bId = other.id;
});

afterAll(async () => {
  await h.close();
});

describe('articles through the routes', () => {
  it('require a signed-in user', async () => {
    expect((await articlesGet(h.request(null, 'GET', '/api/articles'))).status).toBe(401);
    expect((await articlesPost(h.request(null, 'POST', '/api/articles', {}))).status).toBe(401);
    expect((await articleGet(h.request(null, 'GET', `/api/articles/${aId}`), params(aId))).status).toBe(401);
  });

  it('give each owner a slug from the title, and let two owners share one', async () => {
    const first = await json(await articlesPost(h.request(a, 'POST', '/api/articles', { title: 'Shared Title' })));
    const second = await json(await articlesPost(h.request(b, 'POST', '/api/articles', { title: 'Shared Title' })));
    const third = await json(await articlesPost(h.request(a, 'POST', '/api/articles', { title: 'Shared Title' })));
    expect(first.slug).toBe('shared-title');
    expect(second.slug).toBe('shared-title');
    expect(third.slug).toBe('shared-title-2');
  });

  it('answer slug checks per owner without leaking the other owner', async () => {
    const mine = await json(await slugCheck(h.request(a, 'GET', '/api/articles/check-slug?slug=shared-title')));
    expect(mine).toMatchObject({ valid: true, available: false, suggestion: 'shared-title-3' });
    const fresh = await json(await slugCheck(h.request(b, 'GET', `/api/articles/check-slug?slug=alpha-${A_TERM}`)));
    expect(fresh.available).toBe(true);
    const bad = await json(await slugCheck(h.request(a, 'GET', '/api/articles/check-slug?slug=Not%20Valid')));
    expect(bad.valid).toBe(false);
  });

  it('reject an invalid slug, tags and canonical URL with field messages', async () => {
    const res = await articlePatch(
      h.request(a, 'PATCH', `/api/articles/${aId}`, { expectedRevision: aRevision, slug: 'Bad Slug', canonicalUrl: 'javascript:alert(1)' }),
      params(aId),
    );
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.fields.slug).toBeTruthy();
    expect(body.fields.canonicalUrl).toBeTruthy();
  });
});

describe('tenant isolation for articles', () => {
  it('user B cannot read, list, search, update, delete or inspect the history of user A articles', async () => {
    expect((await articleGet(h.request(b, 'GET', `/api/articles/${aId}`), params(aId))).status).toBe(404);
    expect((await versionsGet(h.request(b, 'GET', `/api/articles/${aId}/versions`), params(aId))).status).toBe(404);
    expect((await versionGet(h.request(b, 'GET', `/api/articles/${aId}/versions/1`), versionParams(aId, '1'))).status).toBe(404);

    const listed = await json(await articlesGet(h.request(b, 'GET', '/api/articles?status=all')));
    expect(listed.articles.map((x: { id: string }) => x.id)).not.toContain(aId);
    const searched = await json(await articlesGet(h.request(b, 'GET', `/api/articles?q=${A_TERM}&status=all`)));
    expect(searched.articles).toEqual([]);
    const own = await json(await articlesGet(h.request(b, 'GET', `/api/articles?q=${B_TERM}`)));
    expect(own.articles.map((x: { id: string }) => x.id)).toEqual([bId]);

    const patched = await articlePatch(h.request(b, 'PATCH', `/api/articles/${aId}`, { expectedRevision: aRevision, title: 'hijacked' }), params(aId));
    expect(patched.status).toBe(404);
    expect((await articleDelete(h.request(b, 'DELETE', `/api/articles/${aId}`), params(aId))).status).toBe(404);

    const still = await json(await articleGet(h.request(a, 'GET', `/api/articles/${aId}`), params(aId)));
    expect(still.title).toBe(`Alpha ${A_TERM}`);
    expect(still.revision).toBe(aRevision);
  });

  it('user B cannot restore an A version, even with a valid version number and revision', async () => {
    const saved = await json(
      await articlePatch(h.request(a, 'PATCH', `/api/articles/${aId}`, { expectedRevision: aRevision, bodyMarkdown: 'rewritten by A', reason: 'manual' }), params(aId)),
    );
    aRevision = saved.revision;
    const res = await versionRestore(h.request(b, 'POST', `/api/articles/${aId}/versions/1/restore`, { expectedRevision: aRevision }), versionParams(aId, '1'));
    expect(res.status).toBe(404);
    const after = await json(await articleGet(h.request(a, 'GET', `/api/articles/${aId}`), params(aId)));
    expect(after.bodyMarkdown).toBe('rewritten by A');
  });

  it('a cover image must be the owner own asset', async () => {
    const aData = forOwner(a.userId, h.ctx.db);
    const aAsset = await aData.assets.create({
      articleId: null,
      filename: 'cover.png',
      mime: 'image/png',
      size: 3,
      sha256: 'c'.repeat(64),
      storageKey: `${a.userId}/00000000-0000-4000-8000-000000000009.png`,
    });
    const stolen = await articlePatch(h.request(b, 'PATCH', `/api/articles/${bId}`, { expectedRevision: 1, coverAssetId: aAsset.asset.id }), params(bId));
    expect(stolen.status).toBe(404);
    expect((await json(await articleGet(h.request(b, 'GET', `/api/articles/${bId}`), params(bId)))).coverAssetId).toBeNull();
    const mine = await articlePatch(h.request(a, 'PATCH', `/api/articles/${aId}`, { expectedRevision: aRevision, coverAssetId: aAsset.asset.id }), params(aId));
    expect(mine.status).toBe(200);
    aRevision = (await json(mine)).revision;
  });

  it('exports contain only the requester articles', async () => {
    const exported = JSON.stringify(await json(await exportGet(h.request(b, 'GET', '/api/export'))));
    expect(exported).not.toContain(A_TERM);
    expect(exported).toContain(B_TERM);
  });

  it('the owner id of a created article comes from the session, not the body', async () => {
    const res = await json(await articlesPost(h.request(b, 'POST', '/api/articles', { title: 'Smuggle', ownerId: a.userId })));
    expect(res.ownerId).toBe(b.userId);
    const aList = await json(await articlesGet(h.request(a, 'GET', '/api/articles?status=all')));
    expect(aList.articles.map((x: { title: string }) => x.title)).not.toContain('Smuggle');
  });
});

describe('saving and conflicts through the routes', () => {
  it('rejects a stale revision with 409 and the current copy, and a keep-mine retry then wins', async () => {
    const created = await json(await articlesPost(h.request(a, 'POST', '/api/articles', { title: 'Conflict demo' })));
    const tabOne = await articlePatch(
      h.request(a, 'PATCH', `/api/articles/${created.id}`, { expectedRevision: created.revision, bodyMarkdown: 'tab one wrote this' }),
      params(created.id),
    );
    expect(tabOne.status).toBe(200);
    const saved = await json(tabOne);

    const tabTwo = await articlePatch(
      h.request(a, 'PATCH', `/api/articles/${created.id}`, { expectedRevision: created.revision, bodyMarkdown: 'tab two wrote this' }),
      params(created.id),
    );
    expect(tabTwo.status).toBe(409);
    const conflict = await json(tabTwo);
    expect(conflict.code).toBe('conflict');
    expect(conflict.data.current).toMatchObject({ bodyMarkdown: 'tab one wrote this', revision: saved.revision });

    const retry = await articlePatch(
      h.request(a, 'PATCH', `/api/articles/${created.id}`, { expectedRevision: conflict.data.current.revision, bodyMarkdown: 'tab two wrote this' }),
      params(created.id),
    );
    expect(retry.status).toBe(200);
    expect((await json(retry)).bodyMarkdown).toBe('tab two wrote this');
  });

  it('autosave then manual save then restore leaves a usable history', async () => {
    const created = await json(await articlesPost(h.request(a, 'POST', '/api/articles', { title: 'History demo', bodyMarkdown: 'v1' })));
    let revision: number = created.revision;
    revision = (await json(await articlePatch(h.request(a, 'PATCH', `/api/articles/${created.id}`, { expectedRevision: revision, bodyMarkdown: 'v2' }), params(created.id)))).revision;
    revision = (await json(await articlePatch(h.request(a, 'PATCH', `/api/articles/${created.id}`, { expectedRevision: revision, bodyMarkdown: 'v3', reason: 'manual' }), params(created.id)))).revision;
    const list = await json(await versionsGet(h.request(a, 'GET', `/api/articles/${created.id}/versions`), params(created.id)));
    expect(list.versions.map((v: { reason: string }) => v.reason)).toEqual(['manual', 'autosave', 'manual']);
    const restored = await versionRestore(h.request(a, 'POST', `/api/articles/${created.id}/versions/1/restore`, { expectedRevision: revision }), versionParams(created.id, '1'));
    expect(restored.status).toBe(200);
    expect((await json(restored)).bodyMarkdown).toBe('v1');
    const after = await json(await versionsGet(h.request(a, 'GET', `/api/articles/${created.id}/versions`), params(created.id)));
    expect(after.versions).toHaveLength(4);
    expect(after.versions[0].reason).toBe('restore');
    const stale = await versionRestore(h.request(a, 'POST', `/api/articles/${created.id}/versions/2/restore`, { expectedRevision: revision }), versionParams(created.id, '2'));
    expect(stale.status).toBe(409);
  });
});
