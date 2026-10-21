import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyStaticAssets } from '../scripts/copy-assets.mjs';
import type { Draft } from '@cph/core';
import { recomputeHash } from '../src/gate/prechecks.js';
import { createApp } from '../src/http/app.js';
import { createTokenVerifier, LoginNonceStore, SESSION_IDLE_MS, SessionStore } from '../src/http/auth.js';
import { createDashboardRouter, safeLink, safeNext, type BufferChannelsAccess } from '../src/http/dashboard.js';
import { escapeHtml, html, raw } from '../src/http/views/html.js';
import { renderMarkdown } from '../src/http/views/markdown.js';
import { DevtoRoute } from '../src/routes/devto.js';
import { issueApiToken, MASTER_KEY_NAME, MemoryKeyStore } from '../src/secrets/keystore.js';
import { SecretStore } from '../src/secrets/secret-store.js';
import { ApiBudget } from '../src/services/api-budget.js';
import { ConnectionsService } from '../src/services/connections.js';
import type { SyncResult } from '../src/sync.js';
import { FakeRoute } from './helpers/fake-route.js';
import { goodLinkedinText, makeRig, SLUG, type RigOptions } from './helpers/service-rig.js';

const HOST = '127.0.0.1:4646';
/** Obviously fake; never a real provider key shape. */
const FAKE_DEVTO_KEY = 'not-a-real-devto-key-0123456789abcdef';
const SIGN_IN_TEXT = 'or ask Claude to open the dashboard, to sign in';
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/http/${name}.json`, import.meta.url), 'utf8');

interface DashOptions extends RigOptions {
  publishing?: boolean;
  secretsReady?: boolean;
  bufferChannels?: BufferChannelsAccess;
  /** A keystore for routes built in `routes` (the dev.to connect test). */
  keystore?: MemoryKeyStore;
}

interface Res {
  status: number;
  text: string;
  headers: Headers;
}

interface RequestOptions {
  form?: Record<string, string | string[]>;
  json?: unknown;
  headers?: Record<string, string>;
  /** Send the jar's cookies (default true). */
  cookies?: boolean;
  /** Add this session's CSRF token as the `_csrf` field (default true for POST/PATCH). */
  csrf?: boolean;
}

function dashRig(options: DashOptions = {}) {
  const rig = makeRig(options);
  if (options.publishing === false) rig.repos.settings.set('publishing_enabled', 'false');
  const ks = new MemoryKeyStore();
  const mcp = issueApiToken(ks, 'mcp');
  const now = (): Date => rig.clock.now;
  const nonces = new LoginNonceStore({ now });
  const sessions = new SessionStore({ now });
  const connections = new ConnectionsService({ repos: rig.repos, routes: rig.routes, config: () => rig.config, audit: rig.audit, now });
  const logs: string[] = [];
  const dashboard = createDashboardRouter({
    sessions,
    nonces,
    repos: rig.repos,
    gate: rig.gate,
    publish: rig.publish,
    drafts: rig.drafts,
    recovery: rig.recovery,
    connections,
    presence: rig.presence,
    routes: rig.routes,
    ...(options.bufferChannels === undefined ? {} : { bufferChannels: options.bufferChannels }),
    budget: new ApiBudget(rig.repos, now),
    config: () => rig.config,
    secretsReady: () => options.secretsReady ?? true,
    audit: rig.audit,
    now,
    log: (level, message) => logs.push(`${level} ${message}`),
  });
  const app = createApp({
    tokens: createTokenVerifier(ks),
    nonces,
    opener: () => Promise.resolve(),
    repos: rig.repos,
    drafts: rig.drafts,
    publish: rig.publish,
    recovery: rig.recovery,
    gate: rig.gate,
    connections,
    sync: (): Promise<SyncResult> => Promise.resolve({ upserted: 0, changed: [], invalidatedApprovals: 0, errors: [] }),
    loadContentItem: (slug) => (slug === SLUG ? rig.item : undefined),
    secretsReady: () => options.secretsReady ?? true,
    now,
    dashboard,
    log: (level, message) => logs.push(`${level} ${message}`),
  });

  const jar = new Map<string, string>();
  let csrfToken: string | undefined;

  const request = async (method: string, path: string, opts: RequestOptions = {}): Promise<Res> => {
    const headers: Record<string, string> = { host: HOST, ...opts.headers };
    if (opts.cookies !== false && jar.size > 0) headers['cookie'] = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body: string | undefined;
    const writes = method !== 'GET' && method !== 'HEAD';
    if (opts.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.json);
    } else if (writes) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.form ?? {})) for (const item of Array.isArray(v) ? v : [v]) params.append(k, item);
      if (opts.csrf !== false && csrfToken !== undefined) params.append('_csrf', csrfToken);
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = params.toString();
    }
    const res = await app.request(path, { method, headers, ...(body === undefined ? {} : { body }) });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie !== null) {
      const [pair] = setCookie.split(';');
      const [name, value] = (pair as string).split('=') as [string, string];
      jar.set(name.trim(), value.trim());
    }
    return { status: res.status, text: await res.text(), headers: res.headers };
  };

  /** Mints a nonce like `cph dashboard` does, signs in, and reads this session's CSRF token. */
  const signIn = async (next = '/approvals'): Promise<Res> => {
    const { nonce } = nonces.mint();
    const res = await request('GET', `/login?nonce=${encodeURIComponent(nonce)}&next=${encodeURIComponent(next)}`);
    const page = await request('GET', '/approvals');
    csrfToken = /<meta name="csrf-token" content="([^"]+)">/.exec(page.text)?.[1];
    return res;
  };

  const linkedinDraft = (text = goodLinkedinText(rig.item)): string =>
    rig.drafts.create({ slug: SLUG, platform: 'linkedin', payload: { text } }).id;
  const pendingApproval = (): { draftId: string; approvalId: string } => {
    const draftId = linkedinDraft();
    return { draftId, approvalId: rig.gate.request(draftId).approvalId };
  };

  return { rig, app, nonces, sessions, mcp, jar, logs, request, signIn, linkedinDraft, pendingApproval, csrf: () => csrfToken as string };
}

describe('sign-in', () => {
  it('GET /approvals without a cookie redirects to the sign-in page', async () => {
    const t = dashRig();
    const res = await t.request('GET', '/approvals');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/signin');
    const page = await t.request('GET', '/signin');
    expect(page.status).toBe(200);
    expect(page.text).toContain('Run <code>cph dashboard</code>, or ask Claude to open the dashboard, to sign in');
  });

  it('GET /login?nonce=…&next=/connections/devto signs in and lands on that page', async () => {
    const t = dashRig();
    const { nonce } = t.nonces.mint();
    const res = await t.request('GET', `/login?nonce=${nonce}&next=/connections/devto`);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/connections/devto');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^cph_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    const page = await t.request('GET', '/connections/devto');
    expect(page.status).toBe(200);
    expect(page.text).toContain('https://dev.to/settings/extensions');
  });

  it('a reused nonce gives 403', async () => {
    const t = dashRig();
    const { nonce } = t.nonces.mint();
    expect((await t.request('GET', `/login?nonce=${nonce}&next=/approvals`)).status).toBe(303);
    t.jar.clear();
    const again = await t.request('GET', `/login?nonce=${nonce}&next=/approvals`);
    expect(again.status).toBe(403);
    expect(again.headers.get('set-cookie')).toBeNull();
    expect((await t.request('GET', '/login?next=/approvals')).status).toBe(403);
  });

  it.each(['//evil.com', 'https://evil.com', '/settings', '/approvals/../settings', 'approvals', '/log?x=1'])(
    'refuses next=%s as an open redirect and lands on /approvals',
    async (next) => {
      const t = dashRig();
      const { nonce } = t.nonces.mint();
      const res = await t.request('GET', `/login?nonce=${nonce}&next=${encodeURIComponent(next)}`);
      expect(res.headers.get('location')).toBe('/approvals');
    },
  );

  it('accepts the Buffer connect card as a login target', () => {
    expect(safeNext('/connections/buffer')).toBe('/connections/buffer');
    expect(safeNext('/approvals/abc-123')).toBe('/approvals/abc-123');
    expect(safeNext(null)).toBe('/approvals');
  });

  it('refuses an API bearer token on every dashboard route, signed in or not', async () => {
    const t = dashRig();
    await t.signIn();
    const { approvalId } = t.pendingApproval();
    for (const [method, path] of [
      ['GET', '/approvals'],
      ['GET', '/login?nonce=x'],
      ['POST', `/approvals/${approvalId}/approve`],
      ['POST', '/settings/publishing'],
    ] as const) {
      const res = await t.request(method, path, { headers: { authorization: `Bearer ${t.mcp}` }, form: { action: 'only' } });
      expect(res.status).toBe(403);
    }
    expect(t.rig.repos.approvals.get(approvalId)?.status).toBe('pending');
    expect(t.rig.presence.prompts).toEqual([]);
  });

  it('ends a session after 8 hours idle', async () => {
    const t = dashRig();
    await t.signIn();
    expect((await t.request('GET', '/approvals')).status).toBe(200);
    t.rig.clock.now = new Date(t.rig.clock.now.getTime() + SESSION_IDLE_MS);
    expect((await t.request('GET', '/approvals')).headers.get('location')).toBe('/signin');
  });

  it('never writes the login query string to the request log', async () => {
    const t = dashRig();
    const { nonce } = t.nonces.mint();
    await t.request('GET', `/login?nonce=${nonce}&next=/approvals`);
    expect(t.logs.join('\n')).toContain('GET /login 303');
    expect(t.logs.join('\n')).not.toContain(nonce);
    expect(t.logs.join('\n')).not.toContain('?');
  });
});

describe('CSRF', () => {
  it('POST /approvals/:id/approve without CSRF gives 403 and never asks Hello', async () => {
    const t = dashRig();
    await t.signIn();
    const { draftId, approvalId } = t.pendingApproval();
    const checked = t.rig.gate.checklist(draftId);
    const res = await t.request('POST', `/approvals/${approvalId}/approve`, { form: { action: 'only', checked }, csrf: false });
    expect(res.status).toBe(403);
    const wrong = await t.request('POST', `/approvals/${approvalId}/approve`, { form: { action: 'only', checked, _csrf: 'nope' }, csrf: false });
    expect(wrong.status).toBe(403);
    expect(t.rig.repos.approvals.get(approvalId)?.status).toBe('pending');
    expect(t.rig.presence.prompts).toEqual([]);
  });

  it('accepts the token as the HX-CSRF header (htmx)', async () => {
    const t = dashRig();
    await t.signIn();
    const { draftId, approvalId } = t.pendingApproval();
    const res = await t.request('POST', `/approvals/${approvalId}/approve`, {
      form: { action: 'only', checked: t.rig.gate.checklist(draftId) },
      csrf: false,
      headers: { 'hx-csrf': t.csrf(), 'hx-request': 'true' },
    });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<html');
    expect(t.rig.repos.approvals.get(approvalId)?.status).toBe('approved');
  });

  it("refuses another session's token", async () => {
    const t = dashRig();
    await t.signIn();
    const first = t.csrf();
    await t.signIn();
    const { approvalId } = t.pendingApproval();
    const res = await t.request('POST', `/approvals/${approvalId}/deny`, { form: { _csrf: first }, csrf: false });
    expect(res.status).toBe(403);
    expect(t.rig.repos.approvals.get(approvalId)?.status).toBe('pending');
  });
});

describe('the approvals queue', () => {
  it('posting with only one of the boxes ticked gives 422 CHECKLIST_INCOMPLETE', async () => {
    const t = dashRig();
    await t.signIn();
    const { draftId, approvalId } = t.pendingApproval();
    const checklist = t.rig.gate.checklist(draftId);
    expect(checklist.length).toBeGreaterThanOrEqual(2);
    const res = await t.request('POST', `/approvals/${approvalId}/approve`, { form: { action: 'publish', checked: [checklist[0] as string] } });
    expect(res.status).toBe(422);
    expect(res.text).toContain('CHECKLIST_INCOMPLETE');
    expect(t.rig.repos.approvals.get(approvalId)?.status).toBe('pending');
    expect(t.rig.presence.prompts).toEqual([]);
    expect(t.rig.buffer.publishCalls).toHaveLength(0);
  });

  it('Approve only with Hello verified records approved via dashboard_hello', async () => {
    const t = dashRig();
    await t.signIn();
    const { draftId, approvalId } = t.pendingApproval();
    const res = await t.request('POST', `/approvals/${approvalId}/approve`, { form: { action: 'only', checked: t.rig.gate.checklist(draftId) } });
    expect(res.status).toBe(200);
    const approval = t.rig.repos.approvals.get(approvalId);
    expect(approval).toMatchObject({ status: 'approved', channel: 'dashboard_hello', mode: 'approve_only' });
    expect(approval?.presenceVerifiedAt).toBeDefined();
    const hash = t.rig.repos.drafts.get(draftId)?.payloadSha256 as string;
    expect(t.rig.presence.prompts).toEqual([`Approve LinkedIn via buffer · #${hash.slice(0, 8).toUpperCase()} · ${SLUG} · "Prometheus cost follows series count, no…"`]);
    expect(t.rig.buffer.publishCalls).toHaveLength(0);
  });

  it('with Hello canceled the approval stays pending and the response says so', async () => {
    const t = dashRig();
    t.rig.presence.set('canceled');
    await t.signIn();
    const { draftId, approvalId } = t.pendingApproval();
    const res = await t.request('POST', `/approvals/${approvalId}/approve`, { form: { action: 'only', checked: t.rig.gate.checklist(draftId) } });
    expect(res.status).toBe(409);
    expect(res.text).toContain('PRESENCE_FAILED');
    expect(res.text).toContain('Windows Hello was not verified (canceled). The approval is still pending');
    expect(t.rig.repos.approvals.get(approvalId)?.status).toBe('pending');
    // The card is back with its buttons, so the owner can try again.
    expect(res.text).toContain('data-approve-form');
  });

  it('Approve & publish with Hello verified makes exactly one route call and shows the published URL', async () => {
    const t = dashRig();
    await t.signIn();
    const { draftId, approvalId } = t.pendingApproval();
    const res = await t.request('POST', `/approvals/${approvalId}/approve`, { form: { action: 'publish', checked: t.rig.gate.checklist(draftId) } });
    expect(res.status).toBe(200);
    expect(t.rig.buffer.publishCalls).toHaveLength(1);
    expect(t.rig.repos.drafts.get(draftId)?.status).toBe('published');
    expect(t.rig.repos.approvals.get(approvalId)).toMatchObject({ mode: 'publish_now', channel: 'dashboard_hello' });
    expect(res.text).toContain(`https://example.test/linkedin/${draftId}`);

    // A second click (or Claude retrying) cannot post again.
    const again = await t.request('POST', `/approvals/${approvalId}/approve`, { form: { action: 'publish', checked: t.rig.gate.checklist(draftId) } });
    expect(again.status).toBe(409);
    expect(t.rig.buffer.publishCalls).toHaveLength(1);
  });

  it('Approve & publish with Hello canceled sends nothing', async () => {
    const t = dashRig();
    t.rig.presence.set('canceled');
    await t.signIn();
    const { draftId, approvalId } = t.pendingApproval();
    const res = await t.request('POST', `/approvals/${approvalId}/approve`, { form: { action: 'publish', checked: t.rig.gate.checklist(draftId) } });
    expect(res.status).toBe(409);
    expect(t.rig.buffer.publishCalls).toHaveLength(0);
    expect(t.rig.repos.approvals.get(approvalId)?.status).toBe('pending');
  });

  it('a scheduled draft gets Approve & schedule, and refuses Approve & publish before any Hello prompt', async () => {
    const t = dashRig();
    await t.signIn();
    const draftId = t.linkedinDraft();
    const draft = t.rig.repos.drafts.get(draftId) as Draft;
    const scheduledAt = '2026-10-21T09:00:00.000Z';
    t.rig.repos.drafts.update(draftId, { scheduledAt, payloadSha256: recomputeHash({ ...draft, scheduledAt }) });
    const { approvalId } = t.rig.gate.request(draftId);
    const page = await t.request('GET', `/approvals/${approvalId}`);
    expect(page.text).toContain('value="schedule" class="primary" data-approve data-primary disabled>Approve &amp; schedule</button>');
    const checked = t.rig.gate.checklist(draftId);
    expect((await t.request('POST', `/approvals/${approvalId}/approve`, { form: { action: 'publish', checked } })).status).toBe(409);
    expect(t.rig.presence.prompts).toEqual([]);
    const ok = await t.request('POST', `/approvals/${approvalId}/approve`, { form: { action: 'schedule', checked } });
    expect(ok.status).toBe(200);
    expect(t.rig.repos.approvals.get(approvalId)).toMatchObject({ status: 'approved', mode: 'schedule', channel: 'dashboard_hello' });
    expect(t.rig.buffer.publishCalls).toHaveLength(0);
  });

  it('Approve & publish while Publishing is DISABLED is refused before Hello, and nothing is approved', async () => {
    const t = dashRig({ publishing: false });
    await t.signIn();
    const { draftId, approvalId } = t.pendingApproval();
    const res = await t.request('POST', `/approvals/${approvalId}/approve`, { form: { action: 'publish', checked: t.rig.gate.checklist(draftId) } });
    expect(res.status).toBe(409);
    expect(res.text).toContain('PUBLISHING_DISABLED');
    expect(t.rig.presence.prompts).toEqual([]);
    expect(t.rig.repos.approvals.get(approvalId)?.status).toBe('pending');
    expect(t.rig.buffer.publishCalls).toHaveLength(0);
  });

  it('each card shows the tag and preview its Hello prompt will carry; two drafts for one post differ', async () => {
    const t = dashRig();
    await t.signIn();
    const a = t.pendingApproval();
    const bDraft = t.linkedinDraft(`${goodLinkedinText(t.rig.item)}

A second take.`.replace('Prometheus cost', 'Prometheus spend'));
    const b = { draftId: bDraft, approvalId: t.rig.gate.request(bDraft).approvalId };
    const page = await t.request('GET', '/approvals');
    const tags = [...page.text.matchAll(/data-approval-tag>(#[0-9A-F]{8})</g)].map((m) => m[1]);
    const tagOf = (draftId: string): string => `#${(t.rig.repos.drafts.get(draftId)?.payloadSha256 as string).slice(0, 8).toUpperCase()}`;
    expect(new Set(tags)).toEqual(new Set([tagOf(a.draftId), tagOf(b.draftId)]));
    expect(page.text).toContain('<q>Prometheus cost follows series count, no…</q>');
    expect(page.text).toContain('<q>Prometheus spend follows series count, n…</q>');

    for (const { draftId, approvalId } of [a, b]) {
      await t.request('POST', `/approvals/${approvalId}/approve`, { form: { action: 'only', checked: t.rig.gate.checklist(draftId) } });
    }
    const [promptA, promptB] = t.rig.presence.prompts as [string, string];
    expect(promptA).not.toBe(promptB);
    expect(promptA).toContain(tagOf(a.draftId));
    expect(promptB).toContain(tagOf(b.draftId));
    expect(promptB).toContain('"Prometheus spend follows series count, n…"');
  });

  it('links a published URL only when it is https', async () => {
    const t = dashRig();
    t.rig.buffer.publishImpl = (d) => Promise.resolve({ remoteId: `r-${d.id}`, remoteUrl: 'javascript:alert(1)', costUsd: 0 });
    await t.signIn();
    const { draftId, approvalId } = t.pendingApproval();
    const res = await t.request('POST', `/approvals/${approvalId}/approve`, { form: { action: 'publish', checked: t.rig.gate.checklist(draftId) } });
    expect(res.status).toBe(200);
    expect(t.rig.buffer.publishCalls).toHaveLength(1);
    const later = await t.request('GET', `/approvals/${approvalId}`);
    for (const text of [res.text, later.text]) {
      expect(text).not.toMatch(/href="javascript:/i);
      expect(text).toContain('<code>javascript:alert(1)</code>');
    }
    expect(safeLink('https://example.test/p').value).toBe('<a href="https://example.test/p" target="_blank" rel="noopener noreferrer">https://example.test/p</a>');
    expect(safeLink('http://example.test/p').value).toBe('<code>http://example.test/p</code>');
    expect(safeLink('not a url').value).toBe('<code>not a url</code>');
  });

  it('Deny needs no Hello', async () => {
    const t = dashRig();
    t.rig.presence.set('canceled');
    await t.signIn();
    const { approvalId } = t.pendingApproval();
    const res = await t.request('POST', `/approvals/${approvalId}/deny`);
    expect(res.status).toBe(200);
    expect(t.rig.repos.approvals.get(approvalId)?.status).toBe('denied');
    expect(t.rig.presence.prompts).toEqual([]);
  });

  it('shows a LinkedIn draft without link as raw text plus the OG preview line, with no link card', async () => {
    const t = dashRig();
    await t.signIn();
    const { draftId } = t.pendingApproval();
    const page = await t.request('GET', '/approvals');
    expect(page.status).toBe(200);
    expect(page.text).toContain("Preview will be generated by LinkedIn from the page&#39;s OG tags");
    expect(page.text).not.toContain('class="link-card"');
    expect(page.text).toContain('Prometheus cost follows series count');
    // Platform, account, route, cost, Buffer budget (24 h and 30 d), notBefore, the checklist.
    expect(page.text).toContain('<dt>Platform</dt><dd>LinkedIn</dd>');
    expect(page.text).toContain('<dt>Account</dt><dd>default</dd>');
    expect(page.text).toContain('via Buffer');
    expect(page.text).toContain('$0.00');
    expect(page.text).toMatch(/250 of 250 \(24 h\) · 3000 of 3000 \(30 d\)/);
    expect(page.text).toContain('<dt>Not before</dt>');
    for (const item of t.rig.gate.checklist(draftId)) expect(page.text).toContain(`value="${escapeHtml(item)}"`);
    // The approve buttons start disabled; Approve & publish is the primary one (the `a` key).
    expect(page.text).toMatch(/<button type="submit" name="action" value="publish" class="primary" data-approve data-primary disabled>Approve &amp; publish<\/button>/);
    expect(page.text).toMatch(/value="only" data-approve disabled>Approve only</);
    expect(page.text).toContain('Waiting for Windows Hello…');
  });

  it('renders a link card only when the payload carries one', async () => {
    const t = dashRig();
    await t.signIn();
    const id = t.rig.drafts.create({
      slug: SLUG,
      platform: 'linkedin',
      payload: { text: 'Hello', link: { url: 'https://www.example-blog.dev/blog/x', title: 'T', description: 'D', thumbnailUrl: 'https://example.test/t.png' } },
    }).id;
    const page = await t.request('GET', `/drafts/${id}`);
    expect(page.text).toContain('class="link-card"');
    expect(page.text).not.toContain('Preview will be generated by LinkedIn');
  });

  it('shows red cards for unknown drafts, and marking one by hand needs Hello', async () => {
    const t = dashRig();
    await t.signIn();
    const draftId = t.linkedinDraft();
    t.rig.repos.drafts.update(draftId, { status: 'unknown', failureReason: 'timed out' });
    const page = await t.request('GET', '/approvals');
    expect(page.text).toContain('data-red-card="unknown"');
    expect(page.text).toContain('Check on platform');
    expect(page.text).toContain('Mark as posted');
    expect(page.text).toContain('Mark as not posted');

    t.rig.presence.set('canceled');
    const refused = await t.request('POST', `/drafts/${draftId}/resolve`, { form: { outcome: 'failed' } });
    expect(refused.status).toBe(409);
    expect(t.rig.repos.drafts.get(draftId)?.status).toBe('unknown');
    expect(t.rig.presence.prompts).toEqual([`Mark LinkedIn post for ${SLUG} as not posted`]);

    t.rig.presence.set('verified');
    const ok = await t.request('POST', `/drafts/${draftId}/resolve`, { form: { outcome: 'failed' } });
    expect(ok.status).toBe(200);
    expect(t.rig.repos.drafts.get(draftId)?.status).toBe('failed');
  });

  it('refuses a bad post URL before asking Hello', async () => {
    const t = dashRig();
    await t.signIn();
    const draftId = t.linkedinDraft();
    t.rig.repos.drafts.update(draftId, { status: 'unknown' });
    const res = await t.request('POST', `/drafts/${draftId}/resolve`, { form: { outcome: 'published', remoteUrl: 'javascript:alert(1)' } });
    expect(res.status).toBe(422);
    expect(t.rig.presence.prompts).toEqual([]);
    expect(t.rig.repos.drafts.get(draftId)?.status).toBe('unknown');
  });

  it('Check on platform needs no Hello', async () => {
    const t = dashRig();
    await t.signIn();
    const draftId = t.linkedinDraft();
    t.rig.repos.drafts.update(draftId, { status: 'unknown', remoteRef: 'post-1' });
    const res = await t.request('POST', `/drafts/${draftId}/check`);
    expect(res.status).toBe(200);
    expect(t.rig.buffer.checkCalls).toHaveLength(1);
    expect(t.rig.repos.drafts.get(draftId)?.status).toBe('published');
    expect(t.rig.presence.prompts).toEqual([]);
  });

  it('confirming a remote cancel by hand needs Hello', async () => {
    const t = dashRig();
    await t.signIn();
    const draftId = t.linkedinDraft();
    t.rig.repos.drafts.update(draftId, { remoteScheduledId: 'sched-1' });
    expect((await t.request('GET', '/approvals')).text).toContain('data-red-card="cancel_failed"');
    t.rig.presence.set('canceled');
    expect((await t.request('POST', `/drafts/${draftId}/confirm-cancelled`)).status).toBe(409);
    expect(t.rig.repos.drafts.get(draftId)?.remoteScheduledId).toBe('sched-1');
    t.rig.presence.set('verified');
    expect((await t.request('POST', `/drafts/${draftId}/confirm-cancelled`)).status).toBe(200);
    expect(t.rig.repos.drafts.get(draftId)?.remoteScheduledId).toBeUndefined();
  });
});

describe('settings', () => {
  it('POST /settings/publishing {enabled:true} with Hello canceled leaves publishing_enabled false; {enabled:false} needs no Hello', async () => {
    const t = dashRig({ publishing: false });
    t.rig.presence.set('canceled');
    await t.signIn();
    const on = await t.request('POST', '/settings/publishing', { json: { enabled: true }, headers: { 'hx-csrf': t.csrf() } });
    expect(on.status).toBe(409);
    expect(t.rig.repos.settings.get('publishing_enabled')).toBe('false');
    expect(t.rig.presence.prompts).toEqual(['Enable publishing']);

    const off = await t.request('POST', '/settings/publishing', { json: { enabled: false }, headers: { 'hx-csrf': t.csrf() } });
    expect(off.status).toBe(200);
    expect(t.rig.repos.settings.get('publishing_enabled')).toBe('false');
    expect(t.rig.presence.prompts).toHaveLength(1);
  });

  it('turns publishing on with Hello verified, and shows the red banner on every page', async () => {
    const t = dashRig({ publishing: false });
    await t.signIn();
    expect((await t.request('GET', '/connections')).text).not.toContain('class="banner red"');
    const on = await t.request('POST', '/settings/publishing', { form: { enabled: 'true' } });
    expect(on.status).toBe(200);
    expect(t.rig.repos.settings.get('publishing_enabled')).toBe('true');
    for (const path of ['/approvals', '/connections', '/content', '/drafts', '/settings', '/log']) {
      expect((await t.request('GET', path)).text).toContain('<strong>Publishing: ENABLED.</strong>');
    }
  });

  it('dry run ON needs no Hello; OFF does', async () => {
    const t = dashRig();
    t.rig.presence.set('canceled');
    await t.signIn();
    expect((await t.request('POST', '/settings/dry-run/linkedin', { form: { enabled: 'true' } })).status).toBe(200);
    expect(t.rig.repos.settings.get('dry_run:linkedin')).toBe('true');
    expect(t.rig.presence.prompts).toEqual([]);
    expect((await t.request('POST', '/settings/dry-run/linkedin', { form: { enabled: 'false' } })).status).toBe(409);
    expect(t.rig.repos.settings.get('dry_run:linkedin')).toBe('true');
    t.rig.presence.set('verified');
    expect((await t.request('POST', '/settings/dry-run/linkedin', { form: { enabled: 'false' } })).status).toBe(200);
    expect(t.rig.repos.settings.get('dry_run:linkedin')).toBe('false');
    expect(t.rig.presence.prompts).toEqual(['Turn off dry run for LinkedIn', 'Turn off dry run for LinkedIn']);
  });
});

describe('every page', () => {
  it('never contains the string "kill switch"', async () => {
    const t = dashRig();
    await t.signIn();
    const { draftId, approvalId } = t.pendingApproval();
    const paths = [
      '/approvals',
      `/approvals/${approvalId}`,
      '/connections',
      '/connections/devto',
      '/connections/buffer',
      '/connections/medium',
      '/content',
      '/drafts',
      `/drafts/${draftId}`,
      '/settings',
      '/log',
      '/signin',
      '/static/dashboard.js',
      '/static/dashboard.css',
      '/static/app.css',
      '/nowhere',
    ];
    for (const enabled of ['false', 'true']) {
      t.rig.repos.settings.set('publishing_enabled', enabled);
      for (const path of paths) {
        const res = await t.request('GET', path);
        expect(res.status, path).toBeLessThan(path === '/nowhere' ? 500 : 400);
        expect(res.text.toLowerCase(), path).not.toContain('kill switch');
      }
    }
  });

  it('serves the vendored htmx 2.0.11, not a CDN copy', async () => {
    const t = dashRig();
    const res = await t.request('GET', '/static/htmx.min.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(res.text).toContain('version:"2.0.11"');
    await t.signIn();
    const page = await t.request('GET', '/approvals');
    expect(page.text).toContain('<script src="/static/htmx.min.js" defer></script>');
    expect(page.text).not.toMatch(/<script[^>]+src="https?:/);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
  });

  it('serves its own stylesheet and loads no font or style from the network', async () => {
    const t = dashRig();
    const css = await t.request('GET', '/static/app.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(css.text).toContain('--cream: #f7f3eb');
    expect(css.text).not.toMatch(/@import|url\(\s*['"]?https?:/i);
    await t.signIn();
    const page = await t.request('GET', '/approvals');
    expect(page.text).toContain('<link rel="stylesheet" href="/static/app.css">');
    expect(page.text).not.toMatch(/<link[^>]+href="https?:/);
    expect(page.headers.get('content-security-policy')).toContain("style-src 'self'");
  });

  it('renders a draft text with <script> escaped', async () => {
    const t = dashRig();
    await t.signIn();
    const id = t.linkedinDraft('<script>alert("x")</script> and <img src=x onerror=alert(1)>');
    for (const path of [`/drafts/${id}`, '/drafts']) {
      const page = await t.request('GET', path);
      expect(page.text).not.toContain('<script>alert');
      expect(page.text).not.toContain('<img src=x');
    }
    const page = await t.request('GET', `/drafts/${id}`);
    expect(page.text).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });
});

describe('connect cards', () => {
  function devtoRig() {
    const keystore = new MemoryKeyStore();
    keystore.set(MASTER_KEY_NAME, randomBytes(32).toString('base64'));
    const calls: { url: string; key: string | null }[] = [];
    let status = 200;
    const fetchFn: typeof fetch = (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      const key = new Headers(init?.headers).get('api-key');
      calls.push({ url, key });
      if (status !== 200) return Promise.resolve(new Response('{"error":"unauthorized","status":401}', { status }));
      return Promise.resolve(new Response(fixture('devto-user-me'), { status: 200, headers: { 'content-type': 'application/json' } }));
    };
    let secrets: SecretStore | undefined;
    const t = dashRig({
      routes: (repos) => {
        secrets = new SecretStore(keystore, repos);
        return [
          new DevtoRoute({ secrets, fetchFn, now: () => new Date(), markFailed: () => {} }),
          new FakeRoute('linkedin', 'buffer'),
          new FakeRoute('linkedin', 'assist', { handOff: true }),
        ];
      },
    });
    return { t, calls, secrets: () => secrets as SecretStore, setStatus: (s: number) => (status = s) };
  }

  it('the connect-devto POST with a fetch answering 200 stores the secret and shows @username, never the key', async () => {
    const { t, calls, secrets } = devtoRig();
    await t.signIn('/connections/devto');
    const card = await t.request('GET', '/connections/devto');
    expect(card.text).toMatch(/<input id="devto-key" type="password" name="apiKey" autocomplete="off"/);
    const res = await t.request('POST', '/connections/devto', { form: { apiKey: FAKE_DEVTO_KEY } });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ url: 'https://dev.to/api/users/me', key: FAKE_DEVTO_KEY }]);
    expect(secrets().get('devto', 'default')).toEqual({ apiKey: FAKE_DEVTO_KEY });
    expect(res.text).toContain('@owner_test');
    expect(res.text).not.toContain(FAKE_DEVTO_KEY);
    expect(res.text).not.toContain(FAKE_DEVTO_KEY.slice(-6));
    for (const path of ['/connections', '/connections/devto', '/log']) {
      const page = await t.request('GET', path);
      expect(page.text).not.toContain(FAKE_DEVTO_KEY);
    }
    expect((await t.request('GET', '/connections')).text).toContain('@owner_test');
  });

  it('a key dev.to rejects is not stored and not echoed', async () => {
    const { t, secrets, setStatus } = devtoRig();
    setStatus(401);
    await t.signIn();
    const res = await t.request('POST', '/connections/devto', { form: { apiKey: FAKE_DEVTO_KEY } });
    expect(res.status).toBe(422);
    expect(res.text).toContain('rejected the API key');
    expect(res.text).not.toContain(FAKE_DEVTO_KEY);
    expect(secrets().get('devto', 'default')).toBeNull();
  });

  it('refuses to connect in degraded mode (no master key)', async () => {
    const t = dashRig({ secretsReady: false });
    await t.signIn();
    const res = await t.request('POST', '/connections/devto', { form: { apiKey: FAKE_DEVTO_KEY } });
    expect(res.status).toBe(503);
    expect(res.text).toContain('NOT_CONFIGURED');
    expect(res.text).not.toContain(FAKE_DEVTO_KEY);
  });

  it('shows the four U0-B steps and, once channels are known, the LinkedIn mapping select', async () => {
    const channels = [
      { id: 'chan-a', name: 'The owner' },
      { id: 'chan-b', name: 'Another Profile' },
    ];
    const mapped: string[] = [];
    const t = dashRig({
      bufferChannels: {
        linkedinChannels: () => channels,
        mapChannel: (_account, id) => {
          mapped.push(id);
          (t.rig.config.platforms.linkedin as { bufferChannelId?: string }).bufferChannelId = id;
          return { state: 'connected', who: channels.find((c) => c.id === id)?.name as string };
        },
      },
    });
    await t.signIn('/connections/buffer');
    const card = await t.request('GET', '/connections/buffer');
    expect(card.status).toBe(200);
    expect(card.text.match(/<li>/g)?.length).toBe(4);
    expect(card.text).toContain('https://publish.buffer.com/settings/api');
    expect(card.text).toMatch(/<input id="buffer-key" type="password" name="apiKey" autocomplete="off"/);
    expect(card.text).toContain('<select id="buffer-channel" name="channelId">');
    expect(card.text).toContain('The owner');

    // A channel change is Hello-gated and cancels LinkedIn approvals (the channel is part of what was approved).
    const { approvalId } = t.pendingApproval();
    t.rig.presence.set('canceled');
    const refused = await t.request('POST', '/connections/buffer/channel', { form: { channelId: 'chan-b' } });
    expect(refused.status).toBe(409);
    expect(mapped).toEqual([]);
    expect(t.rig.repos.approvals.get(approvalId)?.status).toBe('pending');
    expect(t.rig.presence.prompts).toEqual(['Change LinkedIn channel to Another Profile']);

    t.rig.presence.set('verified');
    const ok = await t.request('POST', '/connections/buffer/channel', { form: { channelId: 'chan-b' } });
    expect(ok.status).toBe(200);
    expect(mapped).toEqual(['chan-b']);
    expect(t.rig.repos.approvals.get(approvalId)?.status).toBe('invalidated');
    expect(ok.text).toContain('LinkedIn posts now go to Another Profile');

    // A channel Buffer did not list is refused before any Hello prompt.
    const bad = await t.request('POST', '/connections/buffer/channel', { form: { channelId: 'chan-zzz' } });
    expect(bad.status).toBe(422);
    expect(t.rig.presence.prompts).toHaveLength(2);
  });

  it('names the route switch in the Hello prompt when mapping a channel creates the buffer route', async () => {
    const t = dashRig({
      bufferChannels: {
        linkedinChannels: () => [{ id: 'chan-a', name: 'The owner' }],
        mapChannel: () => ({ state: 'connected', who: 'The owner' }),
      },
    });
    // No LinkedIn config at all: LinkedIn is on the assist route, and mapping writes route 'buffer'.
    delete (t.rig.config.platforms as { linkedin?: unknown }).linkedin;
    await t.signIn();
    const res = await t.request('POST', '/connections/buffer/channel', { form: { channelId: 'chan-a' } });
    expect(res.status).toBe(200);
    expect(t.rig.presence.prompts).toEqual(['Route LinkedIn via Buffer to The owner']);
  });

  it('an unexpected failure after Hello is a 500 and goes to the daemon log, redacted', async () => {
    const t = dashRig({
      bufferChannels: {
        linkedinChannels: () => [{ id: 'chan-a', name: 'The owner' }],
        mapChannel: () => {
          throw new Error(`disk full; Authorization: Bearer cph_cli_${'Ab1'.repeat(14)}A`);
        },
      },
    });
    await t.signIn();
    const res = await t.request('POST', '/connections/buffer/channel', { form: { channelId: 'chan-a' } });
    expect(res.status).toBe(500);
    const line = t.logs.find((l) => l.startsWith('error POST /connections/buffer/channel: disk full'));
    expect(line).toBeDefined();
    expect(line).not.toContain('Ab1Ab1');
    expect(res.text).not.toContain('Ab1Ab1');
  });

  it('shows Medium and Substack as blue manual', async () => {
    const t = dashRig();
    await t.signIn();
    const page = await t.request('GET', '/connections');
    for (const platform of ['medium', 'substack']) {
      expect(page.text).toMatch(new RegExp(`data-platform="${platform}" data-route="manual">\\s*<h2>[^<]+</h2>\\s*<p><span class="state blue">manual</span>`));
    }
  });
});

describe('drafts', () => {
  it('the edit box PATCHes the draft and shows the hash change', async () => {
    const t = dashRig();
    await t.signIn();
    const { draftId, approvalId } = t.pendingApproval();
    const before = t.rig.repos.drafts.get(draftId)?.payloadSha256 as string;
    const page = await t.request('GET', `/drafts/${draftId}`);
    expect(page.text).toContain(`hx-patch="/drafts/${draftId}"`);
    const res = await t.request('PATCH', `/drafts/${draftId}`, { form: { text: `${goodLinkedinText(t.rig.item)}\r\nOne more line.` }, headers: { 'hx-request': 'true' } });
    expect(res.status).toBe(200);
    const after = t.rig.repos.drafts.get(draftId)?.payloadSha256 as string;
    expect(after).not.toBe(before);
    expect(res.text).toContain(before.slice(0, 12));
    expect(res.text).toContain(after.slice(0, 12));
    expect((t.rig.repos.drafts.get(draftId)?.payload as { text: string }).text).not.toContain('\r');
    expect(t.rig.repos.approvals.get(approvalId)?.status).toBe('invalidated');
  });

  it('the content page shows the posts × platforms matrix with the live-check state', async () => {
    const t = dashRig();
    await t.signIn();
    const draftId = t.linkedinDraft();
    const page = await t.request('GET', '/content');
    expect(page.text).toContain('<span class="state green">live</span>');
    expect(page.text).toContain(`<a href="/drafts/${draftId}">draft</a>`);
    expect(page.text).toContain('<th>dev.to</th><th>LinkedIn</th>');
  });

  it('the log page shows the audit log', async () => {
    const t = dashRig();
    await t.signIn();
    t.linkedinDraft();
    const page = await t.request('GET', '/log');
    expect(page.text).toContain('draft_created');
    expect(page.text).toContain('signed_in');
  });
});

describe('SessionStore', () => {
  it('mints distinct sessions with their own CSRF token, compared exactly', () => {
    const clock = { now: new Date('2026-10-20T10:00:00Z') };
    const store = new SessionStore({ now: () => clock.now });
    const a = store.create();
    const b = store.create();
    expect(a.cookie).not.toBe(b.cookie);
    expect(store.verify(a.cookie)).toBe(true);
    expect(store.verify('made-up')).toBe(false);
    expect(store.checkCsrf(a.cookie, a.csrf)).toBe(true);
    expect(store.checkCsrf(a.cookie, b.csrf)).toBe(false);
    expect(store.checkCsrf(a.cookie, undefined)).toBe(false);
    expect(store.checkCsrf(a.cookie, `${a.csrf}x`)).toBe(false);
  });

  it('keeps a session alive while it is used and drops it after 8 hours idle', () => {
    const clock = { now: new Date('2026-10-20T10:00:00Z') };
    const store = new SessionStore({ now: () => clock.now });
    const { cookie } = store.create();
    clock.now = new Date(clock.now.getTime() + SESSION_IDLE_MS - 1000);
    expect(store.verify(cookie)).toBe(true);
    clock.now = new Date(clock.now.getTime() + SESSION_IDLE_MS - 1000);
    expect(store.verify(cookie)).toBe(true);
    clock.now = new Date(clock.now.getTime() + SESSION_IDLE_MS);
    expect(store.verify(cookie)).toBe(false);
    expect(store.size()).toBe(0);
  });
});

describe('html', () => {
  it('escapes every interpolated value unless it is a trusted fragment', () => {
    const evil = `<script>"'&\``;
    expect(html`<p title="${evil}">${evil}</p>`.value).toBe('<p title="&lt;script&gt;&quot;&#39;&amp;&#96;">&lt;script&gt;&quot;&#39;&amp;&#96;</p>');
    expect(html`<ul>${['<a>', html`<li>ok</li>`]}</ul>`.value).toBe('<ul>&lt;a&gt;<li>ok</li></ul>');
    expect(html`${raw('<b>trusted</b>')}${undefined}${null}${false}${0}`.value).toBe('<b>trusted</b>0');
  });

  it('renders the dev.to markdown preview escaped, with no live links or images', () => {
    const md = [
      '## Title <script>alert(1)</script>',
      '',
      'Some **bold** and `code<b>` and [a link](javascript:alert(1)) and ![pic](https://example.test/x.png "t").',
      '',
      '- one',
      '- <img src=x onerror=alert(1)>',
      '',
      '```',
      '<script>still text</script>',
      '```',
    ].join('\n');
    const out = renderMarkdown(md).value;
    expect(out).toContain('<h2>Title &lt;script&gt;alert(1)&lt;/script&gt;</h2>');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<code>code&lt;b&gt;</code>');
    expect(out).toContain('<span class="md-link" title="javascript:alert(1">a link</span>');
    expect(out).toContain('<li>&lt;img src=x onerror=alert(1)&gt;</li>');
    expect(out).toContain('<pre><code>&lt;script&gt;still text&lt;/script&gt;</code></pre>');
    expect(out).not.toMatch(/<a |<img |<script/);
  });
});

describe('copyStaticAssets (post-build step)', () => {
  it('copies src/http/static/htmx.min.js and app.css to dist/http/static/, in a path with spaces', () => {
    const root = mkdtempSync(join(tmpdir(), 'cph static assets '));
    try {
      mkdirSync(join(root, 'src', 'http', 'static'), { recursive: true });
      writeFileSync(join(root, 'src', 'http', 'static', 'htmx.min.js'), 'var htmx;\n');
      writeFileSync(join(root, 'src', 'http', 'static', 'app.css'), 'body {}\n');
      copyStaticAssets(root);
      expect(readFileSync(join(root, 'dist', 'http', 'static', 'htmx.min.js'), 'utf8')).toBe('var htmx;\n');
      expect(readFileSync(join(root, 'dist', 'http', 'static', 'app.css'), 'utf8')).toBe('body {}\n');
      rmSync(join(root, 'src'), { recursive: true });
      expect(() => copyStaticAssets(root)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
