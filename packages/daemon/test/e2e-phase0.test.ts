/**
 * T0.23 step 1: the Phase 0 acceptance run, in process. The whole daemon is built exactly as
 * `main.ts` builds it (in-memory DB, in-memory key store, temp site dir with spaces in its path) and
 * driven only through its two doors: `app.request()` with a bearer token (what the MCP server and the
 * CLI do) and the cookie + CSRF dashboard (what the browser does). The site, dev.to and Buffer are
 * scripted fakes; Windows Hello is a scripted presence check. Nothing touches the network.
 */
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config.js';
import { createDaemon, type Daemon } from '../src/daemon.js';
import { openDb, type Db } from '../src/db/open.js';
import {
  ApprovalRequestResponse,
  ApprovalStatusResponse,
  ContentListResponse,
  DraftResponse,
  ErrorBody,
  LoginNonceResponse,
  LogResponse,
  PreviewResponse,
  PublishResponse,
  StageResponse,
} from '../src/http/api.js';
import { AssistLinkedinRoute } from '../src/routes/assist-linkedin.js';
import { issueApiToken, MASTER_KEY_NAME, MemoryKeyStore } from '../src/secrets/keystore.js';
import { SecretStore } from '../src/secrets/secret-store.js';
import type { GitRunner } from '../src/site/git.js';
import { DASHBOARD_HOST, DashboardClient, readCard } from './helpers/dashboard-client.js';
import { FakeBuffer } from './helpers/fake-buffer.js';
import { FakeDevto } from './helpers/fake-devto.js';
import { FakeNotifier } from './helpers/fake-notifier.js';
import { FakePresence } from './helpers/fake-presence.js';
import { goodLinkedinText, loadItem } from './helpers/service-rig.js';

/** The whole run is one long test with many awaits; the default 5 s is for the small ones. */
const HEAVY_TEST_MS = 60_000;

const FIXTURES = fileURLToPath(new URL('../../core/test/fixtures/', import.meta.url));
const SLUG = 'prometheus-cardinality-explained';
const TITLE = 'How High Cardinality Hurts Prometheus';
const CANONICAL = `https://www.example-blog.dev/blog/${SLUG}`;
const FAKE_BUFFER_KEY = 'not-a-real-buffer-key-0123456789abcdef';
const FAKE_DEVTO_KEY = 'not-a-real-devto-key-0123456789abcdef';
const LINKEDIN_CHANNEL = 'chan-linkedin-0001';
const ORGANIZATION = 'org-test-0001';
/** The one actor the code records for an approval given in the dashboard with Windows Hello. */
const HELLO_ACTOR = 'dashboard_hello';

let root: string;
let site: string;
let state: string;
let worlds: World[];

beforeEach(() => {
  // Spaces in every path, like the real ones.
  root = mkdtempSync(join(tmpdir(), 'cph e2e '));
  site = join(root, 'site repo');
  state = join(root, 'state dir');
  mkdirSync(join(site, 'content', 'posts'), { recursive: true });
  mkdirSync(join(site, 'content', 'publishing-notes'), { recursive: true });
  mkdirSync(state, { recursive: true });
  copyFileSync(join(FIXTURES, 'sample-post.mdx'), join(site, 'content', 'posts', `${SLUG}.mdx`));
  copyFileSync(join(FIXTURES, 'sample-notes.md'), join(site, 'content', 'publishing-notes', `${SLUG}.md`));
  worlds = [];
});

afterEach(() => {
  for (const w of worlds) {
    w.daemon.stop();
    w.db.close();
  }
  rmSync(root, { recursive: true, force: true });
});

const fakeGit: GitRunner = (args) => Promise.resolve({ stdout: args.includes('rev-parse') ? 'abc1234\n' : '' });

interface ApiResult {
  status: number;
  json: unknown;
}

interface World {
  daemon: Daemon;
  db: Db;
  clock: { now: Date };
  buffer: FakeBuffer;
  devto: FakeDevto;
  presence: FakePresence;
  notifier: FakeNotifier;
  /** Every URL the fake fetch saw, in order. */
  fetched: string[];
  /** Every `/api/*` call made with a bearer token, in order (what the MCP server would have sent). */
  apiCalls: { method: string; path: string }[];
  dash: DashboardClient;
  /** A bearer-token call as the MCP server makes it. */
  mcp(method: string, path: string, body?: unknown): Promise<ApiResult>;
  /** A bearer-token call as the CLI makes it. */
  cli(method: string, path: string, body?: unknown): Promise<ApiResult>;
  /** Signs the dashboard client in the way `cph dashboard` does (a one-time nonce from the CLI scope). */
  signInDashboard(): Promise<void>;
}

/** The whole daemon, wired with fakes for the site, dev.to, Buffer, Hello, the browser and toasts. */
function buildWorld(options: { linkCard?: boolean } = {}): World {
  const db = openDb(':memory:');
  const clock = { now: new Date('2026-10-20T10:00:00.000Z') };
  const buffer = new FakeBuffer(FAKE_BUFFER_KEY);
  const devto = new FakeDevto(FAKE_DEVTO_KEY);
  const presence = new FakePresence('verified');
  const notifier = new FakeNotifier();
  const fetched: string[] = [];
  const apiCalls: World['apiCalls'] = [];

  /** The site's pages are live with the right title; dev.to and Buffer are the scripted fakes. */
  const fetchFn: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    fetched.push(url);
    if (url.startsWith('https://api.buffer.com')) return buffer.fetchFn(input, init);
    if (url.startsWith('https://dev.to/')) return devto.fetchFn(input, init);
    if (url.startsWith('https://www.example-blog.dev/blog/')) {
      const res = new Response(`<html><head><title>${TITLE}</title></head><body><h1>${TITLE}</h1></body></html>`, { status: 200 });
      Object.defineProperty(res, 'url', { value: url });
      return Promise.resolve(res);
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };

  const config = ConfigSchema.parse({
    site: { repoPath: site, timeZone: 'UTC' },
    // These tests are about Windows Hello approvals (click mode has its own tests).
    approval: { mode: 'hello' },
    platforms: {
      linkedin: { route: 'buffer', bufferChannelId: LINKEDIN_CHANNEL, linkCard: options.linkCard === true },
      buffer: { organizationId: ORGANIZATION },
    },
  });
  const ks = new MemoryKeyStore();
  ks.set(MASTER_KEY_NAME, randomBytes(32).toString('base64'));
  const tokens = { mcp: issueApiToken(ks, 'mcp'), cli: issueApiToken(ks, 'cli') };
  const opener = (): Promise<void> => Promise.resolve();
  const daemon = createDaemon({
    config,
    stateDir: state,
    db,
    keystore: ks,
    fetchFn,
    presence,
    notifier,
    opener,
    now: () => clock.now,
    gitRunner: fakeGit,
    assistLinkedin: new AssistLinkedinRoute({ clipboard: { write: () => Promise.resolve() }, opener }),
  });
  // What `cph connect` does, minus the prompts: the two keys land encrypted in the credentials table.
  const secrets = new SecretStore(ks, daemon.repos);
  secrets.put('linkedin', 'default', { apiKey: FAKE_BUFFER_KEY });
  secrets.put('devto', 'default', { apiKey: FAKE_DEVTO_KEY });

  const api =
    (token: string, record: boolean) =>
    async (method: string, path: string, body?: unknown): Promise<ApiResult> => {
      if (record) apiCalls.push({ method, path });
      const res = await daemon.app.request(path, {
        method,
        headers: { host: DASHBOARD_HOST, authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, json: text === '' ? undefined : (JSON.parse(text) as unknown) };
    };
  const dash = new DashboardClient(daemon.app);
  const world: World = {
    daemon,
    db,
    clock,
    buffer,
    devto,
    presence,
    notifier,
    fetched,
    apiCalls,
    dash,
    mcp: api(tokens.mcp, true),
    cli: api(tokens.cli, false),
    async signInDashboard() {
      const minted = await world.cli('POST', '/api/dashboard-login-nonce', {});
      expect(minted.status).toBe(200);
      await dash.signIn(LoginNonceResponse.parse(minted.json).url);
    },
  };
  worlds.push(world);
  return world;
}

/** Checks `expected` appears in `actions` in this order (other rows may sit in between). */
function expectInOrder(actions: string[], expected: string[]): void {
  let from = 0;
  for (const action of expected) {
    const at = actions.indexOf(action, from);
    expect(at, `"${action}" after position ${from} in [${actions.join(', ')}]`).toBeGreaterThanOrEqual(0);
    from = at + 1;
  }
}

/** A second LinkedIn text that passes lint but hashes differently from `goodLinkedinText`. */
function secondLinkedinText(): string {
  const lines = goodLinkedinText(loadItem()).split('\n');
  return [lines[1], lines[0], ...lines.slice(2)].join('\n');
}

/** Every field of `payload` must be on the wire as Buffer's createPost input (what is approved is what is sent). */
function expectPayloadOnWire(payload: Record<string, unknown>, wire: Record<string, unknown>, linkCard: boolean): void {
  expect(wire['text']).toBe(payload['text']);
  const link = payload['link'] as Record<string, string> | undefined;
  if (linkCard) {
    expect(link).toBeDefined();
    expect(wire['metadata']).toEqual({ linkedin: { linkAttachment: link } });
  } else {
    expect(link).toBeUndefined();
    expect(wire).not.toHaveProperty('metadata');
  }
  // Nothing the payload does not carry: no media, no schedule, never a draft.
  expect(wire).not.toHaveProperty('assets');
  expect(wire).not.toHaveProperty('dueAt');
  expect(wire).not.toHaveProperty('saveToDraft');
  expect(wire).toMatchObject({ channelId: LINKEDIN_CHANNEL, schedulingType: 'automatic', mode: 'shareNow' });
}

describe('Phase 0 acceptance: sync, drafts, Hello approvals, publish, audit', { timeout: HEAVY_TEST_MS }, () => {
  it('runs the whole dry-run path through the API and the dashboard', async () => {
    const w = buildWorld();
    const { daemon, buffer, devto, presence, mcp } = w;
    const item = loadItem();
    const startup = await daemon.startup();
    expect(startup.recovered).toEqual([]);

    // ---- 1. sync -> the canonical page is live -> t0 is the fixture's frontmatter date -------------
    const sync = await mcp('POST', '/api/sync');
    expect(sync.status).toBe(200);
    expect(sync.json).toMatchObject({ upserted: 1, errors: [] });
    expect(w.fetched).toEqual([CANONICAL]);
    const [content] = ContentListResponse.parse((await mcp('GET', '/api/content')).json).content;
    expect(content).toMatchObject({ slug: SLUG, title: TITLE, canonicalUrl: CANONICAL, published: true, dirty: false });
    expect(content?.canonicalLiveAt).toBe(w.clock.now.toISOString());
    // The post is three months old and was already live when the tool first saw it: T0 is its date
    // (midnight in the site's time zone, UTC here), not install day.
    expect(item.frontmatter.date).toBe('2026-07-19');
    expect(content?.t0).toBe(`${item.frontmatter.date}T00:00:00.000Z`);

    // Prime the health caches the way the daemon's first timer cycle does: dev.to is probed (free) and
    // Buffer gets its one metered channels() call of the day.
    await daemon.tick();
    expect(buffer.ops('Channels')).toHaveLength(1);

    // ---- 2. dev.to: stage is private + canonical, re-stage after it went live is refused ---------
    const devtoDraft = DraftResponse.parse((await mcp('POST', '/api/drafts', { slug: SLUG, platform: 'devto' })).json);
    expect(devtoDraft).toMatchObject({ route: 'direct', status: 'draft', authorship: 'reformatted', notBefore: '2026-07-21T00:00:00.000Z' });
    expect(devtoDraft.lint.filter((l) => l.severity === 'error')).toEqual([]);

    const staged = await mcp('POST', `/api/drafts/${devtoDraft.id}/stage`);
    expect(staged.status).toBe(200);
    const stage = StageResponse.parse(staged.json);
    expect(stage.remoteId).toBe('2001');
    const posts = devto.calls('POST', '/api/articles');
    expect(posts).toHaveLength(1);
    const sent = (posts[0]?.body as { article: Record<string, unknown> }).article;
    expect(sent['published']).toBe(false);
    expect(sent['canonical_url']).toBe(CANONICAL);
    expect(sent['title']).toBe(TITLE);
    // No image placeholder: the cover is a field of its own and is never embedded in the body, and the
    // interactive diagram is a text block that links to the original post.
    const body = sent['body_markdown'] as string;
    expect(sent['main_image']).toMatch(/^https:\/\/www\.example-blog\.dev\/.+\.png$/);
    expect(body).not.toContain(sent['main_image'] as string);
    expect(body).not.toMatch(/placeholder/i);
    expect(body).toContain('Interactive diagram: x.');
    expect(body).toContain(`${CANONICAL}#`);
    expect(body).toContain(`*Originally published at [example-blog.dev](${CANONICAL}).*`);
    expect(devto.calls('PUT')).toHaveLength(0);
    expect(DraftResponse.parse((await mcp('GET', `/api/drafts/${devtoDraft.id}`)).json)).toMatchObject({ status: 'staged', remoteRef: '2001' });

    // The author publishes the article on dev.to by hand; staging again must not touch a live article.
    devto.markPublished(2001);
    const restaged = await mcp('POST', `/api/drafts/${devtoDraft.id}/stage`);
    expect(restaged.status).toBe(409);
    expect(ErrorBody.parse(restaged.json).code).toBe('STAGE_REFUSED');
    expect(devto.calls('PUT')).toHaveLength(0);
    expect(devto.calls('POST', '/api/articles')).toHaveLength(1);
    expect(devto.articles.get(2001)).toMatchObject({ published: true });
    expect(DraftResponse.parse((await mcp('GET', `/api/drafts/${devtoDraft.id}`)).json).status).toBe('failed');

    // ---- 3. LinkedIn draft with a good adaptation, then two approval requests ---------------------
    const text = goodLinkedinText(item);
    const created = await mcp('POST', '/api/drafts', { slug: SLUG, platform: 'linkedin', payload: { text } });
    expect(created.status).toBe(201);
    const li = DraftResponse.parse(created.json);
    expect(li).toMatchObject({ route: 'buffer', status: 'draft', authorship: 'ai-assisted', payload: { text } });
    expect(li.lint.filter((l) => l.severity === 'error')).toEqual([]);

    const firstRequest = await mcp('POST', '/api/approvals', { draftId: li.id });
    const secondRequest = await mcp('POST', '/api/approvals', { draftId: li.id });
    expect(firstRequest.status).toBe(201);
    expect(secondRequest.status).toBe(201);
    const first = ApprovalRequestResponse.parse(firstRequest.json);
    const second = ApprovalRequestResponse.parse(secondRequest.json);
    expect(second.approvalId).not.toBe(first.approvalId);
    for (const r of [first, second]) {
      expect(r.approveUrl).toBe(`http://127.0.0.1:4646/approvals/${r.approvalId}`);
      expect(r.instructions).toContain(r.approveUrl);
      expect(r.instructions).toContain('get_approval_status every 15 s for up to 10 minutes');
      expect(r.instructions).toContain('stop on published, approved, denied or expired');
    }
    expect(ApprovalStatusResponse.parse((await mcp('GET', `/api/approvals/${first.approvalId}`)).json)).toMatchObject({ status: 'pending' });

    // ---- 4. dashboard "Approve only": Hello canceled leaves it pending, Hello verified approves ---
    await w.signInDashboard();
    const card = await w.dash.get(`/approvals/${first.approvalId}`);
    expect(card.status).toBe(200);
    const { tag, checklist } = readCard(card.text);
    expect(tag).toMatch(/^#[0-9A-F]{8}$/);
    expect(tag).toBe(`#${li.payloadSha256.slice(0, 8).toUpperCase()}`);
    expect(checklist.length).toBeGreaterThanOrEqual(2);
    expect(checklist[0]).toBe('I have read this exact payload');
    // The card shows exactly what will be sent, and (link card off) says LinkedIn builds the preview.
    expect(card.text).toContain('Prometheus cost follows series count');
    expect(card.text).toContain('Preview will be generated by LinkedIn');
    expect(card.text).not.toContain('link attachment');

    presence.set('canceled');
    const canceled = await w.dash.post(`/approvals/${first.approvalId}/approve`, { action: 'only', checked: checklist });
    expect(canceled.status).toBe(409);
    expect(canceled.text).toContain('PRESENCE_FAILED');
    expect(ApprovalStatusResponse.parse((await mcp('GET', `/api/approvals/${first.approvalId}`)).json).status).toBe('pending');

    presence.set('verified');
    const approved = await w.dash.post(`/approvals/${first.approvalId}/approve`, { action: 'only', checked: checklist });
    expect(approved.status).toBe(200);
    expect(approved.text).toContain('Approved (Windows Hello verified)');
    expect(ApprovalStatusResponse.parse((await mcp('GET', `/api/approvals/${first.approvalId}`)).json)).toMatchObject({
      status: 'approved',
      mode: 'approve_only',
    });
    // Both Hello prompts named this approval: the same tag the card showed.
    expect(presence.prompts).toHaveLength(2);
    for (const prompt of presence.prompts) {
      expect(prompt).toContain(` · ${tag} · `);
      expect(prompt).toMatch(/^Approve LinkedIn via buffer · #[0-9A-F]{8} · prometheus-cardinality-explained · "Prometheus cost follows series count/);
    }

    // ---- 5. publishing_enabled=false: the MCP publish is refused and the approval is not spent ----
    expect(daemon.repos.settings.get('publishing_enabled')).toBe('false');
    const disabled = await mcp('POST', '/api/publish', { draftId: li.id, approvalId: first.approvalId });
    expect(disabled.status).toBe(409);
    expect(ErrorBody.parse(disabled.json).code).toBe('PUBLISHING_DISABLED');
    expect(buffer.ops('CreatePost')).toHaveLength(0);
    expect(ApprovalStatusResponse.parse((await mcp('GET', `/api/approvals/${first.approvalId}`)).json).status).toBe('approved');

    // ---- 6. turning publishing on needs Hello ---------------------------------------------------
    presence.set('canceled');
    const notEnabled = await w.dash.post('/settings/publishing', { enabled: 'true' });
    expect(notEnabled.status).toBe(409);
    expect(notEnabled.text).toContain('PRESENCE_FAILED');
    expect(daemon.repos.settings.get('publishing_enabled')).toBe('false');
    presence.set('verified');
    const enabled = await w.dash.post('/settings/publishing', { enabled: 'true' });
    expect(enabled.status).toBe(200);
    expect(daemon.repos.settings.get('publishing_enabled')).toBe('true');
    expect(presence.prompts.slice(-2)).toEqual(['Enable publishing', 'Enable publishing']);

    // ---- 7. publish(linkedin): one shareNow, every hashed field on the wire ----------------------
    const published = await mcp('POST', '/api/publish', { draftId: li.id, approvalId: first.approvalId });
    expect(published.status).toBe(200);
    expect(PublishResponse.parse(published.json).status).toBe('published');
    const shareNow = buffer.ops('CreatePost');
    expect(shareNow).toHaveLength(1);
    const wire = shareNow[0]?.variables?.['input'] as Record<string, unknown>;
    const liNow = DraftResponse.parse((await mcp('GET', `/api/drafts/${li.id}`)).json);
    expect(liNow.status).toBe('published');
    // Default config has linkCard=false: the payload hashes only `text`, so there is no link attachment.
    expect(Object.keys(liNow.payload as object)).toEqual(['text']);
    expectPayloadOnWire(liNow.payload as Record<string, unknown>, wire, false);
    expect(shareNow[0]?.raw).not.toContain('linkAttachment');
    expect(shareNow[0]?.raw).not.toContain(FAKE_BUFFER_KEY);
    expect(shareNow[0]?.headers['authorization']).toBe(`Bearer ${FAKE_BUFFER_KEY}`);
    expect(daemon.repos.publications.findByHash('linkedin', liNow.payloadSha256)).toMatchObject({ draftId: li.id, remoteId: 'post-sent-0001' });
    // The same approval cannot be spent twice,.
    const again = await mcp('POST', '/api/publish', { draftId: li.id, approvalId: first.approvalId });
    expect(again.status).toBe(409);
    expect(buffer.ops('CreatePost')).toHaveLength(1);

    // ---- 8. second draft: dashboard "Approve & publish" posts once, with no MCP publish -----------
    const li2 = DraftResponse.parse((await mcp('POST', '/api/drafts', { slug: SLUG, platform: 'linkedin', payload: { text: secondLinkedinText() } })).json);
    expect(li2.payloadSha256).not.toBe(li.payloadSha256);
    expect(li2.lint.filter((l) => l.severity === 'error')).toEqual([]);
    const secondApproval = ApprovalRequestResponse.parse((await mcp('POST', '/api/approvals', { draftId: li2.id })).json);
    const publishCallsBefore = w.apiCalls.filter((c) => c.path === '/api/publish').length;

    const card2 = readCard((await w.dash.get(`/approvals/${secondApproval.approvalId}`)).text);
    expect(card2.tag).toBe(`#${li2.payloadSha256.slice(0, 8).toUpperCase()}`);
    expect(card2.tag).not.toBe(tag);
    const promptsBefore = presence.prompts.length;
    const publishNow = await w.dash.post(`/approvals/${secondApproval.approvalId}/approve`, { action: 'publish', checked: card2.checklist });
    expect(publishNow.status).toBe(200);
    expect(publishNow.text).toContain('Published (Windows Hello verified)');
    expect(presence.prompts).toHaveLength(promptsBefore + 1);
    expect(presence.prompts.at(-1)).toContain(` · ${card2.tag} · `);
    expect(buffer.ops('CreatePost')).toHaveLength(2);
    const wire2 = buffer.ops('CreatePost')[1]?.variables?.['input'] as Record<string, unknown>;
    expect(wire2['text']).toBe(secondLinkedinText());
    expectPayloadOnWire(li2.payload as Record<string, unknown>, wire2, false);
    // No MCP call was involved in this publish, and the approval reports the outcome.
    expect(w.apiCalls.filter((c) => c.path === '/api/publish')).toHaveLength(publishCallsBefore);
    const status2 = ApprovalStatusResponse.parse((await mcp('GET', `/api/approvals/${secondApproval.approvalId}`)).json);
    expect(status2).toMatchObject({ status: 'published', mode: 'publish_now', draftId: li2.id });
    expect(daemon.repos.publications.findByHash('linkedin', li2.payloadSha256)).toMatchObject({ draftId: li2.id, remoteId: 'post-sent-0001' });

    // ---- 9. a fresh, staged dev.to draft with no approval: NO_APPROVAL, nothing goes live ---------
    // The draft from step 2 is 'failed' (its article went live by hand), so a publish of it could be
    // refused for that alone. A fresh draft, staged as a private article, is a real candidate: only the
    // missing approval stops it.
    const freshDevto = DraftResponse.parse((await mcp('POST', '/api/drafts', { slug: SLUG, platform: 'devto' })).json);
    expect(freshDevto.lint.filter((l) => l.severity === 'error')).toEqual([]);
    const freshStage = StageResponse.parse((await mcp('POST', `/api/drafts/${freshDevto.id}/stage`)).json);
    expect(freshStage.remoteId).toBe('2002');
    expect(DraftResponse.parse((await mcp('GET', `/api/drafts/${freshDevto.id}`)).json)).toMatchObject({ status: 'staged', remoteRef: '2002' });
    expect(devto.articles.get(2002)).toMatchObject({ published: false });

    const noApproval = await mcp('POST', '/api/publish', { draftId: freshDevto.id, approvalId: 'no-such-approval' });
    expect(noApproval.status).toBe(409);
    expect(ErrorBody.parse(noApproval.json).code).toBe('NO_APPROVAL');
    // An approval given for another draft is no approval for this one either.
    const wrongDraft = await mcp('POST', '/api/publish', { draftId: freshDevto.id, approvalId: secondApproval.approvalId });
    expect(wrongDraft.status).toBe(409);
    expect(ErrorBody.parse(wrongDraft.json).code).toBe('NO_APPROVAL');
    expect(devto.calls('PUT')).toHaveLength(0);
    expect(devto.calls('POST', '/api/articles')).toHaveLength(2);
    expect(devto.articles.get(2002)).toMatchObject({ published: false });
    expect(DraftResponse.parse((await mcp('GET', `/api/drafts/${freshDevto.id}`)).json).status).toBe('staged');

    // ---- 10. the audit log has every step, all human approvals through dashboard + Hello ----------
    const log = LogResponse.parse((await mcp('GET', '/api/log?limit=500')).json);
    const entries = [...log.entries].sort((a, b) => a.id - b.id);
    const actions = entries.map((e) => e.action);
    expectInOrder(actions, [
      'draft_created', // dev.to
      'staged',
      'stage_failed',
      'draft_created', // LinkedIn
      'approval_requested',
      'approval_requested',
      'approve_refused', // Hello canceled
      'approved', // Hello verified
      'authorize_refused', // PUBLISHING_DISABLED
      'publishing_enable_refused',
      'publishing_enabled',
      'authorize_ok',
      'publish_started',
      'published',
      'draft_created', // second LinkedIn
      'approval_requested',
      'approved', // Approve & publish
      'authorize_ok',
      'publish_started',
      'published',
      'draft_created', // fresh dev.to
      'staged',
      'authorize_refused', // NO_APPROVAL
    ]);
    const rows = (action: string) => entries.filter((e) => e.action === action);
    expect(rows('approval_requested')).toHaveLength(3);
    expect(rows('approved')).toHaveLength(2);
    expect(rows('published')).toHaveLength(2);
    expect(rows('draft_created')).toHaveLength(4);
    expect(rows('authorize_refused').map((e) => (e.detail as { code: string }).code)).toEqual(
      expect.arrayContaining(['PUBLISHING_DISABLED', 'NO_APPROVAL']),
    );
    expect(rows('approve_refused').map((e) => (e.detail as { code: string }).code)).toEqual(['PRESENCE_FAILED']);
    expect(rows('approve_refused')[0]?.detail).toMatchObject({ result: 'canceled' });
    // Every human decision (approve, refused approve, publishing on or refused) was made through the
    // dashboard with Hello. The brief writes this as 'dashboard+hello'; the code's value is 'dashboard_hello'.
    for (const action of ['approved', 'approve_refused', 'publishing_enabled', 'publishing_enable_refused']) {
      for (const row of rows(action)) expect(row.actorChannel, `actor of ${action}`).toBe(HELLO_ACTOR);
    }
    expect(entries.map((e) => e.actorChannel)).not.toContain('dashboard+hello');
    // Nothing recorded an approval from any other channel (MCP, CLI, elicitation).
    expect(rows('approved').map((e) => e.approvalId)).toEqual([first.approvalId, secondApproval.approvalId]);
    for (const id of [first.approvalId, secondApproval.approvalId]) {
      expect(daemon.repos.approvals.get(id)).toMatchObject({ channel: HELLO_ACTOR, status: 'approved' });
      expect(daemon.repos.approvals.get(id)?.presenceVerifiedAt).toBeDefined();
    }
    // No row carries a key.
    expect(JSON.stringify(entries)).not.toContain(FAKE_BUFFER_KEY);
    expect(JSON.stringify(entries)).not.toContain(FAKE_DEVTO_KEY);

    // ---- 11. the Buffer budget: no 15-minute probing ----------------------------------------------
    // Four more timer cycles (an hour of 15-minute ticks): sync and the free dev.to probe run, but the
    // metered Buffer probe stays at one a day.
    for (let i = 0; i < 4; i++) {
      w.clock.now = new Date(w.clock.now.getTime() + 15 * 60_000);
      await daemon.tick();
    }
    expect(buffer.calls).toBeLessThanOrEqual(10);
    // Exactly: the day's probe, then per publish one pre-publish channels() call and one createPost.
    expect(buffer.requests.map((r) => r.op)).toEqual(['Channels', 'Channels', 'CreatePost', 'Channels', 'CreatePost']);
    expect(buffer.ops('Organizations')).toHaveLength(0);
    for (const r of buffer.ops('CreatePost')) expect((r.variables?.['input'] as { mode: string }).mode).toBe('shareNow');
  });

  it('with the LinkedIn link card on, the whole card reaches Buffer (what is approved is what is sent)', async () => {
    const w = buildWorld({ linkCard: true });
    const { daemon, buffer, mcp } = w;
    await daemon.startup();
    await mcp('POST', '/api/sync');
    await daemon.tick();

    const preview = PreviewResponse.parse((await mcp('GET', `/api/preview/${SLUG}/linkedin`)).json);
    const link = (preview.payload as { link: Record<string, string> }).link;
    expect(Object.keys(link).sort()).toEqual(['description', 'thumbnailUrl', 'title', 'url']);
    const draft = DraftResponse.parse((await mcp('POST', '/api/drafts', { slug: SLUG, platform: 'linkedin', payload: { text: goodLinkedinText(loadItem()), link } })).json);
    expect(Object.keys(draft.payload as object).sort()).toEqual(['link', 'text']);
    expect(draft.lint.filter((l) => l.severity === 'error')).toEqual([]);

    const { approvalId } = ApprovalRequestResponse.parse((await mcp('POST', '/api/approvals', { draftId: draft.id })).json);
    await w.signInDashboard();
    const card = await w.dash.get(`/approvals/${approvalId}`);
    expect(card.text).toContain("Sent as the post's link attachment");
    expect(card.text).not.toContain('Preview will be generated by LinkedIn');
    const approved = await w.dash.post(`/approvals/${approvalId}/approve`, { action: 'only', checked: readCard(card.text).checklist });
    expect(approved.status).toBe(200);
    expect((await w.dash.post('/settings/publishing', { enabled: 'true' })).status).toBe(200);

    const res = await mcp('POST', '/api/publish', { draftId: draft.id, approvalId });
    expect(PublishResponse.parse(res.json).status).toBe('published');
    const sent = buffer.ops('CreatePost');
    expect(sent).toHaveLength(1);
    expectPayloadOnWire(draft.payload as Record<string, unknown>, sent[0]?.variables?.['input'] as Record<string, unknown>, true);
    expect(buffer.calls).toBeLessThanOrEqual(10);
  });
});
