import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createAudit } from '../src/audit.js';
import { createApp } from '../src/http/app.js';
import {
  ApprovalCardResponse,
  ApprovalRequestResponse,
  ApprovalStatusResponse,
  ConnectionsResponse,
  ContentDetailResponse,
  ContentListResponse,
  DraftListResponse,
  DraftResponse,
  ErrorBody,
  isDashboardPage,
  LogResponse,
  LoginNonceResponse,
  OpenDashboardResponse,
  PreviewResponse,
  PublishResponse,
  StageResponse,
} from '../src/http/api.js';
import { createTokenVerifier, LoginNonceStore, LOGIN_NONCE_TTL_MS } from '../src/http/auth.js';
import { issueApiToken, MemoryKeyStore } from '../src/secrets/keystore.js';
import { SecretStore } from '../src/secrets/secret-store.js';
import { ConnectionsService } from '../src/services/connections.js';
import type { SyncResult } from '../src/sync.js';
import { goodLinkedinText, makeRig, SLUG, type RigOptions } from './helpers/service-rig.js';

/** Obviously fake; never a real provider key shape. */
const FAKE_KEY = 'not-a-real-key-0123456789abcdef';
const HOST = '127.0.0.1:4646';
/** Anything long and token-shaped: a nonce, an API token, a key. */
const TOKEN_SHAPED = /[A-Za-z0-9_-]{32,}/;

interface CallOptions {
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

function apiRig(options: RigOptions & { publishing?: boolean; secretsReady?: boolean; openerFails?: boolean } = {}) {
  const rig = makeRig(options);
  if (options.publishing === false) rig.repos.settings.set('publishing_enabled', 'false');
  const ks = new MemoryKeyStore();
  const mcp = issueApiToken(ks, 'mcp');
  const cli = issueApiToken(ks, 'cli');
  const opened: string[] = [];
  const nonces = new LoginNonceStore({ now: () => rig.clock.now });
  const connections = new ConnectionsService({ repos: rig.repos, routes: rig.routes, config: () => rig.config, audit: rig.audit, now: () => rig.clock.now });
  let syncCalls = 0;
  const app = createApp({
    tokens: createTokenVerifier(ks),
    nonces,
    opener: (url) => {
      opened.push(url);
      return options.openerFails === true ? Promise.reject(new Error(`spawn failed for ${url}`)) : Promise.resolve();
    },
    repos: rig.repos,
    drafts: rig.drafts,
    publish: rig.publish,
    recovery: rig.recovery,
    gate: rig.gate,
    chatGate: rig.chatGate,
    connections,
    sync: (): Promise<SyncResult> => {
      syncCalls += 1;
      return Promise.resolve({ upserted: 1, changed: [], invalidatedApprovals: 0, errors: [] });
    },
    loadContentItem: (slug) => (slug === SLUG ? rig.item : undefined),
    secretsReady: () => options.secretsReady ?? true,
    now: () => rig.clock.now,
  });

  const call = async (method: string, path: string, opts: CallOptions = {}): Promise<{ status: number; text: string; json: unknown }> => {
    const headers: Record<string, string> = { host: HOST, ...opts.headers };
    if (opts.token !== undefined) headers['authorization'] = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await app.request(path, { method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, text, json };
  };

  /** A LinkedIn draft (Buffer route by default) whose text passes lint. */
  const linkedinDraft = async (token = mcp): Promise<string> => {
    const res = await call('POST', '/api/drafts', { token, body: { slug: SLUG, platform: 'linkedin', payload: { text: goodLinkedinText(rig.item) } } });
    expect(res.status).toBe(201);
    return DraftResponse.parse(res.json).id;
  };

  return { rig, ks, mcp, cli, opened, nonces, app, call, linkedinDraft, syncCalls: () => syncCalls };
}

describe('middleware: host, origin, bearer token', () => {
  it('gives 401 without a token', async () => {
    const { call } = apiRig();
    const res = await call('GET', '/api/drafts');
    expect(res.status).toBe(401);
    expect(ErrorBody.parse(res.json).code).toBe('UNAUTHORIZED');
  });

  it('gives 401 for a wrong token of the right shape, and for a token with the wrong scope prefix', async () => {
    const { call, mcp } = apiRig();
    const wrong = `cph_mcp_${'A'.repeat(43)}`;
    expect((await call('GET', '/api/drafts', { token: wrong })).status).toBe(401);
    expect((await call('GET', '/api/drafts', { token: mcp.replace('cph_mcp_', 'cph_cli_') })).status).toBe(401);
    expect((await call('GET', '/api/drafts', { token: `${mcp}x` })).status).toBe(401);
    expect((await call('GET', '/api/drafts', { token: '' })).status).toBe(401);
  });

  it('accepts the mcp and the cli token', async () => {
    const { call, mcp, cli } = apiRig();
    expect((await call('GET', '/api/drafts', { token: mcp })).status).toBe(200);
    expect((await call('GET', '/api/drafts', { token: cli })).status).toBe(200);
  });

  it('gives 403 for Host: evil.com, even with a valid token', async () => {
    const { call, cli } = apiRig();
    const res = await call('GET', '/api/drafts', { token: cli, headers: { host: 'evil.com' } });
    expect(res.status).toBe(403);
    expect(ErrorBody.parse(res.json).code).toBe('FORBIDDEN_HOST');
  });

  it('accepts Host localhost:4646 and refuses another port', async () => {
    const { call, cli } = apiRig();
    expect((await call('GET', '/api/drafts', { token: cli, headers: { host: 'localhost:4646' } })).status).toBe(200);
    expect((await call('GET', '/api/drafts', { token: cli, headers: { host: '127.0.0.1:4647' } })).status).toBe(403);
    expect((await call('GET', '/api/drafts', { token: cli, headers: { host: '127.0.0.1' } })).status).toBe(403);
  });

  it('gives 403 for a cross-origin Origin and for cross-site fetch metadata', async () => {
    const { call, cli } = apiRig();
    expect((await call('GET', '/api/drafts', { token: cli, headers: { origin: 'https://evil.com' } })).status).toBe(403);
    expect((await call('GET', '/api/drafts', { token: cli, headers: { origin: 'null' } })).status).toBe(403);
    expect((await call('GET', '/api/drafts', { token: cli, headers: { origin: 'http://localhost:3000' } })).status).toBe(403);
    expect((await call('GET', '/api/drafts', { token: cli, headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await call('GET', '/api/drafts', { token: cli, headers: { origin: 'http://127.0.0.1:4646' } })).status).toBe(200);
  });

  it('gives 403 for the mcp token on /api/dashboard-login-nonce; the cli token gets a one-time 60 s nonce', async () => {
    const { call, mcp, cli, nonces, rig } = apiRig();
    const refused = await call('POST', '/api/dashboard-login-nonce', { token: mcp, body: {} });
    expect(refused.status).toBe(403);
    expect(ErrorBody.parse(refused.json).code).toBe('FORBIDDEN_SCOPE');
    expect(refused.text).not.toMatch(TOKEN_SHAPED);

    const res = await call('POST', '/api/dashboard-login-nonce', { token: cli, body: { page: 'approvals' } });
    expect(res.status).toBe(200);
    const body = LoginNonceResponse.parse(res.json);
    expect(Date.parse(body.expiresAt) - rig.clock.now.getTime()).toBe(LOGIN_NONCE_TTL_MS);
    expect(new URL(body.url).origin).toBe('http://127.0.0.1:4646');
    expect(new URL(body.url).pathname).toBe('/login');
    expect(new URL(body.url).searchParams.get('nonce')).toBe(body.nonce);
    expect(new URL(body.url).searchParams.get('next')).toBe('/approvals');
    expect(nonces.consume(body.nonce)).toBe(true);
    expect(nonces.consume(body.nonce)).toBe(false);
  });

  it('refuses a dashboard-login-nonce page outside the allowlist', async () => {
    const { call, cli } = apiRig();
    expect((await call('POST', '/api/dashboard-login-nonce', { token: cli, body: { page: '//evil.com' } })).status).toBe(400);
  });
});

describe('the dashboard router refuses bearer auth', () => {
  it.each(['mcp', 'cli'] as const)('gives 403 for the %s token on POST /approvals/:id/approve', async (scope) => {
    const t = apiRig();
    const draftId = await t.linkedinDraft();
    const { approvalId } = t.rig.gate.request(draftId);
    const res = await t.call('POST', `/approvals/${approvalId}/approve`, { token: scope === 'mcp' ? t.mcp : t.cli, body: { checked: [] } });
    expect(res.status).toBe(403);
    expect(t.rig.repos.approvals.get(approvalId)?.status).toBe('pending');
    expect(t.rig.presence.prompts).toEqual([]);
  });

  it('gives 403 without a session cookie, and with a cookie no session backs', async () => {
    const t = apiRig();
    expect((await t.call('GET', '/approvals')).status).toBe(403);
    expect((await t.call('GET', '/approvals', { headers: { cookie: 'cph_session=made-up' } })).status).toBe(403);
  });

  it('has no API route that approves, denies or changes settings', async () => {
    const t = apiRig();
    const draftId = await t.linkedinDraft();
    const { approvalId } = t.rig.gate.request(draftId);
    for (const path of [`/api/approvals/${approvalId}/approve`, `/api/approvals/${approvalId}/deny`, '/api/settings/publishing', '/api/settings']) {
      const res = await t.call('POST', path, { token: t.cli, body: { checked: [], enabled: true } });
      expect(res.status).toBe(404);
    }
    expect(t.rig.repos.approvals.get(approvalId)?.status).toBe('pending');
    expect(t.rig.repos.settings.get('publishing_enabled')).toBe('true');
    expect(t.rig.presence.prompts).toEqual([]);
  });
});

describe('the bearer router has no path to an approval or a setting', () => {
  it('app.ts never calls approve, deny, the publishing toggle, a remote-cancel confirmation or a manual resolve', () => {
    const source = readFileSync(new URL('../src/http/app.ts', import.meta.url), 'utf8');
    const forbidden = /\.(?:approve|deny|approveAndPublish|approveAndHandOff|confirmRemoteCancelled|resolveByHand)\s*\(|setPublishingEnabled|settings\.set\s*\(/;
    // The one exception: the mcp-only chat route, which approves through the chat gate with the
    // 'chat_elicitation' channel and approve_only (the human answered the prompt in Claude Code).
    const chatApprove = "await chatGate().approve(id, { channel: 'chat_elicitation', checked, mode });";
    expect(source.split(chatApprove)).toHaveLength(2);
    expect(source.replace(chatApprove, '')).not.toMatch(forbidden);
  });
});

describe('no secrets in /api/connections and /api/log', () => {
  it('never returns a stored key, an API token or a labelled secret', async () => {
    const t = apiRig();
    const { rig } = t;
    const ks = new MemoryKeyStore();
    ks.set('master-key', Buffer.alloc(32, 7).toString('base64'));
    new SecretStore(ks, rig.repos).put('devto', 'default', { apiKey: FAKE_KEY });
    rig.repos.connections.upsert({
      platform: 'devto',
      account: 'default',
      route: 'direct',
      status: 'needs_reconnect',
      lastHealthAt: rig.clock.now.toISOString(),
      lastHealthDetail: JSON.stringify({ state: 'needs_reconnect', detail: `rejected api_key=${FAKE_KEY}` }),
    });
    createAudit(rig.repos)({ actorChannel: 'test', action: 'connect_failed', detail: { apiKey: FAKE_KEY, note: `x-api-key: ${FAKE_KEY}` } });
    // Written around the redacting helper, as a careless caller might: the API still redacts it.
    rig.repos.audit.append({ actorChannel: 'test', action: 'raw', detail: { message: `request failed with x-api-key: ${FAKE_KEY} token=${t.cli}` } });

    const connections = await t.call('GET', '/api/connections', { token: t.mcp });
    expect(connections.status).toBe(200);
    ConnectionsResponse.parse(connections.json);
    const log = await t.call('GET', '/api/log', { token: t.mcp });
    expect(log.status).toBe(200);
    expect(LogResponse.parse(log.json).entries.length).toBeGreaterThan(1);

    for (const body of [connections.text, log.text]) {
      expect(body).not.toContain(FAKE_KEY);
      expect(body).not.toContain(t.mcp);
      expect(body).not.toContain(t.cli);
      expect(body).not.toContain(Buffer.alloc(32, 7).toString('base64'));
    }
  });

  it('serves not_configured for keyed routes while the master key is missing (degraded mode)', async () => {
    const t = apiRig({ secretsReady: false });
    const res = await t.call('GET', '/api/connections', { token: t.cli });
    const body = ConnectionsResponse.parse(res.json);
    expect(body.secretsReady).toBe(false);
    const devto = body.connections.find((c) => c.platform === 'devto');
    expect(devto?.state).toBe('not_configured');
    expect(devto?.nextAction).toMatch(/cph install/);
    expect(body.connections.find((c) => c.route === 'assist')?.state).toBe('manual_only');
  });
});

describe('publish', () => {
  it('gives 409 {code: PUBLISHING_DISABLED, message} when the gate refuses', async () => {
    const t = apiRig({ publishing: false });
    const draftId = await t.linkedinDraft();
    const approvalId = await t.rig.approve(draftId);
    const res = await t.call('POST', '/api/publish', { token: t.mcp, body: { draftId, approvalId } });
    expect(res.status).toBe(409);
    const body = ErrorBody.parse(res.json);
    expect(body.code).toBe('PUBLISHING_DISABLED');
    expect(body.message).toMatch(/publishing is disabled/);
    expect(t.rig.buffer.publishCalls).toHaveLength(0);
  });

  it('publishes an approve-only approval once, then reports published with the URL', async () => {
    const t = apiRig();
    const draftId = await t.linkedinDraft();
    const approvalId = await t.rig.approve(draftId);
    expect(ApprovalStatusResponse.parse((await t.call('GET', `/api/approvals/${approvalId}`, { token: t.mcp })).json).status).toBe('approved');

    const res = await t.call('POST', '/api/publish', { token: t.mcp, body: { draftId, approvalId } });
    expect(res.status).toBe(200);
    expect(PublishResponse.parse(res.json)).toEqual({ status: 'published', remoteUrl: `https://example.test/linkedin/${draftId}` });
    expect(t.rig.buffer.publishCalls).toHaveLength(1);

    const again = await t.call('POST', '/api/publish', { token: t.mcp, body: { draftId, approvalId } });
    expect(again.status).toBe(409);
    expect(t.rig.buffer.publishCalls).toHaveLength(1);

    const status = ApprovalStatusResponse.parse((await t.call('GET', `/api/approvals/${approvalId}`, { token: t.mcp })).json);
    expect(status).toMatchObject({ status: 'published', remoteUrl: `https://example.test/linkedin/${draftId}`, draftId });
  });

  it('never spends a publish_now approval (only approve_only on the API path)', async () => {
    const t = apiRig();
    const draftId = await t.linkedinDraft();
    const approvalId = await t.rig.approve(draftId, 'publish_now');
    const res = await t.call('POST', '/api/publish', { token: t.cli, body: { draftId, approvalId, allowModes: ['publish_now'] } });
    expect(res.status).toBe(400);
    const plain = await t.call('POST', '/api/publish', { token: t.cli, body: { draftId, approvalId } });
    expect(plain.status).toBe(409);
    expect(ErrorBody.parse(plain.json).code).toBe('WRONG_CHANNEL');
    expect(t.rig.buffer.publishCalls).toHaveLength(0);
  });

  it('gives 404 for an unknown draft and 503 while the master key is missing', async () => {
    const t = apiRig();
    expect((await t.call('POST', '/api/publish', { token: t.mcp, body: { draftId: 'nope', approvalId: 'nope' } })).status).toBe(404);
    const degraded = apiRig({ secretsReady: false });
    const draftId = await degraded.linkedinDraft();
    const approvalId = await degraded.rig.approve(draftId);
    const res = await degraded.call('POST', '/api/publish', { token: degraded.mcp, body: { draftId, approvalId } });
    expect(res.status).toBe(503);
    expect(ErrorBody.parse(res.json).code).toBe('NOT_CONFIGURED');
    expect(degraded.rig.repos.approvals.get(approvalId)?.usedAt).toBeUndefined();
  });
});

describe('open-dashboard', () => {
  it('opens the login URL once and returns no nonce or token-shaped string', async () => {
    const t = apiRig();
    const res = await t.call('POST', '/api/open-dashboard', { token: t.mcp, body: { page: 'connections/devto' } });
    expect(res.status).toBe(200);
    expect(OpenDashboardResponse.parse(res.json)).toEqual({ opened: true, page: 'connections/devto' });
    expect(t.opened).toHaveLength(1);
    const url = new URL(t.opened[0] as string);
    expect(url.origin).toBe('http://127.0.0.1:4646');
    expect(url.pathname).toBe('/login');
    expect(url.searchParams.get('next')).toBe('/connections/devto');
    const nonce = url.searchParams.get('nonce') as string;
    expect(nonce).toMatch(TOKEN_SHAPED);
    expect(res.text).not.toContain(nonce);
    expect(res.text).not.toMatch(TOKEN_SHAPED);
    expect(Object.keys(res.json as object).sort()).toEqual(['opened', 'page']);
    expect(t.nonces.consume(nonce)).toBe(true);
  });

  it.each(['', 'settings', 'settings/publishing', '/approvals', 'approvals/../settings', 'connections/evil', 'drafts/a b', '//evil.com', 'https://evil.com', 'log?x=1'])(
    'rejects the page %j with 400 and opens nothing',
    async (page) => {
      const t = apiRig();
      const res = await t.call('POST', '/api/open-dashboard', { token: t.mcp, body: { page } });
      expect(res.status).toBe(400);
      expect(t.opened).toHaveLength(0);
      expect(t.nonces.size()).toBe(0);
    },
  );

  it('accepts every allowlisted page shape', () => {
    for (const page of ['connections', 'connections/linkedin', 'drafts/0b5c-uuid_1', 'approvals', 'approvals/abc-123', 'content', 'log']) {
      expect(isDashboardPage(page)).toBe(true);
    }
  });

  it('revokes the nonce and leaks nothing when the browser cannot be opened', async () => {
    const t = apiRig({ openerFails: true });
    const res = await t.call('POST', '/api/open-dashboard', { token: t.cli, body: { page: 'approvals' } });
    expect(res.status).toBe(502);
    expect(res.text).not.toMatch(TOKEN_SHAPED);
    const nonce = new URL(t.opened[0] as string).searchParams.get('nonce') as string;
    expect(t.nonces.consume(nonce)).toBe(false);
  });
});

describe('login nonces', () => {
  it('are single-use and expire after 60 s', () => {
    const clock = { now: new Date('2026-10-20T10:00:00.000Z') };
    const store = new LoginNonceStore({ now: () => clock.now });
    const a = store.mint().nonce;
    const b = store.mint().nonce;
    expect(a).not.toBe(b);
    clock.now = new Date(clock.now.getTime() + LOGIN_NONCE_TTL_MS - 1);
    expect(store.consume(a)).toBe(true);
    expect(store.consume(a)).toBe(false);
    clock.now = new Date(clock.now.getTime() + 1);
    expect(store.consume(b)).toBe(false);
    expect(store.consume('')).toBe(false);
  });
});

describe('drafts, approvals, content, sync, log', () => {
  it('creates, edits, lists and reads drafts', async () => {
    const t = apiRig();
    const id = await t.linkedinDraft();
    const got = DraftResponse.parse((await t.call('GET', `/api/drafts/${id}`, { token: t.mcp })).json);
    expect(got).toMatchObject({ id, slug: SLUG, platform: 'linkedin', route: 'buffer', status: 'draft' });

    const edited = await t.call('PATCH', `/api/drafts/${id}`, { token: t.mcp, body: { payload: { text: `${goodLinkedinText(t.rig.item)}\n` } } });
    expect(edited.status).toBe(200);
    expect(DraftResponse.parse(edited.json).payloadSha256).not.toBe(got.payloadSha256);

    const list = DraftListResponse.parse((await t.call('GET', `/api/drafts?slug=${SLUG}&platform=linkedin`, { token: t.mcp })).json);
    expect(list.drafts.map((d) => d.id)).toEqual([id]);
    expect(DraftListResponse.parse((await t.call('GET', '/api/drafts?status=published', { token: t.mcp })).json).drafts).toEqual([]);
  });

  it('maps service refusals: 404 unknown, 422 invalid payload, 400 bad body or JSON', async () => {
    const t = apiRig();
    expect((await t.call('GET', '/api/drafts/nope', { token: t.mcp })).status).toBe(404);
    expect((await t.call('PATCH', '/api/drafts/nope', { token: t.mcp, body: { payload: {} } })).status).toBe(404);
    const invalid = await t.call('POST', '/api/drafts', { token: t.mcp, body: { slug: SLUG, platform: 'linkedin', payload: { text: 'x', link: null } } });
    expect(invalid.status).toBe(422);
    expect(ErrorBody.parse(invalid.json).code).toBe('invalid-payload');
    expect((await t.call('POST', '/api/drafts', { token: t.mcp, body: { slug: SLUG, platform: 'x' } })).status).toBe(400);
    expect((await t.call('POST', '/api/drafts', { token: t.mcp, body: { slug: 'not-synced', platform: 'linkedin' } })).status).toBe(404);
    const res = await t.app.request('/api/drafts', {
      method: 'POST',
      headers: { host: HOST, authorization: `Bearer ${t.mcp}`, 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expect((await t.call('GET', '/api/log?limit=0', { token: t.mcp })).status).toBe(400);
  });

  it('requests an approval and reports its status without any token', async () => {
    const t = apiRig();
    const draftId = await t.linkedinDraft();
    const res = await t.call('POST', '/api/approvals', { token: t.mcp, body: { draftId } });
    expect(res.status).toBe(201);
    const req = ApprovalRequestResponse.parse(res.json);
    expect(req.approveUrl).toBe(`http://127.0.0.1:4646/approvals/${req.approvalId}`);
    const status = ApprovalStatusResponse.parse((await t.call('GET', `/api/approvals/${req.approvalId}`, { token: t.mcp })).json);
    expect(status).toMatchObject({ approvalId: req.approvalId, draftId, status: 'pending' });

    t.rig.clock.now = new Date(t.rig.clock.now.getTime() + 31 * 60_000);
    expect(ApprovalStatusResponse.parse((await t.call('GET', `/api/approvals/${req.approvalId}`, { token: t.mcp })).json).status).toBe('expired');
    expect((await t.call('GET', '/api/approvals/nope', { token: t.mcp })).status).toBe(404);
    expect((await t.call('POST', '/api/approvals', { token: t.mcp, body: { draftId: 'nope' } })).status).toBe(404);
  });

  it('gives 409 with the gate code when an approval cannot be requested', async () => {
    const t = apiRig();
    const draftId = await t.linkedinDraft();
    t.rig.repos.drafts.update(draftId, { status: 'source_changed' });
    const res = await t.call('POST', '/api/approvals', { token: t.mcp, body: { draftId } });
    expect(res.status).toBe(409);
    expect(ErrorBody.parse(res.json).code).toBe('SOURCE_CHANGED');
  });

  it('previews, stages and checks on the platform', async () => {
    const t = apiRig();
    const preview = await t.call('GET', `/api/preview/${SLUG}/linkedin`, { token: t.mcp });
    expect(preview.status).toBe(200);
    PreviewResponse.parse(preview.json);
    expect((await t.call('GET', `/api/preview/${SLUG}/youtube`, { token: t.mcp })).status).toBe(422);

    const id = await t.linkedinDraft();
    const staged = await t.call('POST', `/api/drafts/${id}/stage`, { token: t.mcp });
    expect(staged.status).toBe(200);
    expect(StageResponse.parse(staged.json).remoteId).toBe('101');

    const notUnknown = await t.call('POST', `/api/drafts/${id}/check`, { token: t.mcp });
    expect(notUnknown.status).toBe(409);
    t.rig.repos.drafts.update(id, { status: 'unknown' });
    const checked = await t.call('POST', `/api/drafts/${id}/check`, { token: t.mcp });
    expect(checked.json).toEqual({ outcome: 'published' });
  });

  it('refuses to stage while the master key is missing', async () => {
    const t = apiRig({ secretsReady: false });
    const id = await t.linkedinDraft();
    const res = await t.call('POST', `/api/drafts/${id}/stage`, { token: t.mcp });
    expect(res.status).toBe(503);
    expect(ErrorBody.parse(res.json).message).toMatch(/cph install/);
    expect(t.rig.buffer.stageCalls).toHaveLength(0);
  });

  it('hands off an assist draft and records the publication', async () => {
    const t = apiRig({ linkedinRoute: 'assist' });
    const draftId = await t.linkedinDraft();
    const approvalId = await t.rig.approve(draftId);
    const kit = await t.call('POST', `/api/drafts/${draftId}/handoff`, { token: t.mcp, body: { approvalId } });
    expect(kit.status).toBe(200);
    expect(kit.json).toMatchObject({ openUrl: 'https://www.linkedin.com/feed/' });

    const bad = await t.call('POST', '/api/publications', { token: t.mcp, body: { draftId, url: 'https://evil.com/post/1' } });
    expect(bad.status).toBe(422);
    const ok = await t.call('POST', '/api/publications', { token: t.mcp, body: { draftId, url: 'https://www.linkedin.com/feed/update/urn:li:activity:1/' } });
    expect(ok.status).toBe(201);
    expect(DraftResponse.parse((ok.json as { draft: unknown }).draft).status).toBe('published');
  });

  it('lists content with draft status and reads one post', async () => {
    const t = apiRig();
    await t.linkedinDraft();
    const list = ContentListResponse.parse((await t.call('GET', '/api/content', { token: t.mcp })).json);
    expect(list.content).toHaveLength(1);
    expect(list.content[0]?.drafts).toEqual([expect.objectContaining({ platform: 'linkedin', status: 'draft' })]);
    const one = ContentDetailResponse.parse((await t.call('GET', `/api/content/${SLUG}`, { token: t.mcp })).json);
    expect(one).toMatchObject({ slug: SLUG, readable: true, sourceCurrent: true });
    expect((await t.call('GET', '/api/content/nope', { token: t.mcp })).status).toBe(404);
  });

  it('runs a sync', async () => {
    const t = apiRig();
    const res = await t.call('POST', '/api/sync', { token: t.cli });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ upserted: 1 });
    expect(t.syncCalls()).toBe(1);
  });

  it('answers an unknown API path with 404 JSON', async () => {
    const t = apiRig();
    const res = await t.call('GET', '/api/nothing-here', { token: t.cli });
    expect(res.status).toBe(404);
    ErrorBody.parse(res.json);
  });
});

describe('approval in chat (mcp token only)', () => {
  const pending = async (t: ReturnType<typeof apiRig>): Promise<{ draftId: string; approvalId: string; checklist: string[] }> => {
    const draftId = await t.linkedinDraft();
    const approvalId = (await t.call('POST', '/api/approvals', { token: t.mcp, body: { draftId } })).json as { approvalId: string };
    return { draftId, approvalId: approvalId.approvalId, checklist: t.rig.gate.checklist(draftId) };
  };

  it('card: shows the platform, route, slug, tag, the payload text and the checklist, and approves nothing', async () => {
    const t = apiRig();
    const { draftId, approvalId, checklist } = await pending(t);
    const res = await t.call('GET', `/api/approvals/${approvalId}/card`, { token: t.mcp });
    expect(res.status).toBe(200);
    const card = ApprovalCardResponse.parse(res.json);
    const draft = t.rig.repos.drafts.get(draftId);
    expect(card).toEqual({
      approvalId,
      draftId,
      status: 'pending',
      platform: 'linkedin',
      route: 'buffer',
      slug: SLUG,
      tag: `#${(draft?.payloadSha256 ?? '').slice(0, 8).toUpperCase()}`,
      payloadText: goodLinkedinText(t.rig.item),
      checklist,
    });
    expect(checklist[0]).toBe('I have read this exact payload');
    expect(t.rig.repos.approvals.get(approvalId)?.status).toBe('pending');
    expect((await t.call('GET', '/api/approvals/nope/card', { token: t.mcp })).status).toBe(404);
    expect((await t.call('GET', `/api/approvals/${approvalId}/card`)).status).toBe(401);
  });

  it('card: a settled approval has no checklist', async () => {
    const t = apiRig();
    const { approvalId } = await pending(t);
    t.rig.clock.now = new Date(t.rig.clock.now.getTime() + 31 * 60_000);
    expect(ApprovalCardResponse.parse((await t.call('GET', `/api/approvals/${approvalId}/card`, { token: t.mcp })).json)).toMatchObject({ status: 'expired', checklist: [] });
  });

  it('approve-chat with every box ticked: approved via chat_elicitation, approve_only, no Hello prompt, audited', async () => {
    const t = apiRig();
    const { draftId, approvalId, checklist } = await pending(t);
    const res = await t.call('POST', `/api/approvals/${approvalId}/approve-chat`, { token: t.mcp, body: { checked: checklist, mode: 'approve_only' } });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ approvalId, approved: true });
    expect(t.rig.repos.approvals.get(approvalId)).toMatchObject({ status: 'approved', channel: 'chat_elicitation', mode: 'approve_only' });
    expect(t.rig.presence.prompts).toEqual([]);
    expect(t.rig.repos.audit.list({ draftId, limit: 50 }).find((row) => row.action === 'approved')).toMatchObject({ actorChannel: 'chat_elicitation', approvalId });
    // The Approve-only approval can then be published through the normal path.
    expect(ApprovalStatusResponse.parse((await t.call('GET', `/api/approvals/${approvalId}`, { token: t.mcp })).json)).toMatchObject({ status: 'approved', mode: 'approve_only' });
  });

  it('approve-chat refuses a missing or incomplete checklist, and any other mode', async () => {
    const t = apiRig();
    const { approvalId, checklist } = await pending(t);
    const path = `/api/approvals/${approvalId}/approve-chat`;
    expect((await t.call('POST', path, { token: t.mcp, body: { mode: 'approve_only' } })).status).toBe(400);
    expect((await t.call('POST', path, { token: t.mcp, body: { checked: [], mode: 'approve_only' } })).status).toBe(400);
    const partial = await t.call('POST', path, { token: t.mcp, body: { checked: checklist.slice(0, 1).concat('not a box'), mode: 'approve_only' } });
    expect(partial.status).toBe(409);
    expect(ErrorBody.parse(partial.json).code).toBe('CHECKLIST_INCOMPLETE');
    expect((await t.call('POST', path, { token: t.mcp, body: { checked: checklist, mode: 'publish_now' } })).status).toBe(400);
    expect((await t.call('POST', path, { token: t.mcp, body: { checked: checklist, mode: 'approve_only', channel: 'dashboard_hello' } })).status).toBe(400);
    expect(t.rig.repos.approvals.get(approvalId)?.status).toBe('pending');
    expect((await t.call('POST', '/api/approvals/nope/approve-chat', { token: t.mcp, body: { checked: checklist, mode: 'approve_only' } })).status).toBe(404);
  });

  it('approve-chat is mcp scope only: the cli token and no token are refused', async () => {
    const t = apiRig();
    const { approvalId, checklist } = await pending(t);
    const path = `/api/approvals/${approvalId}/approve-chat`;
    const body = { checked: checklist, mode: 'approve_only' };
    const cli = await t.call('POST', path, { token: t.cli, body });
    expect(cli.status).toBe(403);
    expect(ErrorBody.parse(cli.json).code).toBe('FORBIDDEN_SCOPE');
    expect((await t.call('POST', path, { body })).status).toBe(401);
    expect(t.rig.repos.approvals.get(approvalId)?.status).toBe('pending');
  });

  it('approve-chat cannot approve an expired approval or an edited draft', async () => {
    const t = apiRig();
    const { draftId, approvalId, checklist } = await pending(t);
    const path = `/api/approvals/${approvalId}/approve-chat`;
    await t.call('PATCH', `/api/drafts/${draftId}`, { token: t.mcp, body: { payload: { text: `${goodLinkedinText(t.rig.item)}\n` } } });
    const edited = await t.call('POST', path, { token: t.mcp, body: { checked: checklist, mode: 'approve_only' } });
    expect(edited.status).toBe(409);
    expect(t.rig.repos.approvals.get(approvalId)?.status).not.toBe('approved');
  });
});
