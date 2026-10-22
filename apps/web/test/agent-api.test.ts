import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as agentArticleGet, PATCH as agentArticlePatch } from '../src/app/api/agent/articles/[id]/route';
import { GET as agentArticlesGet, POST as agentArticlesPost } from '../src/app/api/agent/articles/route';
import { GET as agentKnowledge } from '../src/app/api/agent/knowledge/route';
import { GET as agentMe } from '../src/app/api/agent/me/route';
import { POST as credentialsPost } from '../src/app/api/agent-credentials/route';
import { forOwner } from '../src/server/data/tenant';
import { hostedHarness, type HostedHarness, type TestUser } from './hosted-harness';

const A_TERM = 'quartzlanternxyzzy';
const B_TERM = 'basaltgimbalqwerty';

let h: HostedHarness;
let a: TestUser;
let b: TestUser;
let aRead: string;
let aWrite: string;
let bRead: string;
let bWrite: string;
let aArticleId: string;
let bArticleId: string;

const params = (id: string) => ({ params: Promise.resolve({ id }) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response) => (await res.json()) as Record<string, any>;
const auth = (secret: string) => ({ authorization: `Bearer ${secret}` });

async function mint(user: TestUser, name: string, scopes: string[]): Promise<string> {
  const res = await credentialsPost(h.request(user, 'POST', '/api/agent-credentials', { name, scopes }));
  return ((await res.json()) as { secret: string }).secret;
}

beforeAll(async () => {
  h = await hostedHarness();
  a = await h.signUp('agent.api.a@example.test', 'Writer A');
  b = await h.signUp('agent.api.b@example.test', 'Writer B');
  aRead = await mint(a, 'a read', ['read']);
  aWrite = await mint(a, 'a write', ['read', 'write_articles']);
  bRead = await mint(b, 'b read', ['read']);
  bWrite = await mint(b, 'b write', ['read', 'write_articles']);

  const aData = forOwner(a.userId, h.ctx.db);
  const bData = forOwner(b.userId, h.ctx.db);
  const aArticle = await aData.articles.create({ title: `Alpha ${A_TERM}`, slug: 'alpha', bodyMarkdown: `Body about ${A_TERM}.` });
  const bArticle = await bData.articles.create({ title: `Beta ${B_TERM}`, slug: 'beta', bodyMarkdown: `Body about ${B_TERM}.` });
  aArticleId = aArticle.id;
  bArticleId = bArticle.id;
  await aData.items.create({
    kind: 'note',
    title: `Private note ${A_TERM}`,
    body: `Something about ${A_TERM}.`,
    tags: [],
    sourceId: null,
    sourceDate: null,
    verificationStatus: 'unverified',
    confidence: 'medium',
    confidentiality: 'private',
    publicUsePermitted: false,
  });
  await bData.profile.upsert({
    name: 'Person B',
    headline: `Headline ${B_TERM}`,
    yearsExperience: null,
    location: null,
    careerGoals: null,
    targetEmployers: [],
    expertiseAreas: [],
  });
});

afterAll(async () => {
  await h.close();
});

describe('agent API: reading', () => {
  it('lists only the key owner\'s articles and never shows an owner id', async () => {
    const res = await json(await agentArticlesGet(h.request(null, 'GET', '/api/agent/articles', undefined, auth(aRead))));
    const text = JSON.stringify(res);
    expect(res.articles.map((x: { id: string }) => x.id)).toEqual([aArticleId]);
    expect(text).not.toContain(B_TERM);
    expect(text).not.toContain(a.userId);
    expect(res.articles[0]).not.toHaveProperty('bodyMarkdown');
  });

  it('searches only the key owner\'s articles and knowledge', async () => {
    const mine = await json(await agentArticlesGet(h.request(null, 'GET', `/api/agent/articles?q=${A_TERM}`, undefined, auth(aRead))));
    expect(mine.articles).toHaveLength(1);
    expect(mine.articles[0].snippet).not.toMatch(/[\u0001\u0002]/);
    const theirs = await json(await agentArticlesGet(h.request(null, 'GET', `/api/agent/articles?q=${B_TERM}`, undefined, auth(aRead))));
    expect(theirs.articles).toEqual([]);
    const knowledge = await json(await agentKnowledge(h.request(null, 'GET', `/api/agent/knowledge?q=${A_TERM}`, undefined, auth(aRead))));
    expect(knowledge.items).toHaveLength(1);
    expect(knowledge.items[0]).toMatchObject({ confidentiality: 'private', publicUsePermitted: false });
    const none = await json(await agentKnowledge(h.request(null, 'GET', `/api/agent/knowledge?q=${A_TERM}`, undefined, auth(bRead))));
    expect(none.items).toEqual([]);
  });

  it('answers another owner\'s article id exactly like a missing one', async () => {
    const other = await agentArticleGet(h.request(null, 'GET', `/api/agent/articles/${bArticleId}`, undefined, auth(aRead)), params(bArticleId));
    const missing = await agentArticleGet(h.request(null, 'GET', '/api/agent/articles/00000000-0000-4000-8000-000000000009', undefined, auth(aRead)), params('00000000-0000-4000-8000-000000000009'));
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual(await missing.json());
  });

  it('returns the profile of the key owner only', async () => {
    const asB = await json(await agentMe(h.request(null, 'GET', `/api/agent/me?ownerId=${a.userId}`, undefined, auth(bRead))));
    expect(asB.profile.name).toBe('Person B');
    expect(JSON.stringify(asB)).not.toContain(b.userId);
  });
});

describe('agent API: writing', () => {
  it('needs the write_articles scope', async () => {
    const create = await agentArticlesPost(h.request(null, 'POST', '/api/agent/articles', { title: 'Nope' }, auth(aRead)));
    expect(create.status).toBe(403);
    const patch = await agentArticlePatch(
      h.request(null, 'PATCH', `/api/agent/articles/${aArticleId}`, { expectedRevision: 1, title: 'Nope' }, auth(aRead)),
      params(aArticleId),
    );
    expect(patch.status).toBe(403);
  });

  it('creates an article for the key owner, ignoring any owner id in the body', async () => {
    const res = await agentArticlesPost(
      h.request(null, 'POST', '/api/agent/articles', { title: 'From an agent', bodyMarkdown: 'Hello.', ownerId: b.userId, owner_id: b.userId }, auth(aWrite)),
    );
    expect(res.status).toBe(201);
    const made = await json(res);
    expect(made.title).toBe('From an agent');
    const mine = forOwner(a.userId, h.ctx.db);
    const theirs = forOwner(b.userId, h.ctx.db);
    expect(await mine.articles.get(made.id)).not.toBeNull();
    expect(await theirs.articles.get(made.id)).toBeNull();
    const versions = await mine.articles.listVersions(made.id);
    expect(versions[0]?.reason).toBe('agent');
  });

  it('saves with optimistic concurrency and records its own version reason', async () => {
    const article = await json(await agentArticleGet(h.request(null, 'GET', `/api/agent/articles/${aArticleId}`, undefined, auth(aWrite)), params(aArticleId)));
    const saved = await agentArticlePatch(
      h.request(null, 'PATCH', `/api/agent/articles/${aArticleId}`, { expectedRevision: article.revision, bodyMarkdown: 'Rewritten by an agent.', reason: 'autosave', coverAssetId: aArticleId }, auth(aWrite)),
      params(aArticleId),
    );
    expect(saved.status).toBe(200);
    const after = await json(saved);
    expect(after.revision).toBe(article.revision + 1);
    expect(after.bodyMarkdown).toBe('Rewritten by an agent.');
    const versions = await forOwner(a.userId, h.ctx.db).articles.listVersions(aArticleId);
    expect(versions[0]?.reason).toBe('agent');

    const stale = await agentArticlePatch(
      h.request(null, 'PATCH', `/api/agent/articles/${aArticleId}`, { expectedRevision: article.revision, bodyMarkdown: 'Late write.' }, auth(aWrite)),
      params(aArticleId),
    );
    expect(stale.status).toBe(409);
    const conflict = await json(stale);
    expect(conflict.data.current.bodyMarkdown).toBe('Rewritten by an agent.');
    expect(conflict.data.current).not.toHaveProperty('ownerId');
    expect((await forOwner(a.userId, h.ctx.db).articles.get(aArticleId))?.bodyMarkdown).toBe('Rewritten by an agent.');
  });

  it('cannot change another owner\'s article, even holding its id and write scope', async () => {
    const res = await agentArticlePatch(
      h.request(null, 'PATCH', `/api/agent/articles/${bArticleId}`, { expectedRevision: 1, bodyMarkdown: 'Hijacked.' }, auth(aWrite)),
      params(bArticleId),
    );
    expect(res.status).toBe(404);
    expect((await forOwner(b.userId, h.ctx.db).articles.get(bArticleId))?.bodyMarkdown).toBe(`Body about ${B_TERM}.`);
    // B's own write key still works on B's article.
    const own = await agentArticlePatch(h.request(null, 'PATCH', `/api/agent/articles/${bArticleId}`, { expectedRevision: 1, title: 'Renamed' }, auth(bWrite)), params(bArticleId));
    expect(own.status).toBe(200);
  });

  it('rejects a body that is not an object', async () => {
    const res = await agentArticlePatch(h.request(null, 'PATCH', `/api/agent/articles/${aArticleId}`, [1], auth(aWrite)), params(aArticleId));
    expect(res.status).toBe(400);
  });
});

describe('agent API: surface', () => {
  it('has no route that approves, declines, publishes, checks, marks or connects (platform drafts only prepare, edit, preview, stage and ask)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = path.resolve(import.meta.dirname, '../src/app/api/agent');
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    const routes = walk(root).map((f) => path.relative(root, f).split(path.sep).join('/'));
    expect(routes.join(' ')).not.toMatch(/approve|decline|publish|hand-?off|connect|mark|check|resolve/i);
    expect(routes.filter((r) => /platform-drafts/.test(r)).sort()).toEqual([
      'platform-drafts/[id]/preview/route.ts',
      'platform-drafts/[id]/request-approval/route.ts',
      'platform-drafts/[id]/route.ts',
      'platform-drafts/[id]/stage/route.ts',
      'platform-drafts/[id]/status/route.ts',
      'platform-drafts/route.ts',
    ]);
  });
});
