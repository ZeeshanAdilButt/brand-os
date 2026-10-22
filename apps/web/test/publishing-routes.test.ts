import fs from 'node:fs';
import { sql } from 'drizzle-orm';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approvalChecklist, PLATFORM_IDS } from '../src/lib/publishing';
import { AGENT_SCOPES } from '../src/lib/agent';
import { PATCH as articlePatch } from '../src/app/api/articles/[id]/route';
import { POST as articlesPost } from '../src/app/api/articles/route';
import { POST as credentialsPost } from '../src/app/api/agent-credentials/route';
import { PATCH as agentArticlePatch } from '../src/app/api/agent/articles/[id]/route';
import {
  handleAgentDraftCreate,
  handleAgentDraftGet,
  handleAgentDraftRequestApproval,
  handleAgentDraftStage,
  handleAgentDraftStatus,
  handleAgentDraftsGet,
} from '../src/server/http/agent-handlers';
import {
  handleApprovalApprove,
  handleApprovalDecline,
  handleConnectionCreate,
  handleConnectionDelete,
  handleConnectionsGet,
  handleConnectionTest,
  handleDestinationsGet,
  handleDraftCheck,
  handleDraftCreate,
  handleDraftGet,
  handleDraftMark,
  handleDraftRequestApproval,
  handleDraftsGet,
  handleDraftStage,
} from '../src/server/http/publishing-handlers';
import { liveCanonical } from './helpers/canonical';
import { createFakeDevto, type FakeDevto } from './helpers/fake-devto';
import { sqlRows } from './helpers';
import { hostedHarness, HOSTED_URL, type HostedHarness, type TestUser } from './hosted-harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const json = async (res: Response) => (await res.json()) as Json;
const KEY = ['fake', 'devto', 'key', 'routes', '5e6f7a8b'].join('-');
const CHECKLIST = approvalChecklist('DEV.to', true);

let h: HostedHarness;
let a: TestUser;
let b: TestUser;
let fake: FakeDevto;
let aAgent: string;
let aReadOnly: string;
let bAgent: string;
let deps: { publish: { fetchFn: typeof fetch; canonical: ReturnType<typeof liveCanonical>; sleep: () => Promise<void>; timeoutMs: number } };
let counter = 0;

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const publishWrites = () => fake.requests.filter((r) => (r.body as { article?: { published?: boolean } } | null)?.article?.published === true);

function bearer(secret: string, method: string, path: string, body?: unknown): Request {
  const isRead = method === 'GET';
  return new Request(`${HOSTED_URL}${path}`, {
    method,
    headers: { host: new URL(HOSTED_URL).host, authorization: `Bearer ${secret}`, ...(isRead ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function mint(user: TestUser, name: string, scopes: string[]): Promise<string> {
  const res = await credentialsPost(h.request(user, 'POST', '/api/agent-credentials', { name, scopes }));
  return ((await res.json()) as { secret: string }).secret;
}

async function newArticle(user: TestUser, title?: string) {
  const res = await articlesPost(
    h.request(user, 'POST', '/api/articles', {
      title: title ?? `Routes article ${++counter}`,
      bodyMarkdown: 'The write path stalls when the log fills.\n',
      tags: ['go'],
      canonicalUrl: 'https://example-blog.dev/posts/stall',
    }),
  );
  expect(res.status).toBe(201);
  return json(res);
}

/** Prepare, stage and ask for approval as the signed-in user, through the routes. */
async function ready(user: TestUser) {
  const article = await newArticle(user);
  const created = await json(await handleDraftCreate(h.request(user, 'POST', '/api/platform-drafts', { articleId: article.id, platform: 'devto' }), deps));
  const staged = await handleDraftStage(h.request(user, 'POST', `/api/platform-drafts/${created.id}/stage`, {}), created.id, deps);
  expect((await json(staged)).ok).toBe(true);
  const asked = await json(await handleDraftRequestApproval(h.request(user, 'POST', `/api/platform-drafts/${created.id}/request-approval`, {}), created.id, deps));
  return { article, draftId: created.id as string, approvalId: asked.draft.approval.id as string, asked };
}

beforeAll(async () => {
  h = await hostedHarness({ appSecret: 'a-long-test-app-secret-0123456789abcdefghijklmnop' });
  a = await h.signUp('publish.a@example.test', 'Writer A');
  b = await h.signUp('publish.b@example.test', 'Writer B');
  fake = createFakeDevto({ apiKey: KEY });
  deps = { publish: { fetchFn: fake.fetch, canonical: liveCanonical(), sleep: async () => undefined, timeoutMs: 2000 } };
  aAgent = await mint(a, 'claude', ['read', 'write_articles', 'platform_drafts']);
  aReadOnly = await mint(a, 'reader', ['read']);
  bAgent = await mint(b, 'claude', ['read', 'platform_drafts']);
  for (const user of [a, b]) {
    const res = await handleConnectionCreate(h.request(user, 'POST', '/api/connections', { platform: 'devto', secret: KEY }), deps);
    expect(res.status).toBe(201);
  }
});

afterAll(async () => {
  await h.close();
});

describe('the publishing routes need a signed-in user', () => {
  it('answers 401 without a session', async () => {
    const id = '4f1b6c1e-9a3d-4e2b-8c55-0d7a1f2e3b4c';
    const results = await Promise.all([
      handleConnectionsGet(h.request(null, 'GET', '/api/connections'), deps),
      handleConnectionCreate(h.request(null, 'POST', '/api/connections', { platform: 'devto', secret: KEY }), deps),
      handleConnectionTest(h.request(null, 'POST', `/api/connections/${id}/test`, {}), id, deps),
      handleConnectionDelete(h.request(null, 'DELETE', `/api/connections/${id}`), id, deps),
      handleDestinationsGet(h.request(null, 'GET', `/api/articles/${id}/destinations`), id, deps),
      handleDraftsGet(h.request(null, 'GET', '/api/platform-drafts'), deps),
      handleDraftCreate(h.request(null, 'POST', '/api/platform-drafts', {}), deps),
      handleDraftGet(h.request(null, 'GET', `/api/platform-drafts/${id}`), id, deps),
      handleDraftStage(h.request(null, 'POST', `/api/platform-drafts/${id}/stage`, {}), id, deps),
      handleDraftRequestApproval(h.request(null, 'POST', `/api/platform-drafts/${id}/request-approval`, {}), id, deps),
      handleDraftCheck(h.request(null, 'POST', `/api/platform-drafts/${id}/check`, {}), id, deps),
      handleDraftMark(h.request(null, 'POST', `/api/platform-drafts/${id}/mark`, {}), id, deps),
      handleApprovalApprove(h.request(null, 'POST', `/api/approvals/${id}/approve`, {}), id, deps),
      handleApprovalDecline(h.request(null, 'POST', `/api/approvals/${id}/decline`, {}), id, deps),
    ]);
    expect(results.map((r) => r.status)).toEqual(new Array(results.length).fill(401));
  });
});

describe('connections through the routes', () => {
  it('never return the key, and keep it encrypted at rest', async () => {
    const list = await json(await handleConnectionsGet(h.request(a, 'GET', '/api/connections'), deps));
    const devto = list.connections.find((c: Json) => c.platform === 'devto');
    expect(devto.connection).toMatchObject({ status: 'connected', who: '@fakeauthor', keyLast4: KEY.slice(-4) });
    expect(JSON.stringify(list)).not.toContain(KEY);
    // The stored rows are checked too: there is at least one, and the key is nowhere in them in plain text.
    const rows = await sqlRows(h.handle.db, sql`select * from platform_connections`);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(rows)).not.toContain(KEY);
  });

  it('are private to each account', async () => {
    const aList = await json(await handleConnectionsGet(h.request(a, 'GET', '/api/connections'), deps));
    const aConnection = aList.connections.find((c: Json) => c.platform === 'devto').connection;
    const bList = await json(await handleConnectionsGet(h.request(b, 'GET', '/api/connections'), deps));
    const bConnection = bList.connections.find((c: Json) => c.platform === 'devto').connection;
    expect(aConnection.id).not.toBe(bConnection.id);
    expect((await handleConnectionTest(h.request(b, 'POST', `/api/connections/${aConnection.id}/test`, {}), aConnection.id, deps)).status).toBe(404);
    expect((await handleConnectionDelete(h.request(b, 'DELETE', `/api/connections/${aConnection.id}`), aConnection.id, deps)).status).toBe(404);
  });

  it('refuse a rejected key with a message that does not contain it', async () => {
    const res = await handleConnectionCreate(h.request(a, 'POST', '/api/connections', { platform: 'hashnode', secret: 'a-token-hashnode-does-not-know' }), {
      publish: { ...deps.publish, fetchFn: (async () => new Response(JSON.stringify({ data: null, errors: [{ message: 'no', extensions: { code: 'UNAUTHENTICATED' } }] }), { status: 200 })) as typeof fetch },
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await json(res))).not.toContain('a-token-hashnode-does-not-know');
  });
});

describe('the whole flow through the routes', () => {
  it('prepares, stages, asks, approves and publishes, then shows the link', async () => {
    const { article, draftId, approvalId, asked } = await ready(a);
    expect(asked.draft.status).toBe('pending_approval');
    expect(asked.link).toContain(`/articles/${article.id}`);
    fake.requests.length = 0;
    const res = await handleApprovalApprove(h.request(a, 'POST', `/api/approvals/${approvalId}/approve`, { checked: CHECKLIST }), approvalId, deps);
    expect(res.status).toBe(200);
    const done = await json(res);
    expect(done.outcome).toBe('published');
    expect(done.draft.remoteUrl).toContain(fake.origin);
    expect(publishWrites()).toHaveLength(1);
    const again = await json(await handleDraftGet(h.request(a, 'GET', `/api/platform-drafts/${draftId}`), draftId, deps));
    expect(again.status).toBe('published');
    const destinations = await json(await handleDestinationsGet(h.request(a, 'GET', `/api/articles/${article.id}/destinations`), article.id, deps));
    expect(destinations.destinations[0].draft.status).toBe('published');
  });

  it('answers a second approve with 409 and sends nothing', async () => {
    const { approvalId } = await ready(a);
    await handleApprovalApprove(h.request(a, 'POST', `/api/approvals/${approvalId}/approve`, { checked: CHECKLIST }), approvalId, deps);
    fake.requests.length = 0;
    const res = await handleApprovalApprove(h.request(a, 'POST', `/api/approvals/${approvalId}/approve`, { checked: CHECKLIST }), approvalId, deps);
    expect(res.status).toBe(409);
    expect(fake.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
  });

  it('voids the approval when the article is edited through the editor route', async () => {
    const { article, draftId, approvalId } = await ready(a);
    const saved = await articlePatch(h.request(a, 'PATCH', `/api/articles/${article.id}`, { expectedRevision: article.revision, bodyMarkdown: 'Changed after I asked.' }), params(article.id));
    expect(saved.status).toBe(200);
    const view = await json(await handleDraftGet(h.request(a, 'GET', `/api/platform-drafts/${draftId}`), draftId, deps));
    expect(view).toMatchObject({ status: 'source_changed', stale: true });
    expect(view.approval.status).toBe('invalidated');
    fake.requests.length = 0;
    const res = await handleApprovalApprove(h.request(a, 'POST', `/api/approvals/${approvalId}/approve`, { checked: CHECKLIST }), approvalId, deps);
    expect(res.status).toBe(409);
    expect(publishWrites()).toHaveLength(0);
  });

  it('voids the approval when an agent edits the article', async () => {
    const { article, draftId } = await ready(a);
    const res = await agentArticlePatch(bearer(aAgent, 'PATCH', `/api/agent/articles/${article.id}`, { expectedRevision: article.revision, title: 'Agent retitled this' }), params(article.id));
    expect(res.status).toBe(200);
    const view = await json(await handleDraftGet(h.request(a, 'GET', `/api/platform-drafts/${draftId}`), draftId, deps));
    expect(view.status).toBe('source_changed');
  });
});

describe('approving is only for a signed-in browser', () => {
  it('refuses a request that carries an Authorization header, even with a valid session', async () => {
    const { approvalId } = await ready(a);
    fake.requests.length = 0;
    const res = await handleApprovalApprove(h.request(a, 'POST', `/api/approvals/${approvalId}/approve`, { checked: CHECKLIST }, { authorization: `Bearer ${aAgent}` }), approvalId, deps);
    expect(res.status).toBe(403);
    expect(fake.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
  });

  it('refuses a request that does not say where it came from', async () => {
    const { approvalId, draftId } = await ready(a);
    const bare = new Request(`${HOSTED_URL}/api/approvals/${approvalId}/approve`, {
      method: 'POST',
      headers: { host: new URL(HOSTED_URL).host, cookie: a.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ checked: CHECKLIST }),
    });
    fake.requests.length = 0;
    expect((await handleApprovalApprove(bare, approvalId, deps)).status).toBe(403);
    expect(fake.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
    expect((await json(await handleDraftGet(h.request(a, 'GET', `/api/platform-drafts/${draftId}`), draftId, deps))).approval.status).toBe('pending');
  });

  it('refuses a cross-site request', async () => {
    const { approvalId } = await ready(a);
    const res = await handleApprovalApprove(h.request(a, 'POST', `/api/approvals/${approvalId}/approve`, { checked: CHECKLIST }, { origin: 'https://evil.example' }), approvalId, deps);
    expect(res.status).toBe(403);
  });

  it('refuses a credential alone: no session means 401', async () => {
    const { approvalId } = await ready(a);
    const res = await handleApprovalApprove(bearer(aAgent, 'POST', `/api/approvals/${approvalId}/approve`, { checked: CHECKLIST }), approvalId, deps);
    expect(res.status).toBe(401);
  });

  it('keeps decline and mark-by-hand browser-only too', async () => {
    const { approvalId, draftId } = await ready(a);
    expect((await handleApprovalDecline(h.request(a, 'POST', `/api/approvals/${approvalId}/decline`, {}, { authorization: `Bearer ${aAgent}` }), approvalId, deps)).status).toBe(403);
    expect((await handleDraftMark(h.request(a, 'POST', `/api/platform-drafts/${draftId}/mark`, { outcome: 'posted', confirm: true }, { authorization: `Bearer ${aAgent}` }), draftId, deps)).status).toBe(403);
  });
});

describe('the agent API for platform drafts', () => {
  it('prepares, stages privately and asks for approval, and cannot do more', async () => {
    const article = await newArticle(a);
    const created = await handleAgentDraftCreate(bearer(aAgent, 'POST', '/api/agent/platform-drafts', { articleId: article.id, platform: 'devto' }), deps);
    expect(created.status).toBe(201);
    const draft = await json(created);
    expect(draft).toMatchObject({ status: 'draft', hasLintErrors: false });
    expect(draft.requestPreview).toContain('"published": true');
    expect(draft).not.toHaveProperty('remoteId');

    fake.requests.length = 0;
    const staged = await json(await handleAgentDraftStage(bearer(aAgent, 'POST', `/api/agent/platform-drafts/${draft.id}/stage`, {}), draft.id, deps));
    expect(staged.ok).toBe(true);
    expect(staged.draft.status).toBe('staged');
    expect(publishWrites()).toHaveLength(0);

    const asked = await handleAgentDraftRequestApproval(bearer(aAgent, 'POST', `/api/agent/platform-drafts/${draft.id}/request-approval`, {}), draft.id, deps);
    expect(asked.status).toBe(201);
    const askedBody = await json(asked);
    expect(askedBody.link).toContain(`/articles/${article.id}`);
    expect(askedBody.approval).toMatchObject({ status: 'pending' });
    expect(askedBody.note).toMatch(/Only the owner can approve/);
    expect(JSON.stringify(askedBody)).not.toMatch(/approvalId|"id"/);

    const status = await json(await handleAgentDraftStatus(bearer(aAgent, 'GET', `/api/agent/platform-drafts/${draft.id}/status`), draft.id, deps));
    expect(status).toMatchObject({ status: 'pending_approval', approval: { status: 'pending' } });
    const list = await json(await handleAgentDraftsGet(bearer(aAgent, 'GET', `/api/agent/platform-drafts?articleId=${article.id}`), deps));
    expect(list.drafts.map((d: Json) => d.id)).toContain(draft.id);
    expect(publishWrites()).toHaveLength(0);
  });

  it('needs the platform_drafts scope to write and read to read', async () => {
    const article = await newArticle(a);
    expect((await handleAgentDraftCreate(bearer(aReadOnly, 'POST', '/api/agent/platform-drafts', { articleId: article.id, platform: 'devto' }), deps)).status).toBe(403);
    const draft = await json(await handleAgentDraftCreate(bearer(aAgent, 'POST', '/api/agent/platform-drafts', { articleId: article.id, platform: 'devto' }), deps));
    expect((await handleAgentDraftGet(bearer(aReadOnly, 'GET', `/api/agent/platform-drafts/${draft.id}`), draft.id, deps)).status).toBe(200);
    expect((await handleAgentDraftStage(bearer(aReadOnly, 'POST', `/api/agent/platform-drafts/${draft.id}/stage`, {}), draft.id, deps)).status).toBe(403);
    expect((await handleAgentDraftRequestApproval(bearer(aReadOnly, 'POST', `/api/agent/platform-drafts/${draft.id}/request-approval`, {}), draft.id, deps)).status).toBe(403);
    expect((await handleAgentDraftsGet(bearer(aReadOnly, 'GET', '/api/agent/platform-drafts'), deps)).status).toBe(200);
  });

  it('shows lint errors and refuses to stage or ask while they exist', async () => {
    const res = await articlesPost(h.request(a, 'POST', '/api/articles', { title: 'Has a local image', bodyMarkdown: '![x](asset:3c1f4f0e-0000-4000-8000-000000000000)\n', canonicalUrl: 'https://example-blog.dev/p/x' }));
    const article = await json(res);
    const draft = await json(await handleAgentDraftCreate(bearer(aAgent, 'POST', '/api/agent/platform-drafts', { articleId: article.id, platform: 'devto' }), deps));
    expect(draft.hasLintErrors).toBe(true);
    expect(draft.lint.find((i: Json) => i.code === 'image_local').message).toContain('only exists on your machine');
    expect((await handleAgentDraftStage(bearer(aAgent, 'POST', `/api/agent/platform-drafts/${draft.id}/stage`, {}), draft.id, deps)).status).toBe(400);
    expect((await handleAgentDraftRequestApproval(bearer(aAgent, 'POST', `/api/agent/platform-drafts/${draft.id}/request-approval`, {}), draft.id, deps)).status).toBeGreaterThanOrEqual(400);
  });

  it('never returns a key, a remote id or an owner id', async () => {
    const { draftId } = await ready(a);
    const bodies = [
      await (await handleAgentDraftGet(bearer(aAgent, 'GET', `/api/agent/platform-drafts/${draftId}`), draftId, deps)).text(),
      await (await handleAgentDraftStatus(bearer(aAgent, 'GET', `/api/agent/platform-drafts/${draftId}/status`), draftId, deps)).text(),
      await (await handleAgentDraftsGet(bearer(aAgent, 'GET', '/api/agent/platform-drafts'), deps)).text(),
    ].join('\n');
    expect(bodies).not.toContain(KEY);
    expect(bodies).not.toMatch(/ownerId|owner_id|encryptedKey|remoteId/);
    expect(bodies).not.toContain(a.userId);
  });
});

describe('agents can never approve or publish, by any route', () => {
  const srcRoot = path.resolve(import.meta.dirname, '..', 'src');

  function routeFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) routeFiles(full, out);
      else if (entry.name === 'route.ts') out.push(path.relative(srcRoot, full).split(path.sep).join('/'));
    }
    return out;
  }

  it('has no agent route whose path says approve, publish, decline, check, mark, connect or hand off', () => {
    const agentRoutes = routeFiles(path.join(srcRoot, 'app', 'api', 'agent'));
    expect(agentRoutes.length).toBeGreaterThan(8);
    for (const route of agentRoutes) expect(route, route).not.toMatch(/approve|publish(?!ing)|decline|hand-?off|connect|mark|check|resolve/i);
  });

  it('exports no agent handler for approving or publishing', async () => {
    const mod = await import('../src/server/http/agent-handlers');
    expect(Object.keys(mod).filter((name) => /approve(?!l)|publish|decline|handoff|connect|mark/i.test(name))).toEqual([]);
    // The one handler that mentions approval only opens a request.
    expect(Object.keys(mod)).toContain('handleAgentDraftRequestApproval');
  });

  it('has no scope that grants approving or publishing', () => {
    expect([...AGENT_SCOPES].filter((scope) => /approve|publish|admin|all/i.test(scope))).toEqual([]);
  });

  it('every agent platform handler is wrapped in the agent guard (a missing credential is 401)', async () => {
    const id = '4f1b6c1e-9a3d-4e2b-8c55-0d7a1f2e3b4c';
    const anonymous = (method: string, p: string) => new Request(`${HOSTED_URL}${p}`, { method, headers: { host: new URL(HOSTED_URL).host }, ...(method === 'GET' ? {} : { body: '{}' }) });
    const results = await Promise.all([
      handleAgentDraftsGet(anonymous('GET', '/api/agent/platform-drafts'), deps),
      handleAgentDraftCreate(anonymous('POST', '/api/agent/platform-drafts'), deps),
      handleAgentDraftGet(anonymous('GET', `/api/agent/platform-drafts/${id}`), id, deps),
      handleAgentDraftStatus(anonymous('GET', `/api/agent/platform-drafts/${id}/status`), id, deps),
      handleAgentDraftStage(anonymous('POST', `/api/agent/platform-drafts/${id}/stage`), id, deps),
      handleAgentDraftRequestApproval(anonymous('POST', `/api/agent/platform-drafts/${id}/request-approval`), id, deps),
    ]);
    expect(results.map((r) => r.status)).toEqual(new Array(6).fill(401));
  });

  it('a credential tried on every session-only publishing route is refused', async () => {
    const { draftId, approvalId } = await ready(a);
    fake.requests.length = 0;
    const attempts: [string, Promise<Response>][] = [
      ['approve', handleApprovalApprove(bearer(aAgent, 'POST', `/api/approvals/${approvalId}/approve`, { checked: CHECKLIST }), approvalId, deps)],
      ['decline', handleApprovalDecline(bearer(aAgent, 'POST', `/api/approvals/${approvalId}/decline`, {}), approvalId, deps)],
      ['check', handleDraftCheck(bearer(aAgent, 'POST', `/api/platform-drafts/${draftId}/check`, {}), draftId, deps)],
      ['mark', handleDraftMark(bearer(aAgent, 'POST', `/api/platform-drafts/${draftId}/mark`, { outcome: 'posted', confirm: true }), draftId, deps)],
      ['connect', handleConnectionCreate(bearer(aAgent, 'POST', '/api/connections', { platform: 'devto', secret: KEY }), deps)],
      ['stage', handleDraftStage(bearer(aAgent, 'POST', `/api/platform-drafts/${draftId}/stage`, {}), draftId, deps)],
    ];
    for (const [name, result] of attempts) expect((await result).status, name).toBe(401);
    expect(fake.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
    expect(PLATFORM_IDS.length).toBeGreaterThan(1);
  });
});

describe('tenant isolation through the routes and the agent API', () => {
  it('another account gets 404 for every route and sees nothing', async () => {
    const { article, draftId, approvalId } = await ready(a);
    fake.requests.length = 0;
    const attempts: [string, Response][] = [
      ['get', await handleDraftGet(h.request(b, 'GET', `/api/platform-drafts/${draftId}`), draftId, deps)],
      ['stage', await handleDraftStage(h.request(b, 'POST', `/api/platform-drafts/${draftId}/stage`, {}), draftId, deps)],
      ['ask', await handleDraftRequestApproval(h.request(b, 'POST', `/api/platform-drafts/${draftId}/request-approval`, {}), draftId, deps)],
      ['check', await handleDraftCheck(h.request(b, 'POST', `/api/platform-drafts/${draftId}/check`, {}), draftId, deps)],
      ['mark', await handleDraftMark(h.request(b, 'POST', `/api/platform-drafts/${draftId}/mark`, { outcome: 'posted', confirm: true }), draftId, deps)],
      ['approve', await handleApprovalApprove(h.request(b, 'POST', `/api/approvals/${approvalId}/approve`, { checked: CHECKLIST }), approvalId, deps)],
      ['prepare', await handleDraftCreate(h.request(b, 'POST', '/api/platform-drafts', { articleId: article.id, platform: 'devto' }), deps)],
      ['destinations', await handleDestinationsGet(h.request(b, 'GET', `/api/articles/${article.id}/destinations`), article.id, deps)],
      ['agent get', await handleAgentDraftGet(bearer(bAgent, 'GET', `/api/agent/platform-drafts/${draftId}`), draftId, deps)],
      ['agent status', await handleAgentDraftStatus(bearer(bAgent, 'GET', `/api/agent/platform-drafts/${draftId}/status`), draftId, deps)],
      ['agent stage', await handleAgentDraftStage(bearer(bAgent, 'POST', `/api/agent/platform-drafts/${draftId}/stage`, {}), draftId, deps)],
      ['agent ask', await handleAgentDraftRequestApproval(bearer(bAgent, 'POST', `/api/agent/platform-drafts/${draftId}/request-approval`, {}), draftId, deps)],
      ['agent prepare', await handleAgentDraftCreate(bearer(bAgent, 'POST', '/api/agent/platform-drafts', { articleId: article.id, platform: 'devto' }), deps)],
    ];
    for (const [name, response] of attempts) expect(response.status, name).toBe(404);
    expect(fake.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);

    const bList = await json(await handleDraftsGet(h.request(b, 'GET', '/api/platform-drafts'), deps));
    expect(bList.drafts.map((d: Json) => d.id)).not.toContain(draftId);
    const bAgentList = await json(await handleAgentDraftsGet(bearer(bAgent, 'GET', '/api/agent/platform-drafts'), deps));
    expect(bAgentList.drafts.map((d: Json) => d.id)).not.toContain(draftId);
    // A's draft is untouched.
    expect((await json(await handleDraftGet(h.request(a, 'GET', `/api/platform-drafts/${draftId}`), draftId, deps))).status).toBe('pending_approval');
  });

  it('an agent key of one account cannot act on the other account by passing its ids', async () => {
    const mine = await newArticle(b);
    const theirs = await newArticle(a);
    expect((await handleAgentDraftCreate(bearer(bAgent, 'POST', '/api/agent/platform-drafts', { articleId: theirs.id, platform: 'devto', ownerId: a.userId }), deps)).status).toBe(404);
    expect((await handleAgentDraftCreate(bearer(bAgent, 'POST', '/api/agent/platform-drafts', { articleId: mine.id, platform: 'devto', ownerId: a.userId }), deps)).status).toBe(201);
  });
});
