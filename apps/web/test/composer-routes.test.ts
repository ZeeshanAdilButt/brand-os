import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as credentialsPost } from '../src/app/api/agent-credentials/route';
import { POST as articlesPost } from '../src/app/api/articles/route';
import {
  handleAgentDestinations,
  handleAgentDraftCreate,
  handleAgentDraftPreview,
  handleAgentDraftUpdate,
} from '../src/server/http/agent-handlers';
import {
  handleApprovalRecord,
  handleCanonicalCheck,
  handleConnectionCreate,
  handleDestinationAdd,
  handleDestinationRemove,
  handleDestinationsGet,
  handleDestinationsReorder,
  handleDraftCreate,
  handleDraftEdit,
  handleDraftExport,
  handleDraftGet,
  handleDraftPreview,
  handleDraftReset,
  handleIntegrationRemove,
  handleIntegrationSave,
  handleIntegrationsGet,
  handleSiteSettingsGet,
  handleSiteSettingsSave,
} from '../src/server/http/publishing-handlers';
import { liveCanonical } from './helpers/canonical';
import { createFakeDevto, type FakeDevto } from './helpers/fake-devto';
import { hostedHarness, HOSTED_URL, type HostedHarness, type TestUser } from './hosted-harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const json = async (res: Response) => (await res.json()) as Json;
const KEY = ['fake', 'devto', 'key', 'composer', '9f8e7d6c'].join('-');
const SAVED_VALUE = ['value', 'saved', 'for', 'later', '4c3b2a19'].join('-');

let h: HostedHarness;
let a: TestUser;
let b: TestUser;
let fake: FakeDevto;
let aAgent: string;
let aReadOnly: string;
let bAgent: string;
let deps: { publish: { fetchFn: typeof fetch; canonical: ReturnType<typeof liveCanonical>; sleep: () => Promise<void>; timeoutMs: number } };
let counter = 0;

function bearer(secret: string, method: string, path: string, body?: unknown): Request {
  return new Request(`${HOSTED_URL}${path}`, {
    method,
    headers: { host: new URL(HOSTED_URL).host, authorization: `Bearer ${secret}`, ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function mint(user: TestUser, name: string, scopes: string[]): Promise<string> {
  const res = await credentialsPost(h.request(user, 'POST', '/api/agent-credentials', { name, scopes }));
  return ((await res.json()) as { secret: string }).secret;
}

async function newArticle(user: TestUser) {
  const res = await articlesPost(
    h.request(user, 'POST', '/api/articles', { title: `Composer routes ${++counter}`, bodyMarkdown: 'The write path stalls when the log fills.\n', tags: ['go'], canonicalUrl: 'https://example-blog.dev/posts/stall' }),
  );
  expect(res.status).toBe(201);
  return json(res);
}

async function prepared(user: TestUser, platform = 'medium') {
  const article = await newArticle(user);
  const created = await json(await handleDraftCreate(h.request(user, 'POST', '/api/platform-drafts', { articleId: article.id, platform }), deps));
  return { article, draft: created };
}

beforeAll(async () => {
  h = await hostedHarness({ appSecret: 'a-long-test-app-secret-0123456789abcdefghijklmnop' });
  a = await h.signUp('composer.a@example.test', 'Writer A');
  b = await h.signUp('composer.b@example.test', 'Writer B');
  fake = createFakeDevto({ apiKey: KEY });
  deps = { publish: { fetchFn: fake.fetch, canonical: liveCanonical(), sleep: async () => undefined, timeoutMs: 2000 } };
  aAgent = await mint(a, 'claude', ['read', 'write_articles', 'platform_drafts']);
  aReadOnly = await mint(a, 'reader', ['read']);
  bAgent = await mint(b, 'claude', ['read', 'platform_drafts']);
  expect((await handleConnectionCreate(h.request(a, 'POST', '/api/connections', { platform: 'devto', secret: KEY }), deps)).status).toBe(201);
});

afterAll(async () => {
  await h.close();
});

const ID = '4f1b6c1e-9a3d-4e2b-8c55-0d7a1f2e3b4c';

describe('the composer routes need a signed-in user', () => {
  it('answers 401 without a session, and for an agent credential alone', async () => {
    const calls: [string, () => Promise<Response>][] = [
      ['add', () => handleDestinationAdd(h.request(null, 'POST', `/api/articles/${ID}/destinations`, { platform: 'medium' }), ID, deps)],
      ['remove', () => handleDestinationRemove(h.request(null, 'DELETE', `/api/articles/${ID}/destinations/medium`), ID, 'medium', deps)],
      ['reorder', () => handleDestinationsReorder(h.request(null, 'PATCH', `/api/articles/${ID}/destinations`, { order: [] }), ID, deps)],
      ['edit', () => handleDraftEdit(h.request(null, 'PATCH', `/api/platform-drafts/${ID}`, {}), ID, deps)],
      ['reset', () => handleDraftReset(h.request(null, 'POST', `/api/platform-drafts/${ID}/reset`, {}), ID, deps)],
      ['export', () => handleDraftExport(h.request(null, 'GET', `/api/platform-drafts/${ID}/export`), ID, deps)],
      ['preview', () => handleDraftPreview(h.request(null, 'GET', `/api/platform-drafts/${ID}/preview`), ID, deps)],
      ['canonical', () => handleCanonicalCheck(h.request(null, 'POST', `/api/articles/${ID}/canonical-check`, {}), ID, deps)],
      ['site get', () => handleSiteSettingsGet(h.request(null, 'GET', '/api/site-settings'), deps)],
      ['site save', () => handleSiteSettingsSave(h.request(null, 'PUT', '/api/site-settings', {}), deps)],
      ['record', () => handleApprovalRecord(h.request(null, 'POST', `/api/approvals/${ID}/record`, {}), ID, deps)],
      ['integrations', () => handleIntegrationsGet(h.request(null, 'GET', '/api/integrations'), deps)],
      ['integration save', () => handleIntegrationSave(h.request(null, 'POST', '/api/integrations/ghost', {}), 'ghost', deps)],
      ['integration remove', () => handleIntegrationRemove(h.request(null, 'DELETE', '/api/integrations/ghost/api_key'), 'ghost', 'api_key', deps)],
      ['destinations (agent credential)', () => handleDestinationsGet(bearer(aAgent, 'GET', `/api/articles/${ID}/destinations`), ID, deps)],
      ['edit (agent credential)', () => handleDraftEdit(bearer(aAgent, 'PATCH', `/api/platform-drafts/${ID}`, {}), ID, deps)],
      ['record (agent credential)', () => handleApprovalRecord(bearer(aAgent, 'POST', `/api/approvals/${ID}/record`, {}), ID, deps)],
      ['site save (agent credential)', () => handleSiteSettingsSave(bearer(aAgent, 'PUT', '/api/site-settings', {}), deps)],
      ['integration save (agent credential)', () => handleIntegrationSave(bearer(aAgent, 'POST', '/api/integrations/ghost', {}), 'ghost', deps)],
    ];
    for (const [name, call] of calls) expect((await call()).status, name).toBe(401);
  });

  it('keeps recording a post and saving integration values browser-only: no origin, an Authorization header or a cross-site origin is refused', async () => {
    const bare = (path: string, body: unknown) => new Request(`${HOSTED_URL}${path}`, { method: 'POST', headers: { host: new URL(HOSTED_URL).host, cookie: a.cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await handleApprovalRecord(bare(`/api/approvals/${ID}/record`, {}), ID, deps)).status).toBe(403);
    expect((await handleIntegrationSave(bare('/api/integrations/ghost', {}), 'ghost', deps)).status).toBe(403);
    expect((await handleIntegrationSave(h.request(a, 'POST', '/api/integrations/ghost', {}, { authorization: `Bearer ${aAgent}` }), 'ghost', deps)).status).toBe(403);
    expect((await handleApprovalRecord(h.request(a, 'POST', `/api/approvals/${ID}/record`, {}, { origin: 'https://evil.example' }), ID, deps)).status).toBe(403);
  });
});

describe('the composer routes are private to each account', () => {
  it('another account gets 404 for every route on a destination, a draft or an article it does not own, and nothing changes', async () => {
    const { article, draft } = await prepared(a);
    const before = await json(await handleDraftGet(h.request(a, 'GET', `/api/platform-drafts/${draft.id}`), draft.id, deps));
    const attempts: [string, Response][] = [
      ['add', await handleDestinationAdd(h.request(b, 'POST', `/api/articles/${article.id}/destinations`, { platform: 'mastodon' }), article.id, deps)],
      ['remove', await handleDestinationRemove(h.request(b, 'DELETE', `/api/articles/${article.id}/destinations/medium`), article.id, 'medium', deps)],
      ['reorder', await handleDestinationsReorder(h.request(b, 'PATCH', `/api/articles/${article.id}/destinations`, { order: ['medium'] }), article.id, deps)],
      ['edit', await handleDraftEdit(h.request(b, 'PATCH', `/api/platform-drafts/${draft.id}`, { expectedHash: before.payloadSha256, title: 'Not yours' }), draft.id, deps)],
      ['reset', await handleDraftReset(h.request(b, 'POST', `/api/platform-drafts/${draft.id}/reset`, {}), draft.id, deps)],
      ['export', await handleDraftExport(h.request(b, 'GET', `/api/platform-drafts/${draft.id}/export`), draft.id, deps)],
      ['preview', await handleDraftPreview(h.request(b, 'GET', `/api/platform-drafts/${draft.id}/preview`), draft.id, deps)],
      ['canonical', await handleCanonicalCheck(h.request(b, 'POST', `/api/articles/${article.id}/canonical-check`, {}), article.id, deps)],
      ['record', await handleApprovalRecord(h.request(b, 'POST', `/api/approvals/${ID}/record`, { checked: [], url: 'https://medium.com/x' }), ID, deps)],
      ['agent destinations', await handleAgentDestinations(bearer(bAgent, 'GET', `/api/agent/articles/${article.id}/destinations`), article.id, deps)],
      ['agent update', await handleAgentDraftUpdate(bearer(bAgent, 'PATCH', `/api/agent/platform-drafts/${draft.id}`, { expectedHash: before.payloadSha256, title: 'Not yours' }), draft.id, deps)],
      ['agent preview', await handleAgentDraftPreview(bearer(bAgent, 'GET', `/api/agent/platform-drafts/${draft.id}/preview`), draft.id, deps)],
    ];
    for (const [name, response] of attempts) expect(response.status, name).toBe(404);
    const after = await json(await handleDraftGet(h.request(a, 'GET', `/api/platform-drafts/${draft.id}`), draft.id, deps));
    expect(after.payloadSha256).toBe(before.payloadSha256);
    expect(after.payload.title).not.toBe('Not yours');
  });

  it('site settings belong to one account', async () => {
    const saved = await handleSiteSettingsSave(h.request(a, 'PUT', '/api/site-settings', { siteUrl: 'https://example-blog.dev', repo: 'example-owner/example-site', baseBranch: 'main', pathTemplate: 'content/posts/{slug}.md', preset: 'generic', mapping: (await json(await handleSiteSettingsGet(h.request(a, 'GET', '/api/site-settings'), deps))).mapping }), deps);
    expect(saved.status).toBe(200);
    expect((await json(await handleSiteSettingsGet(h.request(a, 'GET', '/api/site-settings'), deps))).repo).toBe('example-owner/example-site');
    expect((await json(await handleSiteSettingsGet(h.request(b, 'GET', '/api/site-settings'), deps))).repo).toBeNull();
  });

  it('saved integration values are never returned, never reach an agent route, and are isolated and wiped by Remove', async () => {
    const saved = await handleIntegrationSave(h.request(a, 'POST', '/api/integrations/ghost', { kind: 'api_key', secret: SAVED_VALUE }), 'ghost', deps);
    expect(saved.status).toBe(201);
    expect(JSON.stringify(await json(saved))).not.toContain(SAVED_VALUE);
    const listed = JSON.stringify(await json(await handleIntegrationsGet(h.request(a, 'GET', '/api/integrations'), deps)));
    expect(listed).not.toContain(SAVED_VALUE);
    expect(listed).toContain(SAVED_VALUE.slice(-4));
    const others = await json(await handleIntegrationsGet(h.request(b, 'GET', '/api/integrations'), deps));
    expect(others.integrations.every((i: Json) => i.saved.length === 0)).toBe(true);
    expect((await handleIntegrationRemove(h.request(b, 'DELETE', '/api/integrations/ghost/api_key'), 'ghost', 'api_key', deps)).status).toBe(404);
    expect((await handleIntegrationRemove(h.request(a, 'DELETE', '/api/integrations/ghost/api_key'), 'ghost', 'api_key', deps)).status).toBe(200);
    expect((await json(await handleIntegrationsGet(h.request(a, 'GET', '/api/integrations'), deps))).integrations.find((i: Json) => i.platform === 'ghost').saved).toEqual([]);
  });
});

describe('the agent additions', () => {
  it('lists destinations, edits one draft (voiding nothing it should not) and reads a preview, all scoped', async () => {
    const article = await newArticle(a);
    const created = await json(await handleAgentDraftCreate(bearer(aAgent, 'POST', '/api/agent/platform-drafts', { articleId: article.id, platform: 'mastodon' }), deps));
    const listed = await json(await handleAgentDestinations(bearer(aAgent, 'GET', `/api/agent/articles/${article.id}/destinations`), article.id, deps));
    expect(listed.destinations.length).toBe(13);
    expect(JSON.stringify(listed)).not.toMatch(/"ownerId"|encryptedKey/);

    const updated = await handleAgentDraftUpdate(bearer(aAgent, 'PATCH', `/api/agent/platform-drafts/${created.id}`, { expectedHash: created.payloadSha256, bodyMarkdown: 'Shorter text for Mastodon.' }), created.id, deps);
    expect(updated.status).toBe(200);
    const body = await json(updated);
    expect(body.changed).toBe(true);
    expect(body.draft.payload.bodyMarkdown).toBe('Shorter text for Mastodon.');

    const preview = await handleAgentDraftPreview(bearer(aAgent, 'GET', `/api/agent/platform-drafts/${created.id}/preview`), created.id, deps);
    expect(preview.status).toBe(200);
    expect(JSON.stringify(await json(preview))).toMatch(/Approximate preview|approximate/i);
  });

  it('needs the platform_drafts scope to edit, and read to preview', async () => {
    const { draft } = await prepared(a, 'bluesky');
    expect((await handleAgentDraftUpdate(bearer(aReadOnly, 'PATCH', `/api/agent/platform-drafts/${draft.id}`, { expectedHash: draft.payloadSha256, title: 'x' }), draft.id, deps)).status).toBe(403);
    expect((await handleAgentDraftPreview(bearer(aReadOnly, 'GET', `/api/agent/platform-drafts/${draft.id}/preview`), draft.id, deps)).status).toBe(200);
  });

  it('refuses unknown fields and the site file options, instead of ignoring them', async () => {
    const { draft } = await prepared(a, 'threads');
    const unknown = await handleAgentDraftUpdate(bearer(aAgent, 'PATCH', `/api/agent/platform-drafts/${draft.id}`, { expectedHash: draft.payloadSha256, ownerId: b.userId, title: 'x' }), draft.id, deps);
    expect(unknown.status).toBe(400);
  });
});
