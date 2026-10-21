import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as exportGet } from '../src/app/api/export/route';
import { DELETE as itemDelete, GET as itemGet, PATCH as itemPatch } from '../src/app/api/knowledge/[id]/route';
import { POST as itemReview } from '../src/app/api/knowledge/[id]/review/route';
import { GET as itemsGet, POST as itemsPost } from '../src/app/api/knowledge/route';
import { GET as profileGet, PUT as profilePut } from '../src/app/api/profile/route';
import { DELETE as sourceDelete } from '../src/app/api/sources/[id]/route';
import { GET as sourcesGet, POST as sourcesPost } from '../src/app/api/sources/route';
import { forOwner, NotFoundError } from '../src/server/data/tenant';
import { hostedHarness, type HostedHarness, type TestUser } from './hosted-harness';

// Synthetic, obviously fake values. Never real seed content.
const A_TERM = 'zyxwvutquartzmarker';
const B_TERM = 'plughquillrotorxx';

let h: HostedHarness;
let a: TestUser;
let b: TestUser;
let aItemId: string;
let aSourceId: string;

const params = (id: string) => ({ params: Promise.resolve({ id }) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response) => (await res.json()) as Record<string, any>;

beforeAll(async () => {
  h = await hostedHarness();
  a = await h.signUp('user.a@example.test', 'User A');
  b = await h.signUp('user.b@example.test', 'User B');

  const aData = forOwner(a.userId, h.ctx.db);
  const bData = forOwner(b.userId, h.ctx.db);
  const source = await aData.sources.create({ kind: 'manual', title: `Notes ${A_TERM}`, uri: null, sourceDate: null });
  aSourceId = source.id;
  const item = await aData.items.create({
    kind: 'note',
    title: `Alpha note ${A_TERM}`,
    body: `A private observation about ${A_TERM} and latency.`,
    tags: ['alpha'],
    sourceId: source.id,
    sourceDate: null,
    verificationStatus: 'unverified',
    confidence: 'medium',
    confidentiality: 'private',
    publicUsePermitted: false,
  });
  aItemId = item.id;
  await aData.profile.upsert({
    name: 'Person A',
    headline: `Headline ${A_TERM}`,
    yearsExperience: 3,
    location: null,
    careerGoals: null,
    targetEmployers: [],
    expertiseAreas: [],
  });
  await bData.items.create({
    kind: 'note',
    title: `Beta note ${B_TERM}`,
    body: 'Another person entirely.',
    tags: [],
    sourceId: null,
    sourceDate: null,
    verificationStatus: 'unverified',
    confidence: 'medium',
    confidentiality: 'private',
    publicUsePermitted: false,
  });
});

afterAll(async () => {
  await h.close();
});

describe('tenant isolation in the data layer', () => {
  it('user B cannot read, list, update, review, delete or search user A items', async () => {
    const bData = forOwner(b.userId, h.ctx.db);
    expect(await bData.items.get(aItemId)).toBeNull();
    expect((await bData.items.list()).map((i) => i.id)).not.toContain(aItemId);
    await expect(bData.items.update(aItemId, { title: 'hijacked' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(bData.items.markReviewed(aItemId)).rejects.toBeInstanceOf(NotFoundError);
    expect(await bData.items.remove(aItemId)).toBe(false);
    expect(await bData.items.search(A_TERM)).toEqual([]);
    expect(await bData.items.search('latency')).toEqual([]);

    const stillThere = await forOwner(a.userId, h.ctx.db).items.get(aItemId);
    expect(stillThere?.title).toContain('Alpha note');
    expect(stillThere?.verificationStatus).toBe('unverified');
  });

  it('user B cannot read or delete user A sources and cannot attach an item to them', async () => {
    const bData = forOwner(b.userId, h.ctx.db);
    expect(await bData.sources.get(aSourceId)).toBeNull();
    expect(await bData.sources.list()).toEqual([]);
    expect(await bData.sources.remove(aSourceId)).toBe(false);
    await expect(
      bData.items.create({
        kind: 'note',
        title: 'sneaky',
        body: '',
        tags: [],
        sourceId: aSourceId,
        sourceDate: null,
        verificationStatus: 'unverified',
        confidence: 'medium',
        confidentiality: 'private',
        publicUsePermitted: false,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('user B sees no profile of user A, and exports contain only their own rows', async () => {
    const bData = forOwner(b.userId, h.ctx.db);
    expect(await bData.profile.get()).toBeNull();
    const exported = JSON.stringify(await bData.exportAll());
    expect(exported).not.toContain(A_TERM);
    expect(exported).toContain(B_TERM);
  });

  it('the owner id of an insert comes from the scope, not from the values', async () => {
    const aData = forOwner(a.userId, h.ctx.db);
    const smuggled = { kind: 'note', title: 'forged', body: '', tags: [], sourceId: null, sourceDate: null,
      verificationStatus: 'unverified', confidence: 'medium', confidentiality: 'private', publicUsePermitted: false,
      ownerId: b.userId } as never;
    const created = await aData.items.create(smuggled);
    expect(created.ownerId).toBe(a.userId);
    const profile = await aData.profile.upsert({ name: 'Person A', ownerId: b.userId } as never);
    expect(profile.ownerId).toBe(a.userId);
    expect((await forOwner(b.userId, h.ctx.db).items.list()).map((i) => i.title)).not.toContain('forged');
  });

  it('refuses a malformed owner id outright', () => {
    expect(() => forOwner("' or true --", h.ctx.db)).toThrow();
    expect(() => forOwner('', h.ctx.db)).toThrow();
  });
});

describe('tenant isolation through the route handlers', () => {
  it('rejects signed-out requests', async () => {
    expect((await exportGet(h.request(null, 'GET', '/api/export'))).status).toBe(401);
    expect((await itemsGet(h.request(null, 'GET', '/api/knowledge'))).status).toBe(401);
    expect((await itemGet(h.request(null, 'GET', `/api/knowledge/${aItemId}`), params(aItemId))).status).toBe(401);
  });

  it('A reads their own item and finds it by search', async () => {
    const res = await itemGet(h.request(a, 'GET', `/api/knowledge/${aItemId}`), params(aItemId));
    expect(res.status).toBe(200);
    const search = await json(await itemsGet(h.request(a, 'GET', `/api/knowledge?q=${A_TERM}`)));
    expect(search.items.map((i: { id: string }) => i.id)).toContain(aItemId);
    expect(search.hits[0].snippet).toContain('\u0001');
  });

  it('B gets 404 for A item ids on read, patch, review and delete, and nothing changes', async () => {
    expect((await itemGet(h.request(b, 'GET', `/api/knowledge/${aItemId}`), params(aItemId))).status).toBe(404);
    expect((await itemPatch(h.request(b, 'PATCH', `/api/knowledge/${aItemId}`, { title: 'hijacked' }), params(aItemId))).status).toBe(404);
    expect((await itemReview(h.request(b, 'POST', `/api/knowledge/${aItemId}/review`), params(aItemId))).status).toBe(404);
    expect((await itemDelete(h.request(b, 'DELETE', `/api/knowledge/${aItemId}`), params(aItemId))).status).toBe(404);

    const mine = await json(await itemGet(h.request(a, 'GET', `/api/knowledge/${aItemId}`), params(aItemId)));
    expect(mine.title).toContain('Alpha note');
    expect(mine.verificationStatus).toBe('unverified');
  });

  it('B search for A distinctive term returns nothing, even with A id in the query string', async () => {
    const res = await json(await itemsGet(h.request(b, 'GET', `/api/knowledge?q=${A_TERM}&ownerId=${a.userId}&owner_id=${a.userId}`)));
    expect(res.items).toEqual([]);
    expect(res.hits).toEqual([]);
    const own = await json(await itemsGet(h.request(b, 'GET', `/api/knowledge?q=${B_TERM}`)));
    expect(own.items).toHaveLength(1);
  });

  it('the export and profile endpoints return only the caller own data', async () => {
    const exportB = await (await exportGet(h.request(b, 'GET', '/api/export'))).text();
    expect(exportB).not.toContain(A_TERM);
    expect(exportB).not.toContain(a.userId);
    const exportA = await json(await exportGet(h.request(a, 'GET', '/api/export')));
    expect(exportA.format).toBe('brand-os-export-v1');
    expect(JSON.stringify(exportA)).toContain(A_TERM);
    expect(JSON.stringify(exportA)).not.toContain(B_TERM);
    expect(exportA.items.every((i: Record<string, unknown>) => !('ownerId' in i))).toBe(true);

    const profileB = await json(await profileGet(h.request(b, 'GET', '/api/profile')));
    expect(profileB.profile).toBeNull();
  });

  it('B cannot delete or attach to A source', async () => {
    expect((await sourceDelete(h.request(b, 'DELETE', `/api/sources/${aSourceId}`), params(aSourceId))).status).toBe(404);
    const attach = await itemsPost(h.request(b, 'POST', '/api/knowledge', { kind: 'note', title: 'sneaky', sourceId: aSourceId }));
    expect(attach.status).toBe(404);
    const listB = await json(await sourcesGet(h.request(b, 'GET', '/api/sources')));
    expect(listB.sources).toEqual([]);
  });

  it('an owner id in the request body, query or headers cannot override the session', async () => {
    const created = await itemsPost(
      h.request(b, 'POST', `/api/knowledge?ownerId=${a.userId}`, {
        kind: 'note',
        title: 'created by B',
        ownerId: a.userId,
        owner_id: a.userId,
        userId: a.userId,
      }, { 'x-owner-id': a.userId, 'x-user-id': a.userId }),
    );
    expect(created.status).toBe(201);
    const row = await json(created);
    expect(row.ownerId).toBe(b.userId);
    const aList = await json(await itemsGet(h.request(a, 'GET', '/api/knowledge')));
    expect(aList.items.map((i: { title: string }) => i.title)).not.toContain('created by B');

    const src = await sourcesPost(h.request(b, 'POST', '/api/sources', { title: 'B source', ownerId: a.userId }));
    expect((await json(src)).ownerId).toBe(b.userId);

    const put = await profilePut(h.request(b, 'PUT', '/api/profile', { profile: { name: 'Person B', ownerId: a.userId } }));
    expect(put.status).toBe(200);
    const aProfile = await json(await profileGet(h.request(a, 'GET', '/api/profile')));
    expect(aProfile.profile.name).toBe('Person A');
  });

  it('refuses cross-site mutations that carry the session cookie', async () => {
    const forged = await itemsPost(h.request(a, 'POST', '/api/knowledge', { kind: 'note', title: 'csrf' }, { origin: 'https://evil.example.test' }));
    expect(forged.status).toBe(403);
    const titles = (await json(await itemsGet(h.request(a, 'GET', '/api/knowledge')))).items.map((i: { title: string }) => i.title);
    expect(titles).not.toContain('csrf');
  });

  it('validates input with field messages and never echoes an unknown id as existing', async () => {
    const bad = await itemsPost(h.request(a, 'POST', '/api/knowledge', { kind: 'nonsense', title: '' }));
    expect(bad.status).toBe(400);
    expect((await json(bad)).fields).toBeTruthy();
    const notUuid = await itemGet(h.request(a, 'GET', '/api/knowledge/not-a-uuid'), params('not-a-uuid'));
    expect(notUuid.status).toBe(404);
  });
});
