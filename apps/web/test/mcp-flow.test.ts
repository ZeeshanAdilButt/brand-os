import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrandApi } from '../../../packages/brand-mcp/src/api';
import { createBrandServer } from '../../../packages/brand-mcp/src/server';
import { DELETE as credentialDelete } from '../src/app/api/agent-credentials/[id]/route';
import { POST as credentialsPost } from '../src/app/api/agent-credentials/route';
import { GET as taskResultGet } from '../src/app/api/agent/ai-tasks/[id]/route';
import { POST as taskResultPost } from '../src/app/api/agent/ai-tasks/[id]/result/route';
import { GET as tasksGet } from '../src/app/api/agent/ai-tasks/route';
import { GET as articleGet, PATCH as articlePatch } from '../src/app/api/agent/articles/[id]/route';
import { GET as articlesGet, POST as articlesPost } from '../src/app/api/agent/articles/route';
import { GET as knowledgeGet } from '../src/app/api/agent/knowledge/route';
import { GET as meGet } from '../src/app/api/agent/me/route';
import { forOwner } from '../src/server/data/tenant';
import {
  handleAgentDraftCreate,
  handleAgentDraftGet,
  handleAgentDraftRequestApproval,
  handleAgentDraftsGet,
  handleAgentDraftStage,
  handleAgentDraftStatus,
} from '../src/server/http/agent-handlers';
import { handleConnectionCreate } from '../src/server/http/publishing-handlers';
import { createFakeDevto, type FakeDevto } from './helpers/fake-devto';
import { handleProviderCreate, handleTaskAccept, handleTaskCreate } from '../src/server/http/ai-handlers';
import { hostedHarness, HOSTED_URL, type HostedHarness, type TestUser } from './hosted-harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const json = async (res: Response) => (await res.json()) as Json;

const A_TERM = 'pelicanforgextra';
const B_TERM = 'marmotsilverqq';
const SELECTED = 'The queue is long. We measured it twice.';
const BODY = `# Queues\n\n${SELECTED}\n\nMore text.\n`;

let h: HostedHarness;
let a: TestUser;
let b: TestUser;
let aCred: string;
let aReadOnly: string;
let aArticle: string;
let bArticle: string;
let aTask: string;
let bTask: string;
let fake: FakeDevto;
const FAKE_KEY = ['fake', 'devto', 'key', 'mcp', '77aa88bb'].join('-');
const publishDeps = () => ({ publish: { fetchFn: fake.fetch, sleep: async () => undefined, timeoutMs: 2000 } });

/** The agent API as the MCP server's HTTP client sees it, served by the real route handlers in this process. */
const bridge = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(String(input));
  const headers = new Headers(init?.headers);
  headers.set('host', new URL(HOSTED_URL).host);
  const request = new Request(`${HOSTED_URL}${url.pathname}${url.search}`, { method: init?.method ?? 'GET', headers, ...(init?.body ? { body: String(init.body) } : {}) });
  const seg = url.pathname.replace('/api/agent/', '').split('/');
  const method = request.method;
  const id = seg[1] ?? '';
  const ctx = { params: Promise.resolve({ id }) };
  if (seg[0] === 'me') return meGet(request);
  if (seg[0] === 'knowledge') return knowledgeGet(request);
  if (seg[0] === 'articles' && !seg[1]) return method === 'POST' ? articlesPost(request) : articlesGet(request);
  if (seg[0] === 'articles') return method === 'PATCH' ? articlePatch(request, ctx) : articleGet(request, ctx);
  if (seg[0] === 'ai-tasks' && !seg[1]) return tasksGet(request);
  if (seg[0] === 'ai-tasks' && seg[2] === 'result') return taskResultPost(request, ctx);
  if (seg[0] === 'ai-tasks') return taskResultGet(request, ctx);
  if (seg[0] === 'platform-drafts' && !seg[1]) return method === 'POST' ? handleAgentDraftCreate(request, publishDeps()) : handleAgentDraftsGet(request, publishDeps());
  if (seg[0] === 'platform-drafts' && seg[2] === 'stage') return handleAgentDraftStage(request, id, publishDeps());
  if (seg[0] === 'platform-drafts' && seg[2] === 'request-approval') return handleAgentDraftRequestApproval(request, id, publishDeps());
  if (seg[0] === 'platform-drafts' && seg[2] === 'status') return handleAgentDraftStatus(request, id, publishDeps());
  if (seg[0] === 'platform-drafts') return handleAgentDraftGet(request, id, publishDeps());
  return new Response('not found', { status: 404 });
}) as typeof fetch;

async function mint(user: TestUser, scopes: string[]) {
  return ((await json(await credentialsPost(h.request(user, 'POST', '/api/agent-credentials', { name: 'claude', scopes })))) as { secret: string; credential: { id: string } });
}

const closers: (() => Promise<void>)[] = [];
async function connect(secret: string) {
  const server = createBrandServer({ api: createBrandApi({ baseUrl: 'http://127.0.0.1:3100', credential: secret, fetchFn: bridge }), credential: secret });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  closers.push(() => client.close());
  return client;
}
type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  const text = result.content.map((c) => c.text).join('\n');
  return { text, isError: result.isError === true, data: result.isError ? null : (JSON.parse(text) as Json) };
}

beforeAll(async () => {
  h = await hostedHarness({ appSecret: 'a-long-test-app-secret-0123456789abcdefghijklmnop' });
  a = await h.signUp('mcp.a@example.test', 'Writer A');
  b = await h.signUp('mcp.b@example.test', 'Writer B');
  fake = createFakeDevto({ apiKey: FAKE_KEY });
  aCred = (await mint(a, ['read', 'write_articles', 'ai_tasks', 'platform_drafts'])).secret;
  aReadOnly = (await mint(a, ['read'])).secret;

  const aData = forOwner(a.userId, h.ctx.db);
  const bData = forOwner(b.userId, h.ctx.db);
  aArticle = (await aData.articles.create({ title: `Alpha ${A_TERM}`, slug: 'alpha', bodyMarkdown: BODY })).id;
  bArticle = (await bData.articles.create({ title: `Beta ${B_TERM}`, slug: 'beta', bodyMarkdown: BODY })).id;
  const note = { kind: 'note' as const, tags: [], sourceId: null, sourceDate: null, verificationStatus: 'verified' as const, confidence: 'high' as const, confidentiality: 'private' as const, publicUsePermitted: false };
  await aData.items.create({ ...note, title: `A note ${A_TERM}`, body: `About ${A_TERM}.` });
  await bData.items.create({ ...note, title: `B note ${B_TERM}`, body: `About ${B_TERM}.` });
  await bData.profile.upsert({ name: 'Person B', headline: `Headline ${B_TERM}`, yearsExperience: null, location: null, careerGoals: null, targetEmployers: [], expertiseAreas: [] });
  await aData.profile.upsert({ name: 'Person A', headline: null, yearsExperience: null, location: null, careerGoals: null, targetEmployers: [], expertiseAreas: [] });

  // Each person has a hand-off provider and one waiting task.
  for (const [user, article, assign] of [
    [a, aArticle, (id: string) => (aTask = id)],
    [b, bArticle, (id: string) => (bTask = id)],
  ] as const) {
    await handleProviderCreate(h.request(user, 'POST', '/api/ai/providers', { kind: 'claude_code_handoff', name: 'Claude Code' }));
    const start = BODY.indexOf(SELECTED);
    const res = await handleTaskCreate(
      h.request(user, 'POST', '/api/ai/tasks', { articleId: article, kind: 'improve_section', expectedRevision: 1, selection: { start, end: start + SELECTED.length, text: SELECTED } }),
      { schedule: () => {}, ai: {} },
    );
    expect(res.status).toBe(201);
    assign((await json(res)).id);
  }
});

afterAll(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await h.close();
});

describe('Claude Code over MCP, end to end against the real routes', () => {
  it('reads the profile, articles and knowledge of its own account only', async () => {
    const client = await connect(aCred);
    const me = await call(client, 'get_my_profile');
    expect(me.data?.profile.name).toBe('Person A');
    expect(me.text).not.toContain(a.userId);
    const list = await call(client, 'list_articles', {});
    expect(list.data?.articles.map((x: Json) => x.id)).toEqual([aArticle]);
    expect(list.text).not.toContain(B_TERM);
    const knowledge = await call(client, 'search_knowledge', { query: A_TERM });
    expect(knowledge.data?.items).toHaveLength(1);
    expect((await call(client, 'search_knowledge', { query: B_TERM })).data?.items).toEqual([]);
    const article = await call(client, 'get_article', { id: aArticle });
    expect(article.data).toMatchObject({ id: aArticle, revision: 1 });
  });

  it('cannot read, change, or complete anything of another account, even holding its ids', async () => {
    const client = await connect(aCred);
    const read = await call(client, 'get_article', { id: bArticle });
    expect(read).toMatchObject({ isError: true, text: 'Not found for this account.' });
    const edit = await call(client, 'update_article', { id: bArticle, expectedRevision: 1, bodyMarkdown: 'Hijacked.' });
    expect(edit.isError).toBe(true);
    expect((await forOwner(b.userId, h.ctx.db).articles.get(bArticle))?.bodyMarkdown).toBe(BODY);
    expect(await call(client, 'get_ai_task', { id: bTask })).toMatchObject({ isError: true, text: 'Not found for this account.' });
    const submit = await call(client, 'submit_ai_task_result', { taskId: bTask, operations: [{ type: 'replace_range', original: SELECTED, proposed: 'Hijacked.' }] });
    expect(submit.isError).toBe(true);
    expect((await forOwner(b.userId, h.ctx.db).tasks.get(bTask))?.status).toBe('pending');
    const tasks = await call(client, 'list_ai_tasks', {});
    expect(tasks.data?.tasks.map((t: Json) => t.id)).toEqual([aTask]);
  });

  it('ignores an owner id smuggled into any argument', async () => {
    const client = await connect(aCred);
    const list = await call(client, 'list_articles', { ownerId: b.userId, owner_id: b.userId, userId: b.userId });
    expect(list.data?.articles.map((x: Json) => x.id)).toEqual([aArticle]);
    const knowledge = await call(client, 'search_knowledge', { query: B_TERM, ownerId: b.userId });
    expect(knowledge.data?.items).toEqual([]);
    const created = await call(client, 'create_article', { title: 'Mine', bodyMarkdown: 'x', ownerId: b.userId });
    expect(created.isError).toBe(false);
    expect(await forOwner(a.userId, h.ctx.db).articles.get(created.data?.id)).not.toBeNull();
    expect(await forOwner(b.userId, h.ctx.db).articles.get(created.data?.id)).toBeNull();
  });

  it('writes with optimistic concurrency and leaves a version for the owner', async () => {
    const client = await connect(aCred);
    const read = await call(client, 'get_article', { id: aArticle });
    const saved = await call(client, 'update_article', { id: aArticle, expectedRevision: read.data?.revision, title: 'Alpha, edited by Claude Code' });
    expect(saved.data).toMatchObject({ title: 'Alpha, edited by Claude Code', revision: 2 });
    expect(saved.data).not.toHaveProperty('bodyMarkdown');
    const stale = await call(client, 'update_article', { id: aArticle, expectedRevision: 1, title: 'Late' });
    expect(stale.isError).toBe(true);
    expect(stale.text).toMatch(/current revision is 2/);
    const versions = await forOwner(a.userId, h.ctx.db).articles.listVersions(aArticle);
    expect(versions.some((v) => v.reason === 'agent')).toBe(true);
  });

  it('respects scopes', async () => {
    const client = await connect(aReadOnly);
    expect((await call(client, 'list_articles', {})).isError).toBe(false);
    const write = await call(client, 'create_article', { title: 'No' });
    expect(write).toMatchObject({ isError: true });
    expect(write.text).toMatch(/write_articles/);
    const submit = await call(client, 'submit_ai_task_result', { taskId: aTask, operations: [{ type: 'replace_range', original: SELECTED, proposed: 'x' }] });
    expect(submit.text).toMatch(/ai_tasks/);
  });

  it('completes a hand-off task, which then waits for the owner to accept it', async () => {
    const client = await connect(aCred);
    const waiting = await call(client, 'list_ai_tasks', {});
    expect(waiting.data?.tasks.map((t: Json) => t.id)).toContain(aTask);
    const task = await call(client, 'get_ai_task', { id: aTask });
    expect(task.data).toMatchObject({ kind: 'improve_section', excerpt: SELECTED, status: 'pending' });
    expect(task.data?.allowedOperations).toEqual(['replace_range', 'review_notes']);

    // An answer outside the excerpt is refused by the app.
    const outside = await call(client, 'submit_ai_task_result', { taskId: aTask, operations: [{ type: 'replace_range', original: 'More text.', proposed: 'x' }] });
    expect(outside.isError).toBe(true);
    expect(outside.text).toMatch(/copied exactly from the task excerpt/);

    const proposed = 'The queue is long; we measured it twice.';
    const done = await call(client, 'submit_ai_task_result', { taskId: aTask, operations: [{ type: 'replace_range', original: SELECTED, proposed, rationale: 'One sentence.' }] });
    expect(done.data).toEqual({ id: aTask, status: 'needs_review' });
    expect(await call(client, 'submit_ai_task_result', { taskId: aTask, operations: [{ type: 'replace_range', original: SELECTED, proposed }] })).toMatchObject({ isError: true });

    // Nothing was applied by submitting; the owner decides.
    const article = await forOwner(a.userId, h.ctx.db).articles.get(aArticle);
    expect(article?.bodyMarkdown).toContain(SELECTED);
    const accepted = await handleTaskAccept(h.request(a, 'POST', `/api/ai/tasks/${aTask}/accept`, { expectedRevision: article!.revision }), aTask, {});
    expect(accepted.status).toBe(200);
    expect((await forOwner(a.userId, h.ctx.db).articles.get(aArticle))?.bodyMarkdown).toContain(proposed);
  });

  it('prepares, stages privately and asks for approval over MCP, and publishes nothing', async () => {
    expect((await handleConnectionCreate(h.request(a, 'POST', '/api/connections', { platform: 'devto', secret: FAKE_KEY }), publishDeps())).status).toBe(201);
    const client = await connect(aCred);
    const made = await call(client, 'create_article', { title: 'MCP publishing flow', bodyMarkdown: 'Some text about queues.', tags: ['go'] });
    const articleId = made.data?.id as string;
    expect(articleId).toBeTruthy();
    const draft = await call(client, 'create_platform_draft', { articleId, platform: 'devto' });
    expect(draft.isError).toBe(false);
    const draftId = draft.data?.id as string;
    expect(draft.data).toMatchObject({ status: 'draft', platform: 'devto' });
    expect(draft.data?.lint.some((i: Json) => i.code === 'canonical_missing')).toBe(true);

    const staged = await call(client, 'stage_remote_draft', { draftId });
    expect(staged.data).toMatchObject({ ok: true });
    expect(fake.articles.size).toBe(1);
    expect([...fake.articles.values()][0]!.published).toBe(false);

    const asked = await call(client, 'request_publish_approval', { draftId });
    expect(asked.data?.link).toContain(`/articles/${articleId}`);
    expect(asked.data?.note).toMatch(/Only the owner can approve/);

    const status = await call(client, 'get_publication_status', { draftId });
    expect(status.data).toMatchObject({ status: 'pending_approval', approval: { status: 'pending' } });
    const listed = await call(client, 'list_platform_drafts', { articleId });
    expect(listed.data?.drafts).toHaveLength(1);
    expect((await call(client, 'get_platform_draft', { id: draftId })).data?.requestPreview).toContain('"published": true');

    // Nothing is public: the only writes were the private create.
    expect(fake.requests.filter((r) => (r.body as { article?: { published?: boolean } } | null)?.article?.published === true)).toHaveLength(0);
    expect([...fake.articles.values()].every((x) => !x.published)).toBe(true);
  });

  it('cannot see another account’s drafts over MCP', async () => {
    const client = await connect(aCred);
    const bClient = await connect((await mint(b, ['read', 'platform_drafts'])).secret);
    const mine = await call(client, 'list_platform_drafts', {});
    expect(mine.data?.drafts.length).toBeGreaterThan(0);
    const theirs = await call(bClient, 'list_platform_drafts', {});
    expect(theirs.data?.drafts).toEqual([]);
    const id = mine.data?.drafts[0].id as string;
    for (const tool of ['get_platform_draft']) expect((await call(bClient, tool, { id })).isError).toBe(true);
    for (const tool of ['stage_remote_draft', 'request_publish_approval', 'get_publication_status']) expect((await call(bClient, tool, { draftId: id })).isError, tool).toBe(true);
  });

  it('stops working the moment the owner revokes the credential', async () => {
    const made = await mint(a, ['read']);
    const client = await connect(made.secret);
    expect((await call(client, 'get_my_profile')).isError).toBe(false);
    await credentialDelete(h.request(a, 'DELETE', `/api/agent-credentials/${made.credential.id}`), { params: Promise.resolve({ id: made.credential.id }) });
    const after = await call(client, 'get_my_profile');
    expect(after.isError).toBe(true);
    expect(after.text).toMatch(/revoked/);
    expect(after.text).not.toContain(made.secret);
  });

  it('never shows the credential or an owner id in any result', async () => {
    const client = await connect(aCred);
    const everything = [
      await call(client, 'get_my_profile'),
      await call(client, 'list_articles', {}),
      await call(client, 'get_article', { id: aArticle }),
      await call(client, 'search_knowledge', { query: A_TERM }),
      await call(client, 'list_ai_tasks', { status: ['pending', 'running', 'needs_review', 'accepted', 'rejected', 'failed'] }),
      await call(client, 'get_ai_task', { id: aTask }),
    ]
      .map((r) => r.text)
      .join('\n');
    expect(everything).not.toContain(aCred);
    expect(everything).not.toContain(a.userId);
    expect(everything).not.toContain(b.userId);
    expect(everything).not.toMatch(/ownerId|owner_id|secretHash|encryptedKey/);
  });
});
