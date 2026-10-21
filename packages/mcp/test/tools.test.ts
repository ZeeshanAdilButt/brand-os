import { DaemonApiError, DaemonUnavailableError, type DaemonApi } from '@cph/client';
import { redact } from '@cph/daemon/redact';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ElicitRequestSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpServer } from '../src/index.js';

const READ_ONLY = [
  'sync_content',
  'list_content',
  'get_content',
  'list_connections',
  'preview_adaptation',
  'list_drafts',
  'get_approval_status',
  'get_publish_log',
];
const OPENERS = ['open_dashboard', 'connect_platform'];
const LOCAL_WRITES = ['create_draft', 'update_draft', 'request_approval', 'approve_in_chat', 'record_publication', 'check_on_platform'];
const EXPECTED_TOOLS = [...READ_ONLY, ...OPENERS, ...LOCAL_WRITES, 'stage_remote_draft', 'publish', 'hand_off'];

const DRAFT_ID = '4f1b6c1e-9a3d-4e2b-8c55-0d7a1f2e3b4c';
const APPROVAL_ID = '0b8d2a77-5c1e-4a6f-9d33-7e1c2b4a5f60';
const APPROVE_URL = `http://127.0.0.1:4646/approvals/${APPROVAL_ID}`;
const OG_TEXT = 'Service time is 4 ms. Queue time is the rest. Measure the queue.';

const CONTENT = {
  slug: 'sample-post',
  canonicalUrl: 'https://www.example-blog.dev/blog/sample-post',
  title: 'How Queues Hide Latency',
  date: '2026-09-01',
  published: true,
  dirty: false,
  repoCommit: 'a'.repeat(40),
  syncedAt: '2026-10-19T10:00:00.000Z',
  drafts: [],
  readable: true,
  sourceCurrent: true,
  frontmatter: { title: 'How Queues Hide Latency', description: 'A short tour of one counter.' },
  notes: {
    excerpt: 'Latency lives in queues. Once you can read one counter, three graphs become one piece of arithmetic.',
    ogText: OG_TEXT,
    keyEntities: ['latency', 'queue', "Little's Law"],
    factLabels: ["Documented: Little's Law relates queue length, arrival rate and wait time.", 'Measured on the fleet: 31 series to 7 after aggregation.'],
    alternateTitles: [],
    metaDescription: 'x',
    verifyBeforePublishing: [],
  },
};

const DRAFT = {
  id: DRAFT_ID,
  slug: 'sample-post',
  platform: 'linkedin' as const,
  account: 'default',
  route: 'buffer' as const,
  kind: 'post' as const,
  status: 'draft' as const,
  authorship: 'ai-assisted' as const,
  payload: { text: 'hello' },
  payloadSha256: 'c'.repeat(64),
  lint: [{ rule: 'li-takeaway', severity: 'error' as const, message: 'Too short.' }],
};

type Fake = { [K in keyof DaemonApi]: ReturnType<typeof vi.fn> } & DaemonApi;

function fakeClient(overrides: Partial<DaemonApi> = {}): Fake {
  const names: (keyof DaemonApi)[] = [
    'sync', 'listContent', 'getContent', 'listConnections', 'openDashboard', 'loginNonce', 'preview', 'createDraft',
    'listDrafts', 'getDraft', 'updateDraft', 'stageDraft', 'checkDraft', 'requestApproval', 'getApproval', 'publish',
    'handOff', 'recordPublication', 'getLog', 'getApprovalCard', 'approveInChat',
  ];
  const fake: Record<string, unknown> = {};
  for (const name of names) {
    fake[name] = vi.fn(overrides[name] ?? (() => Promise.reject(new Error(`unexpected call to ${name}`))));
  }
  return fake as Fake;
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function connect(client: DaemonApi) {
  const server = createMcpServer({ client });
  const mcp = new Client({ name: 'test', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), mcp.connect(clientSide)]);
  closers.push(() => mcp.close());
  return mcp;
}

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };
async function call(mcp: Client, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const result = (await mcp.callTool({ name, arguments: args })) as ToolResult;
  return { text: result.content.map((c) => c.text).join('\n'), isError: result.isError === true };
}

function propertyNames(schema: unknown, found: string[] = []): string[] {
  if (Array.isArray(schema)) schema.forEach((s) => propertyNames(s, found));
  else if (typeof schema === 'object' && schema !== null) {
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'properties' && typeof value === 'object' && value !== null) found.push(...Object.keys(value));
      propertyNames(value, found);
    }
  }
  return found;
}

describe('tool list', () => {
  it('exposes exactly the Phase 0 tools and nothing that approves or changes settings', async () => {
    const mcp = await connect(fakeClient());
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    // approve_in_chat is the one exception: it only records what the owner answered in Claude Code's prompt.
    for (const forbidden of ['approve', 'deny', 'settings', 'publishing', 'mapping', 'resolve', 'confirm']) {
      expect(tools.some((t) => t.name.includes(forbidden) && t.name !== 'approve_in_chat')).toBe(false);
    }
  });

  it('annotates read tools, openers, writes, staging and publishing as the brief says', async () => {
    const mcp = await connect(fakeClient());
    const { tools } = await mcp.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of READ_ONLY) expect(by[name]?.annotations?.readOnlyHint, name).toBe(true);
    for (const name of [...OPENERS, ...LOCAL_WRITES, 'stage_remote_draft', 'publish', 'hand_off']) {
      expect(by[name]?.annotations?.readOnlyHint, name).not.toBe(true);
    }
    expect(by['publish']?.annotations?.destructiveHint).toBe(true);
    expect(by['publish']?.annotations?.openWorldHint).toBe(true);
    expect(by['hand_off']?.annotations?.destructiveHint).toBe(true);
    expect(by['hand_off']?.annotations?.openWorldHint).toBe(true);
    expect(by['stage_remote_draft']?.annotations?.openWorldHint).toBe(true);
    expect(by['stage_remote_draft']?.annotations?.destructiveHint).not.toBe(true);
    expect(by['stage_remote_draft']?.description).toContain('creates a PRIVATE draft only');
    expect(by['check_on_platform']?.annotations?.openWorldHint).toBe(true);
    for (const name of LOCAL_WRITES.filter((n) => n !== 'check_on_platform')) {
      expect(by[name]?.annotations?.openWorldHint, name).not.toBe(true);
    }
  });

  it('uses the verbatim descriptions for connect_platform and publish', async () => {
    const mcp = await connect(fakeClient());
    const { tools } = await mcp.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(by['connect_platform']?.description).toBe(
      "Opens the signed-in connect page for this platform in the user's browser. Never ask the user for keys in chat.",
    );
    expect(by['publish']?.description).toBe(
      'Secondary path. Normally the owner clicks Approve & publish in the dashboard and nothing more is needed. Use this only when the approval status is `approved`.',
    );
  });

  it('has no input field named api_key, token, secret or password', async () => {
    const mcp = await connect(fakeClient());
    const { tools } = await mcp.listTools();
    const names = tools.flatMap((t) => propertyNames(t.inputSchema));
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) expect(name).not.toMatch(/^(api_?key|token|secret|password)$/i);
  });
});

describe('request_approval', () => {
  it('returns the dashboard URL and the polling contract, with nothing secret in it', async () => {
    const client = fakeClient({
      requestApproval: async () => ({ approvalId: APPROVAL_ID, status: 'pending', approveUrl: APPROVE_URL, instructions: 'ignored' }),
    });
    const mcp = await connect(client);
    const { text, isError } = await call(mcp, 'request_approval', { draft_id: DRAFT_ID });
    expect(isError).toBe(false);
    expect(client.requestApproval).toHaveBeenCalledWith(DRAFT_ID);
    expect(text).toContain(APPROVE_URL);
    expect(text).toContain('get_approval_status');
    expect(text).toContain('15 seconds');
    expect(text).toContain(
      `Ask the owner to approve at ${APPROVE_URL}. Then call get_approval_status every 15 seconds for up to 10 minutes. Stop when the status is published (report the URL), approved (call publish now), denied or expired. After 10 minutes, stop and say the approval is still waiting.`,
    );
    expect(text).toContain(APPROVAL_ID);
    expect(text).not.toMatch(/\b\d{6}\b/);
    expect(redact(text)).toBe(text);
  });
});

describe('open_dashboard and connect_platform', () => {
  it('returns only {opened, page} and nothing token-shaped', async () => {
    const client = fakeClient({ openDashboard: async (page) => ({ opened: true as const, page }) });
    const mcp = await connect(client);
    const { text, isError } = await call(mcp, 'open_dashboard', { page: 'approvals' });
    expect(isError).toBe(false);
    expect(client.openDashboard).toHaveBeenCalledWith('approvals');
    expect(JSON.parse(text)).toEqual({ opened: true, page: 'approvals' });
    expect(redact(text)).toBe(text);
    expect(text).not.toMatch(/nonce|token|login/i);
  });

  it('refuses a page the daemon would refuse before calling it', async () => {
    const client = fakeClient();
    const mcp = await connect(client);
    const result = await mcp.callTool({ name: 'open_dashboard', arguments: { page: 'settings' } });
    expect(result.isError).toBe(true);
    expect(client.openDashboard).not.toHaveBeenCalled();
  });

  it('opens connections/<platform> for connect_platform', async () => {
    const client = fakeClient({ openDashboard: async (page) => ({ opened: true as const, page }) });
    const mcp = await connect(client);
    const { text } = await call(mcp, 'connect_platform', { platform: 'devto' });
    expect(client.openDashboard).toHaveBeenCalledWith('connections/devto');
    expect(JSON.parse(text)).toEqual({ opened: true, page: 'connections/devto' });
  });
});

describe('error mapping', () => {
  const publishArgs = { draft_id: DRAFT_ID, approval_id: APPROVAL_ID };

  it('turns 409 PUBLISHING_DISABLED into the exact text', async () => {
    const mcp = await connect(
      fakeClient({ publish: () => Promise.reject(new DaemonApiError(409, 'PUBLISHING_DISABLED', 'publishing is disabled')) }),
    );
    const { text, isError } = await call(mcp, 'publish', publishArgs);
    expect(isError).toBe(true);
    expect(text).toBe('Publishing is DISABLED. The owner can enable it in Dashboard → Settings (he confirms there).');
  });

  it('shows other 409s as <code>: <message>', async () => {
    const mcp = await connect(
      fakeClient({ publish: () => Promise.reject(new DaemonApiError(409, 'HASH_MISMATCH', 'the draft changed after approval')) }),
    );
    const { text, isError } = await call(mcp, 'publish', publishArgs);
    expect(isError).toBe(true);
    expect(text).toBe('HASH_MISMATCH: the draft changed after approval');
  });

  it('says to run cph install when the daemon is degraded (503)', async () => {
    const mcp = await connect(fakeClient({ listConnections: () => Promise.reject(new DaemonApiError(503, 'NOT_CONFIGURED', 'master key missing')) }));
    const { text, isError } = await call(mcp, 'list_connections');
    expect(isError).toBe(true);
    expect(text).toBe("content-powerhouse isn't set up yet: run `cph install`");
  });

  it('says the daemon is not running for every tool when it cannot be reached', async () => {
    const down = () => Promise.reject(new DaemonUnavailableError('the daemon could not be reached'));
    const mcp = await connect(
      fakeClient({
        sync: down, listContent: down, getContent: down, listConnections: down, openDashboard: down, preview: down,
        createDraft: down, listDrafts: down, getDraft: down, updateDraft: down, stageDraft: down, checkDraft: down,
        requestApproval: down, getApproval: down, getApprovalCard: down, approveInChat: down, publish: down, handOff: down, recordPublication: down, getLog: down,
      }),
    );
    const args: Record<string, Record<string, unknown>> = {
      get_content: { slug: 's' },
      preview_adaptation: { slug: 's', platform: 'linkedin' },
      get_approval_status: { approval_id: APPROVAL_ID },
      open_dashboard: { page: 'approvals' },
      connect_platform: { platform: 'devto' },
      create_draft: { slug: 's', platform: 'linkedin' },
      update_draft: { draft_id: DRAFT_ID, patch: { text: 'x' } },
      request_approval: { draft_id: DRAFT_ID },
      approve_in_chat: { approval_id: APPROVAL_ID },
      record_publication: { draft_id: DRAFT_ID, url: 'https://www.linkedin.com/feed/update/urn:li:activity:1' },
      check_on_platform: { draft_id: DRAFT_ID },
      stage_remote_draft: { draft_id: DRAFT_ID },
      publish: { draft_id: DRAFT_ID, approval_id: APPROVAL_ID },
      hand_off: { draft_id: DRAFT_ID, approval_id: APPROVAL_ID },
    };
    for (const name of EXPECTED_TOOLS) {
      const { text, isError } = await call(mcp, name, args[name] ?? {});
      expect(isError, name).toBe(true);
      expect(text, name).toBe('Daemon not running: run `cph daemon start`');
    }
  });

  it('redacts a token that leaks into a daemon message', async () => {
    const token = `cph_mcp_${'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Yz3Ab4C'}`;
    expect(token).toHaveLength(8 + 43);
    const mcp = await connect(fakeClient({ listContent: () => Promise.reject(new DaemonApiError(500, 'INTERNAL', `boom ${token}`)) }));
    const { text } = await call(mcp, 'list_content');
    expect(text).not.toContain(token);
    expect(text).toContain('[REDACTED]');
  });
});

describe('tool behaviour', () => {
  it('create_draft maps snake_case to the API and reports lint errors without the hash', async () => {
    const client = fakeClient({ createDraft: async () => DRAFT });
    const mcp = await connect(client);
    const { text, isError } = await call(mcp, 'create_draft', { slug: 'sample-post', platform: 'linkedin', payload: { text: 'hello' } });
    expect(isError).toBe(false);
    expect(client.createDraft).toHaveBeenCalledWith({ slug: 'sample-post', platform: 'linkedin', payload: { text: 'hello' } });
    expect(text).toContain(DRAFT_ID);
    expect(text).toContain('li-takeaway');
    expect(text).not.toContain(DRAFT.payloadSha256);
  });

  it('create_draft omits payload when none is given', async () => {
    const client = fakeClient({ createDraft: async () => DRAFT });
    const mcp = await connect(client);
    await call(mcp, 'create_draft', { slug: 'sample-post', platform: 'devto' });
    expect(client.createDraft).toHaveBeenCalledWith({ slug: 'sample-post', platform: 'devto' });
  });

  it('update_draft sends the patch', async () => {
    const client = fakeClient({ updateDraft: async () => DRAFT });
    const mcp = await connect(client);
    await call(mcp, 'update_draft', { draft_id: DRAFT_ID, patch: { text: 'new' } });
    expect(client.updateDraft).toHaveBeenCalledWith(DRAFT_ID, { text: 'new' });
  });

  it('publish reports the URL when published and an error when it failed', async () => {
    const results = [
      { status: 'published' as const, remoteUrl: 'https://dev.to/zee/queues-1a2b' },
      { status: 'failed' as const, error: 'HTTP 422: tag too long' },
      { status: 'unknown' as const, error: 'timed out after send' },
      { status: 'dry_run' as const },
    ];
    const client = fakeClient({ publish: async () => results.shift() as never });
    const mcp = await connect(client);
    const args = { draft_id: DRAFT_ID, approval_id: APPROVAL_ID };
    const published = await call(mcp, 'publish', args);
    expect(client.publish).toHaveBeenCalledWith(DRAFT_ID, APPROVAL_ID);
    expect(published).toEqual({ text: 'Published: https://dev.to/zee/queues-1a2b', isError: false });
    const failed = await call(mcp, 'publish', args);
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain('failed');
    expect(failed.text).toContain('tag too long');
    const unknown = await call(mcp, 'publish', args);
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/not retry/i);
    const dry = await call(mcp, 'publish', args);
    expect(dry.isError).toBe(false);
    expect(dry.text).toMatch(/dry run/i);
    expect(dry.text).toMatch(/nothing was posted/i);
  });

  it('get_approval_status says what to do for each state and claims a post only when published', async () => {
    const base = { approvalId: APPROVAL_ID, draftId: DRAFT_ID, mode: 'approve_only' as const, expiresAt: '2026-10-19T12:00:00.000Z' };
    const answers = [
      { ...base, status: 'pending' as const },
      { ...base, status: 'approved' as const },
      { ...base, status: 'published' as const, remoteUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7' },
      { ...base, status: 'denied' as const },
    ];
    const client = fakeClient({ getApproval: async () => answers.shift() as never });
    const mcp = await connect(client);
    const args = { approval_id: APPROVAL_ID };
    const pending = await call(mcp, 'get_approval_status', args);
    expect(pending.text).toContain('pending');
    expect(pending.text).not.toMatch(/published/i);
    const approved = await call(mcp, 'get_approval_status', args);
    expect(approved.text).toContain('approved');
    expect(approved.text).toContain('publish');
    expect(approved.text).not.toMatch(/\bpublished\b/i);
    const published = await call(mcp, 'get_approval_status', args);
    expect(published.text).toContain('published');
    expect(published.text).toContain('https://www.linkedin.com/feed/update/urn:li:activity:7');
    const denied = await call(mcp, 'get_approval_status', args);
    expect(denied.text).toContain('denied');
    expect(denied.text).not.toMatch(/\bpublished\b/i);
  });

  it('list_content leaves out commit hashes and returns slugs and titles', async () => {
    const client = fakeClient({ listContent: async () => ({ content: [CONTENT] }) });
    const mcp = await connect(client);
    const { text } = await call(mcp, 'list_content');
    expect(text).toContain('sample-post');
    expect(text).toContain('How Queues Hide Latency');
    expect(text).not.toContain(CONTENT.repoCommit);
    expect(redact(text)).toBe(text);
  });

  it('stage_remote_draft calls stage and says the draft is private', async () => {
    const client = fakeClient({ stageDraft: async () => ({ remoteId: 'r-1', previewUrl: 'https://dev.to/zee/queues-temp-1a2b' }) });
    const mcp = await connect(client);
    const { text, isError } = await call(mcp, 'stage_remote_draft', { draft_id: DRAFT_ID });
    expect(isError).toBe(false);
    expect(client.stageDraft).toHaveBeenCalledWith(DRAFT_ID);
    expect(text).toMatch(/private/i);
    expect(text).toContain('https://dev.to/zee/queues-temp-1a2b');
  });

  it('hand_off returns the checklist and link, not a claim that it was posted', async () => {
    const client = fakeClient({
      handOff: async () => ({ copiedText: 'the post text', openUrl: 'https://www.linkedin.com/feed/', checklist: ['Paste', 'Post'] }),
    });
    const mcp = await connect(client);
    const { text } = await call(mcp, 'hand_off', { draft_id: DRAFT_ID, approval_id: APPROVAL_ID });
    expect(client.handOff).toHaveBeenCalledWith(DRAFT_ID, APPROVAL_ID);
    expect(text).toContain('https://www.linkedin.com/feed/');
    expect(text).toContain('record_publication');
  });
});

describe('prompts and resources', () => {
  it('adapt-linkedin embeds the excerpt, OG text, entities, fact labels and style rules', async () => {
    const client = fakeClient({ getContent: async () => CONTENT });
    const mcp = await connect(client);
    const { prompts } = await mcp.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['adapt-linkedin']);
    const prompt = await mcp.getPrompt({ name: 'adapt-linkedin', arguments: { slug: 'sample-post' } });
    const text = prompt.messages.map((m) => (m.content.type === 'text' ? m.content.text : '')).join('\n');
    expect(client.getContent).toHaveBeenCalledWith('sample-post');
    expect(text).toContain(OG_TEXT);
    expect(text).toContain(CONTENT.notes.excerpt);
    expect(text).toContain("Little's Law");
    expect(text).toContain('Measured on the fleet: 31 series to 7 after aggregation.');
    expect(text).toContain('utm_source=linkedin&utm_medium=social&utm_campaign=sample-post');
    expect(text).toMatch(/no hype/i);
    expect(text).toContain('🧵👇');
    expect(text).toMatch(/numbers only from the source/i);
    expect(text).toContain('create_draft');
    expect(text.indexOf('create_draft')).toBeLessThan(text.indexOf('request_approval'));
    expect(text).toMatch(/every lint error/i);
    expect(text).toMatch(/never ask the user for (any )?keys/i);
    expect(text).toMatch(/get_approval_status says published/i);
  });

  it('exposes the five resource kinds', async () => {
    const client = fakeClient({
      getContent: async () => CONTENT,
      getDraft: async () => DRAFT,
      listConnections: async () => ({ secretsReady: true, connections: [] }),
      listDrafts: async () => ({ drafts: [{ ...DRAFT, status: 'pending_approval' as const }] }),
      listContent: async () => ({ content: [CONTENT] }),
    });
    const mcp = await connect(client);
    const { resourceTemplates } = await mcp.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual(
      ['content://notes/{slug}', 'content://posts/{slug}', 'drafts://{id}'].sort(),
    );
    const { resources } = await mcp.listResources();
    expect(resources.map((r) => r.uri)).toEqual(expect.arrayContaining(['connections://status', 'approvals://pending']));

    const post = await mcp.readResource({ uri: 'content://posts/sample-post' });
    expect(JSON.stringify(post.contents)).toContain('How Queues Hide Latency');
    const notes = await mcp.readResource({ uri: 'content://notes/sample-post' });
    expect(JSON.stringify(notes.contents)).toContain(OG_TEXT);
    const draft = await mcp.readResource({ uri: `drafts://${DRAFT_ID}` });
    expect(JSON.stringify(draft.contents)).toContain('li-takeaway');
    expect(JSON.stringify(draft.contents)).not.toContain(DRAFT.payloadSha256);
    const pending = await mcp.readResource({ uri: 'approvals://pending' });
    expect(JSON.stringify(pending.contents)).toContain(DRAFT_ID);
    expect(client.listDrafts).toHaveBeenCalledWith({ status: 'pending_approval' });
    const status = await mcp.readResource({ uri: 'connections://status' });
    expect(JSON.stringify(status.contents)).toContain('secretsReady');
  });
});

describe('redaction scope', () => {
  // Things redact masks on purpose (a hex digest, a long identifier with a digit, a "token: <word>" pair)
  // but that are ordinary post and draft content Claude must read and copy back exactly.
  const SHA40 = '3f9a12c07b0e1d2a4c5e6f708192a3b4c5d6e7f8';
  const IDENT = 'createHttp2ConnectionPoolManagerInstance';
  const PROSE = 'Token: the number of series is the cost.';
  const BODY = `Commit ${SHA40} added ${IDENT}. ${PROSE}`;
  const RICH_DRAFT = { ...DRAFT, payload: { text: BODY } };
  const FAKE_TOKEN = `cph_cli_${'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8Nn7Mm6L'}`;

  it('the sample really is something redact would mangle', () => {
    expect(redact(SHA40)).not.toBe(SHA40);
    expect(redact(IDENT)).not.toBe(IDENT);
    expect(redact(PROSE)).not.toBe(PROSE);
  });

  it('draft payloads round-trip unchanged through create_draft, update_draft, list_drafts and drafts://', async () => {
    const client = fakeClient({
      createDraft: async () => RICH_DRAFT,
      updateDraft: async () => RICH_DRAFT,
      listDrafts: async () => ({ drafts: [RICH_DRAFT] }),
      getDraft: async () => RICH_DRAFT,
    });
    const mcp = await connect(client);
    for (const [name, args] of [
      ['create_draft', { slug: 'sample-post', platform: 'linkedin' }],
      ['update_draft', { draft_id: DRAFT_ID, patch: { text: BODY } }],
      ['list_drafts', {}],
    ] as const) {
      const { text, isError } = await call(mcp, name, args);
      expect(isError, name).toBe(false);
      expect(JSON.parse(text.split('\n\n')[0] as string)).toEqual(name === 'list_drafts' ? [draftViewOf(RICH_DRAFT)] : draftViewOf(RICH_DRAFT));
      expect(text, name).toContain(BODY);
    }
    const resource = await mcp.readResource({ uri: `drafts://${DRAFT_ID}` });
    const first = resource.contents[0] as { text: string };
    expect(JSON.parse(first.text)).toEqual(draftViewOf(RICH_DRAFT));
  });

  it('post content and notes round-trip unchanged through get_content and content:// resources', async () => {
    const content = { ...CONTENT, frontmatter: { ...CONTENT.frontmatter, description: BODY }, notes: { ...CONTENT.notes, ogText: BODY } };
    const mcp = await connect(fakeClient({ getContent: async () => content }));
    const { text } = await call(mcp, 'get_content', { slug: 'sample-post' });
    expect(text.split(BODY)).toHaveLength(3);
    const notes = await mcp.readResource({ uri: 'content://notes/sample-post' });
    expect((notes.contents[0] as { text: string }).text).toContain(BODY);
    const post = await mcp.readResource({ uri: 'content://posts/sample-post' });
    expect((post.contents[0] as { text: string }).text).toContain(BODY);
  });

  it('log entries, connection status and errors are still redacted', async () => {
    const mcp = await connect(
      fakeClient({
        getLog: async () => ({ entries: [{ id: 1, ts: '2026-10-20T10:00:00.000Z', actorChannel: 'publish', action: 'publish_failed', detail: { error: `Authorization: Bearer ${FAKE_TOKEN}` } }] }),
        listConnections: async () => ({ secretsReady: true, connections: [{ platform: 'devto', account: 'default', route: 'direct', status: 'error', lastHealthDetail: `leaked ${FAKE_TOKEN}` }] }) as never,
        getDraft: () => Promise.reject(new DaemonApiError(500, 'INTERNAL', `boom ${FAKE_TOKEN}`)),
      }),
    );
    for (const name of ['get_publish_log', 'list_connections'] as const) {
      const { text } = await call(mcp, name);
      expect(text, name).not.toContain(FAKE_TOKEN);
      expect(text, name).toContain('[REDACTED]');
    }
    const status = await mcp.readResource({ uri: 'connections://status' });
    expect(JSON.stringify(status.contents)).not.toContain(FAKE_TOKEN);
    await expect(mcp.readResource({ uri: `drafts://${DRAFT_ID}` })).rejects.toThrow(/REDACTED/);
  });

  it('a 503 that is not "not set up" says what it is instead of telling Claude to run cph install', async () => {
    const mcp = await connect(
      fakeClient({ listDrafts: () => Promise.reject(new DaemonApiError(503, 'SECRET_UNREADABLE', 'the devto secret cannot be decrypted. Reconnect it in the dashboard.')) }),
    );
    const { text, isError } = await call(mcp, 'list_drafts');
    expect(isError).toBe(true);
    expect(text).toBe('SECRET_UNREADABLE: the devto secret cannot be decrypted. Reconnect it in the dashboard.');
    expect(text).not.toContain('cph install');
  });
});

function draftViewOf(d: typeof DRAFT): Record<string, unknown> {
  const { payloadSha256: _hash, ...rest } = d;
  return rest;
}

describe('approve_in_chat', () => {
  const CHECKLIST = ['I have read this exact payload', 'The tag is #3F9A12C0 and matches the draft'];
  const CARD = {
    approvalId: APPROVAL_ID,
    draftId: DRAFT_ID,
    status: 'pending' as const,
    platform: 'linkedin' as const,
    route: 'buffer' as const,
    slug: 'sample-post',
    tag: '#3F9A12C0',
    payloadText: 'Service time is 4 ms.\nQueue time is the rest.',
    checklist: CHECKLIST,
  };
  const APPROVED = { approvalId: APPROVAL_ID, approved: true as const };

  type Asked = { message: string; requestedSchema: { properties: Record<string, { type: string; title?: string; enum?: string[]; default?: unknown }>; required: string[] } };

  /** A Claude Code stand-in: it declares elicitation and answers the prompt with `answer`. */
  async function connectWithPrompt(client: DaemonApi, answer: (asked: Asked) => ElicitResult, capabilities: { elicitation: Record<string, unknown> } = { elicitation: { form: {} } }) {
    const server = createMcpServer({ client });
    const mcp = new Client({ name: 'claude-code-test', version: '0.0.0' }, { capabilities });
    const asked: Asked[] = [];
    mcp.setRequestHandler(ElicitRequestSchema, (request) => {
      asked.push(request.params as unknown as Asked);
      return answer(request.params as unknown as Asked);
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), mcp.connect(clientSide)]);
    closers.push(() => mcp.close());
    return { mcp, asked };
  }

  const allTicked = (asked: Asked, decision = 'Approve'): ElicitResult => ({
    action: 'accept',
    content: { ...Object.fromEntries(Object.keys(asked.requestedSchema.properties).filter((k) => k.startsWith('check_')).map((k) => [k, true])), decision },
  });

  it('is described as a user prompt that only the user can answer', async () => {
    const mcp = await connect(fakeClient());
    const tool = (await mcp.listTools()).tools.find((t) => t.name === 'approve_in_chat');
    expect(tool?.description).toBe('Shows the user an approval prompt in Claude Code. Only the user can answer it. Never call this without the user asking to approve.');
    expect(propertyNames(tool?.inputSchema)).toEqual(['approval_id']);
  });

  it('shows the payload and one box per checklist item, and on Approve with every box ticked calls the route once', async () => {
    const client = fakeClient({ getApprovalCard: async () => CARD, approveInChat: async () => APPROVED });
    const { mcp, asked } = await connectWithPrompt(client, (a) => allTicked(a));
    const { text, isError } = await call(mcp, 'approve_in_chat', { approval_id: APPROVAL_ID });

    expect(isError).toBe(false);
    expect(client.approveInChat).toHaveBeenCalledTimes(1);
    expect(client.approveInChat).toHaveBeenCalledWith(APPROVAL_ID, CHECKLIST);
    expect(text).toContain('Call publish');
    expect(text).toContain(DRAFT_ID);

    expect(asked).toHaveLength(1);
    const prompt = asked[0] as Asked;
    expect(prompt.message).toContain('#3F9A12C0');
    expect(prompt.message).toContain('sample-post');
    expect(prompt.message).toContain(CARD.payloadText);
    const { properties, required } = prompt.requestedSchema;
    expect(Object.values(properties).filter((p) => p.type === 'boolean').map((p) => p.title)).toEqual(CHECKLIST);
    expect(properties['decision']).toMatchObject({ type: 'string', enum: ['Approve', 'Cancel'], default: 'Cancel' });
    expect(required).toEqual(['check_1', 'check_2', 'decision']);
  });

  it('an assist route is told to hand_off instead of publish', async () => {
    const client = fakeClient({ getApprovalCard: async () => ({ ...CARD, route: 'assist' as const }), approveInChat: async () => APPROVED });
    const { mcp } = await connectWithPrompt(client, (a) => allTicked(a));
    expect((await call(mcp, 'approve_in_chat', { approval_id: APPROVAL_ID })).text).toContain('hand_off');
  });

  it('Cancel, decline and dismiss all give "Not approved." and never call the route', async () => {
    const answers: ((a: Asked) => ElicitResult)[] = [(a) => allTicked(a, 'Cancel'), () => ({ action: 'decline' }), () => ({ action: 'cancel' })];
    for (const answer of answers) {
      const client = fakeClient({ getApprovalCard: async () => CARD });
      const { mcp } = await connectWithPrompt(client, answer);
      const result = await call(mcp, 'approve_in_chat', { approval_id: APPROVAL_ID });
      expect(result).toEqual({ text: 'Not approved.', isError: true });
      expect(client.approveInChat).not.toHaveBeenCalled();
    }
  });

  it('Approve with a box left unticked is not approved and never calls the route', async () => {
    const client = fakeClient({ getApprovalCard: async () => CARD });
    const { mcp } = await connectWithPrompt(client, () => ({ action: 'accept', content: { check_1: true, check_2: false, decision: 'Approve' } }));
    const result = await call(mcp, 'approve_in_chat', { approval_id: APPROVAL_ID });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^Not approved\./);
    expect(client.approveInChat).not.toHaveBeenCalled();
  });

  it('a client without elicitation gets the dashboard instruction and the route is never called', async () => {
    const client = fakeClient({ getApprovalCard: async () => CARD });
    const mcp = await connect(client);
    const result = await call(mcp, 'approve_in_chat', { approval_id: APPROVAL_ID });
    expect(result).toEqual({ text: "Your Claude client can't show approval prompts; approve in the dashboard instead.", isError: true });
    expect(client.approveInChat).not.toHaveBeenCalled();
  });

  it('a client that declares an empty elicitation capability (form mode by default) still gets the prompt', async () => {
    const client = fakeClient({ getApprovalCard: async () => CARD, approveInChat: async () => APPROVED });
    const { mcp, asked } = await connectWithPrompt(client, (a) => allTicked(a), { elicitation: {} });
    expect((await call(mcp, 'approve_in_chat', { approval_id: APPROVAL_ID })).isError).toBe(false);
    expect(asked).toHaveLength(1);
    expect(client.approveInChat).toHaveBeenCalledTimes(1);
  });

  it('an approval that is no longer pending shows no prompt', async () => {
    const client = fakeClient({ getApprovalCard: async () => ({ ...CARD, status: 'expired' as const, checklist: [] }) });
    const { mcp, asked } = await connectWithPrompt(client, (a) => allTicked(a));
    const result = await call(mcp, 'approve_in_chat', { approval_id: APPROVAL_ID });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('expired');
    expect(asked).toHaveLength(0);
    expect(client.approveInChat).not.toHaveBeenCalled();
  });

  it('maps a daemon refusal after the prompt to one error line', async () => {
    const client = fakeClient({
      getApprovalCard: async () => CARD,
      approveInChat: async () => {
        throw new DaemonApiError(409, 'HASH_MISMATCH', 'the approval was invalidated because the draft was edited');
      },
    });
    const { mcp } = await connectWithPrompt(client, (a) => allTicked(a));
    const result = await call(mcp, 'approve_in_chat', { approval_id: APPROVAL_ID });
    expect(result).toEqual({ text: 'HASH_MISMATCH: the approval was invalidated because the draft was edited', isError: true });
  });
});
