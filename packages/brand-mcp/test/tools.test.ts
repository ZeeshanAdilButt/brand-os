import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type BrandApi } from '../src/api.js';
import { buildServer, readSettings } from '../src/index.js';
import { createBrandServer, errorText, INSTRUCTIONS, NOT_CONFIGURED_TEXT, sanitize } from '../src/server.js';

const CREDENTIAL = `bos_${'A1b2C3d4'.repeat(5)}x`;
const ID = '4f1b6c1e-9a3d-4e2b-8c55-0d7a1f2e3b4c';
const TASK = '0b8d2a77-5c1e-4a6f-9d33-7e1c2b4a5f60';

const EXPECTED_TOOLS = [
  'get_my_profile',
  'search_knowledge',
  'list_articles',
  'get_article',
  'create_article',
  'update_article',
  'list_ai_tasks',
  'get_ai_task',
  'submit_ai_task_result',
  'create_platform_draft',
  'list_platform_drafts',
  'get_platform_draft',
  'stage_remote_draft',
  'request_publish_approval',
  'get_publication_status',
];

/** Verbs that act as the owner. No tool may be named like one. */
const OWNER_ONLY_VERBS = /^(approve|decline|deny|publish|hand_?off|mark|check_on|connect|disconnect|resolve|post|schedule|send)/;

type Fake = { [K in keyof BrandApi]: ReturnType<typeof vi.fn> } & BrandApi;

function fakeApi(overrides: Partial<BrandApi> = {}): Fake {
  const names: (keyof BrandApi)[] = [
    'me',
    'searchKnowledge',
    'listArticles',
    'getArticle',
    'createArticle',
    'updateArticle',
    'listAiTasks',
    'getAiTask',
    'submitAiTaskResult',
    'createPlatformDraft',
    'listPlatformDrafts',
    'getPlatformDraft',
    'stageRemoteDraft',
    'requestPublishApproval',
    'getPublicationStatus',
  ];
  const fake: Record<string, unknown> = {};
  for (const name of names) fake[name] = vi.fn(overrides[name] ?? (() => Promise.reject(new Error(`unexpected call to ${name}`))));
  return fake as Fake;
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function connect(server: ReturnType<typeof createBrandServer>) {
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  closers.push(() => client.close());
  return client;
}

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  return { text: result.content.map((c) => c.text).join('\n'), isError: result.isError === true };
}

describe('the tool list', () => {
  it('has exactly the fifteen tools and no way to approve, decline, publish or hand off', async () => {
    const client = await connect(createBrandServer({ api: fakeApi(), credential: CREDENTIAL }));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const tool of tools) expect(tool.name, tool.name).not.toMatch(OWNER_ONLY_VERBS);
    expect(tools.map((t) => t.name).join(' ')).not.toMatch(/approve_|decline|hand_off|connect|credential|provider|setting|mark_|check_on/i);
  });

  it('marks reads as read-only and writes as non-destructive, never open-world', async () => {
    const client = await connect(createBrandServer({ api: fakeApi(), credential: CREDENTIAL }));
    const { tools } = await client.listTools();
    const reads = ['get_my_profile', 'search_knowledge', 'list_articles', 'get_article', 'list_ai_tasks', 'get_ai_task', 'list_platform_drafts', 'get_platform_draft', 'get_publication_status'];
    for (const tool of tools) {
      expect(tool.annotations?.openWorldHint, tool.name).toBe(false);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(reads.includes(tool.name));
      expect(tool.description?.length ?? 0, tool.name).toBeGreaterThan(40);
    }
  });

  it('takes no owner, user or account argument anywhere', async () => {
    const client = await connect(createBrandServer({ api: fakeApi(), credential: CREDENTIAL }));
    const { tools } = await client.listTools();
    const names = JSON.stringify(tools.map((t) => t.inputSchema));
    expect(names).not.toMatch(/owner|userId|user_id|account|tenant|credential/i);
  });

  it('says plainly in its instructions what it cannot do', () => {
    expect(INSTRUCTIONS).toMatch(/cannot do, by design: approve, decline or publish/);
    expect(INSTRUCTIONS).toMatch(/Only the owner can approve/);
    expect(INSTRUCTIONS).toMatch(/data/);
    expect(INSTRUCTIONS.length).toBeLessThan(4096);
  });
});

describe('calling the tools', () => {
  it('passes validated arguments to the API and returns its answer as JSON', async () => {
    const api = fakeApi({
      me: async () => ({ credential: { name: 'laptop', scopes: ['read'] }, profile: { name: 'Person' }, preferences: null }),
      searchKnowledge: async () => ({ query: 'queue', items: [{ id: ID, title: 'Queue note', confidentiality: 'private', publicUsePermitted: false }] }),
      listArticles: async () => ({ query: '', articles: [{ id: ID, title: 'Queues', revision: 2 }] }),
      getArticle: async () => ({ id: ID, title: 'Queues', bodyMarkdown: 'Body', revision: 2 }),
    });
    const client = await connect(createBrandServer({ api, credential: CREDENTIAL }));
    expect(JSON.parse((await call(client, 'get_my_profile')).text).profile.name).toBe('Person');
    const knowledge = JSON.parse((await call(client, 'search_knowledge', { query: 'queue', limit: 5 })).text);
    expect(knowledge.items[0]).toMatchObject({ confidentiality: 'private', publicUsePermitted: false });
    expect(api.searchKnowledge).toHaveBeenCalledWith({ q: 'queue', limit: 5 });
    await call(client, 'list_articles', { query: 'queues', status: 'draft' });
    expect(api.listArticles).toHaveBeenCalledWith({ q: 'queues', status: 'draft', limit: 20 });
    expect(JSON.parse((await call(client, 'get_article', { id: ID })).text).revision).toBe(2);
    expect(api.getArticle).toHaveBeenCalledWith(ID);
  });

  it('creates and updates articles with the revision, and sends only the fields given', async () => {
    const api = fakeApi({
      createArticle: async () => ({ id: ID, title: 'New', bodyMarkdown: 'Hello', revision: 1, slug: 'new' }),
      updateArticle: async () => ({ id: ID, title: 'New', bodyMarkdown: 'Hello there', revision: 2, slug: 'new' }),
    });
    const client = await connect(createBrandServer({ api, credential: CREDENTIAL }));
    const created = JSON.parse((await call(client, 'create_article', { title: 'New', bodyMarkdown: 'Hello', tags: ['a'] })).text);
    expect(created).toMatchObject({ id: ID, revision: 1, bodyChars: 5 });
    expect(created).not.toHaveProperty('bodyMarkdown');
    expect(api.createArticle).toHaveBeenCalledWith({ title: 'New', bodyMarkdown: 'Hello', tags: ['a'] });

    const updated = JSON.parse((await call(client, 'update_article', { id: ID, expectedRevision: 1, bodyMarkdown: 'Hello there' })).text);
    expect(updated.revision).toBe(2);
    expect(api.updateArticle).toHaveBeenCalledWith(ID, 1, { bodyMarkdown: 'Hello there' });

    const empty = await call(client, 'update_article', { id: ID, expectedRevision: 1 });
    expect(empty.isError).toBe(true);
    expect(empty.text).toMatch(/at least one field/);
    expect(api.updateArticle).toHaveBeenCalledTimes(1);
  });

  it('explains a revision conflict and what to do next', async () => {
    const api = fakeApi({
      updateArticle: async () => {
        throw new ApiError(409, 'conflict', 'This article was changed somewhere else since you opened it.', { current: { revision: 7 } });
      },
    });
    const client = await connect(createBrandServer({ api, credential: CREDENTIAL }));
    const out = await call(client, 'update_article', { id: ID, expectedRevision: 3, title: 'x' });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/current revision is 7/);
    expect(out.text).toMatch(/get_article again/);
  });

  it('lists and reads AI tasks and submits results that match the operation shapes', async () => {
    const api = fakeApi({
      listAiTasks: async () => ({ tasks: [{ id: TASK, kind: 'improve_section', status: 'pending' }] }),
      getAiTask: async () => ({ id: TASK, kind: 'improve_section', excerpt: 'Text.', allowedOperations: ['replace_range', 'review_notes'] }),
      submitAiTaskResult: async () => ({ id: TASK, status: 'needs_review' }),
    });
    const client = await connect(createBrandServer({ api, credential: CREDENTIAL }));
    await call(client, 'list_ai_tasks', { status: ['pending', 'running'] });
    expect(api.listAiTasks).toHaveBeenCalledWith({ status: 'pending,running', limit: 25 });
    expect(JSON.parse((await call(client, 'get_ai_task', { id: TASK })).text).excerpt).toBe('Text.');
    const operations = [{ type: 'replace_range', original: 'Text.', proposed: 'Better text.', rationale: 'Clearer.' }];
    expect(JSON.parse((await call(client, 'submit_ai_task_result', { taskId: TASK, operations })).text)).toEqual({ id: TASK, status: 'needs_review' });
    expect(api.submitAiTaskResult).toHaveBeenCalledWith(TASK, operations);
  });

  it('refuses malformed input before it reaches the API', async () => {
    const api = fakeApi();
    const client = await connect(createBrandServer({ api, credential: CREDENTIAL }));
    for (const [name, args] of [
      ['get_article', { id: 'not-a-uuid' }],
      ['get_ai_task', {}],
      ['search_knowledge', { query: '' }],
      ['update_article', { id: ID, expectedRevision: 0, title: 'x' }],
      ['update_article', { id: ID, expectedRevision: 1, status: 'published' }],
      ['submit_ai_task_result', { taskId: TASK, operations: [{ type: 'delete_article' }] }],
      ['submit_ai_task_result', { taskId: TASK, operations: [] }],
      ['submit_ai_task_result', { taskId: TASK, operations: [{ type: 'replace_range', original: 'a', proposed: '<script>x</script>' }] }],
      ['submit_ai_task_result', { taskId: TASK, operations: [{ type: 'insert_after', text: 'x'.repeat(20_001) }] }],
    ] as const) {
      const out = await call(client, name, args).catch((e: unknown) => ({ text: String(e), isError: true }));
      expect(out.isError, `${name} ${JSON.stringify(args).slice(0, 60)}`).toBe(true);
    }
    for (const fn of Object.values(api)) expect(fn).not.toHaveBeenCalled();
  });
});

describe('what never leaves in a result', () => {
  it('drops owner ids, keys and secrets wherever they appear, and removes the credential from text', () => {
    const dirty = {
      id: ID,
      ownerId: 'x',
      nested: { owner_id: 'y', encryptedKey: 'z', apiKey: 'k', fine: `contains ${CREDENTIAL} here` },
      list: [{ secretHash: 'h', ok: 1 }],
    };
    const clean = sanitize(dirty, CREDENTIAL);
    expect(JSON.stringify(clean)).not.toMatch(/ownerId|owner_id|encryptedKey|apiKey|secretHash/);
    expect(JSON.stringify(clean)).not.toContain(CREDENTIAL);
    expect(clean).toEqual({ id: ID, nested: { fine: 'contains [credential] here' }, list: [{ ok: 1 }] });
  });

  it('keeps the credential out of tool results and errors even if the app echoes it', async () => {
    const api = fakeApi({
      getArticle: async () => ({ id: ID, title: 'Oops', bodyMarkdown: `I pasted ${CREDENTIAL} by mistake`, ownerId: 'someone' }),
      getAiTask: async () => {
        throw new ApiError(500, 'x', `failed with Authorization: Bearer ${CREDENTIAL}`);
      },
    });
    const client = await connect(createBrandServer({ api, credential: CREDENTIAL }));
    const article = await call(client, 'get_article', { id: ID });
    expect(article.text).not.toContain(CREDENTIAL);
    expect(article.text).not.toContain('someone');
    const failed = await call(client, 'get_ai_task', { id: TASK });
    expect(failed.isError).toBe(true);
    expect(failed.text).not.toContain(CREDENTIAL);
  });

  it('turns API failures into one clear sentence with a next step', () => {
    expect(errorText(new ApiError(401, 'x', 'no'), CREDENTIAL)).toMatch(/new one under Settings > Agent access/);
    expect(errorText(new ApiError(403, 'forbidden', 'This credential does not have the "write_articles" scope.'), CREDENTIAL)).toMatch(/with that scope/);
    expect(errorText(new ApiError(404, 'not_found', 'Article not found'), CREDENTIAL)).toBe('Not found for this account.');
    expect(errorText(new ApiError(429, 'limit', 'Too many requests.', undefined, 12), CREDENTIAL)).toMatch(/about 12 seconds/);
    expect(errorText(new ApiError(0, 'unreachable', 'Could not reach Brand OS at http://127.0.0.1:3100. Is it running?'), CREDENTIAL)).toMatch(/Is it running/);
    expect(errorText(new Error(`boom ${CREDENTIAL}`), CREDENTIAL)).not.toContain(CREDENTIAL);
  });
});

describe('start-up', () => {
  it('reads the credential from the environment and the address from an argument or the environment', () => {
    expect(readSettings([], { BRAND_OS_CREDENTIAL: CREDENTIAL })).toEqual({ baseUrl: 'http://127.0.0.1:3100', credential: CREDENTIAL });
    expect(readSettings(['--url', 'https://brand.example.test'], { BRAND_OS_CREDENTIAL: CREDENTIAL })).toMatchObject({ baseUrl: 'https://brand.example.test' });
    expect(readSettings(['--url=http://localhost:4000'], { BRAND_OS_CREDENTIAL: CREDENTIAL, BRAND_OS_URL: 'http://ignored.test' })).toMatchObject({ baseUrl: 'http://localhost:4000' });
    expect(readSettings([], { BRAND_OS_URL: 'http://localhost:9' })).toEqual({ baseUrl: 'http://localhost:9', credential: null });
    expect(readSettings(['--credential', CREDENTIAL], {}).credential).toBe(CREDENTIAL);
  });

  it('without a credential every tool explains how to set it up, instead of failing to connect', async () => {
    const client = await connect(buildServer({ baseUrl: 'http://127.0.0.1:3100', credential: null }));
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(EXPECTED_TOOLS.length);
    const out = await call(client, 'get_my_profile');
    expect(out.isError).toBe(true);
    expect(out.text).toBe(NOT_CONFIGURED_TEXT);
    expect(out.text).toMatch(/BRAND_OS_CREDENTIAL/);
  });
});
