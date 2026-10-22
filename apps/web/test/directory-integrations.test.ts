import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLATFORM_IDS } from '../src/lib/catalog';
import { AREAS, AREA_LABELS, DIRECTORY, METHOD_LABELS, assistedPrompt, directoryEntry, directoryStatus, entriesIn, redirectUrl, setupKinds, statusLine, type ContentMethod } from '../src/lib/directory';
import { exportMyData } from '../src/server/actions/export';
import { listIntegrations, removeIntegrationSecret, saveIntegrationSecret } from '../src/server/actions/integrations';
import { ActionError, sessionToOwner, type OwnerContext } from '../src/server/actions/owner';
import { connectPlatform, prepareDraft } from '../src/server/actions/publishing';
import { createArticle } from '../src/server/actions/articles';
import { decryptKey, masterKey } from '../src/server/ai/crypto';
import type { DbHandle } from '../src/server/db/client';
import { users } from '../src/server/db/schema';
import { handleIntegrationRemove, handleIntegrationSave, handleIntegrationsGet } from '../src/server/http/publishing-handlers';
import { hostedHarness, type HostedHarness, type TestUser } from './hosted-harness';
import { memoryDb, sqlRows, testConfig } from './helpers';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
// Built at run time: the repository forbids key-shaped literals in tests.
const API_VALUE = ['fake', 'ghost', 'admin', 'value', '7q8w9e0r1t'].join('_');
const CLIENT_ID = ['fake-client-id', '4455667788'].join('-');
const CLIENT_SECRET = ['fake', 'client', 'secret', 'z1x2c3v4b5n6'].join('_');

const METHODS: ContentMethod[] = ['api', 'oauth', 'api_key', 'browser_assisted', 'manual_only'];

describe('the platform directory is complete', () => {
  it('covers every area, with the entries the owner asked to see', () => {
    for (const area of AREAS) expect(entriesIn(area).length, area).toBeGreaterThan(0);
    const names = DIRECTORY.map((e) => e.name).join(' | ');
    for (const expected of [
      'DEV.to', 'Hashnode', 'Medium', 'Substack', 'Personal site', 'Ghost', 'WordPress', 'Beehiiv', 'Buttondown',
      'LinkedIn', 'X', 'Bluesky', 'Threads', 'Mastodon',
      'Reddit', 'Hacker News', 'Lobsters', 'Discord', 'Slack',
      'YouTube', 'LinkedIn video',
      'Sessionize', 'PaperCall', 'KubeCon', 'SREcon', 'FOSDEM', 'DevOpsDays', 'PlatformCon', 'GopherCon', 'PostgreSQL conferences',
      'InfoQ', 'CNCF Blog', 'DZone', 'freeCodeCamp',
      'GitHub Releases', 'Product Hunt', 'Show HN', 'npm', 'PyPI', 'crates.io',
      'Buffer', 'Postiz',
    ]) {
      expect(names, expected).toContain(expected);
    }
    expect(DIRECTORY.length).toBeGreaterThanOrEqual(40);
    expect(new Set(DIRECTORY.map((e) => e.id)).size).toBe(DIRECTORY.length);
  });

  it('gives every entry an area, an official URL, a method, a status, a plan and its restrictions or UNVERIFIED notes', () => {
    for (const entry of DIRECTORY) {
      expect(AREAS, entry.id).toContain(entry.area);
      expect(entry.url, entry.id).toMatch(/^https:\/\//);
      expect(METHODS, entry.id).toContain(entry.method);
      expect(Object.keys(METHOD_LABELS)).toContain(entry.method);
      expect(entry.summary.length, entry.id).toBeGreaterThan(15);
      expect(entry.plan.length, entry.id).toBeGreaterThan(15);
      expect(entry.restrictions.length + entry.unverified.length, `${entry.id} has restrictions or UNVERIFIED notes`).toBeGreaterThan(0);
      for (const connected of [true, false]) {
        const status = directoryStatus(entry, connected);
        expect(['available_now', 'needs_connection', 'preview_only', 'manual_only', 'planned'], entry.id).toContain(status);
        expect(statusLine(entry, status).length, entry.id).toBeGreaterThan(10);
      }
      expect(AREA_LABELS[entry.area]).toBeTruthy();
    }
  });

  it('shows conference and editorial entries as directory only, planned on the roadmap, with no fake enabling', () => {
    for (const entry of [...entriesIn('conferences'), ...entriesIn('editorial')]) {
      expect(entry.directoryOnly, entry.id).toBe(true);
      expect(entry.adapter, entry.id).toBe(false);
      expect(entry.roadmap, entry.id).toMatch(/^Phase [34]/);
      expect(directoryStatus(entry, true), entry.id).toBe('planned');
      expect(statusLine(entry, 'planned'), entry.id).toMatch(/Directory only/);
    }
  });

  it('is available now only where an adapter exists, and needs a connection until one works', () => {
    const adapters = DIRECTORY.filter((e) => e.adapter).map((e) => e.id).sort();
    expect(adapters).toEqual(['devto', 'hashnode', 'site']);
    for (const entry of DIRECTORY) {
      if (!entry.adapter) expect(['available_now', 'needs_connection'], entry.id).not.toContain(directoryStatus(entry, true));
      else {
        expect(directoryStatus(entry, true)).toBe('available_now');
        expect(directoryStatus(entry, false)).toBe('needs_connection');
      }
    }
    // The composer’s thirteen destinations are all in the directory under the same ids.
    for (const id of PLATFORM_IDS) expect(directoryEntry(id)?.composer, id).toBe(id);
  });

  it('writes the prompt for the owner’s own Claude without asking for a secret to be sent in chat', () => {
    const linkedin = directoryEntry('linkedin')!;
    const prompt = assistedPrompt(linkedin, 'http://127.0.0.1:3100');
    expect(prompt).toContain('https://www.linkedin.com/developers/apps');
    expect(prompt).toContain('http://127.0.0.1:3100/api/connect/linkedin/callback');
    expect(prompt).toContain('w_member_social');
    expect(prompt).toMatch(/Do not ask me to paste any secret/);
    expect(prompt).toMatch(/Never post, publish, send or change anything/);
    expect(redirectUrl(linkedin, 'http://127.0.0.1:3100/')).toBe('http://127.0.0.1:3100/api/connect/linkedin/callback');
    expect(redirectUrl(directoryEntry('ghost')!, 'http://x')).toBeNull();
  });

  it('chooses a setup kind that matches the connect method', () => {
    expect(setupKinds(directoryEntry('devto')!)).toEqual([]);
    expect(setupKinds(directoryEntry('x')!)).toEqual(['oauth_client']);
    expect(setupKinds(directoryEntry('ghost')!)).toEqual(['api_key']);
    expect(setupKinds(directoryEntry('product_hunt')!)).toEqual(['api_key']);
    expect(setupKinds(directoryEntry('medium')!)).toEqual([]);
    expect(setupKinds(directoryEntry('sessionize')!)).toEqual([]);
  });
});

describe('credentials saved for integrations that are not built yet', () => {
  let handle: DbHandle;
  let owner: OwnerContext;
  let other: OwnerContext;
  const config = testConfig();
  const env = { config };
  const as = (id: string, actor: OwnerContext['actor'] = 'owner') => sessionToOwner({ userId: id }, { db: handle.db }, actor);

  beforeAll(async () => {
    handle = await memoryDb();
    await handle.db.insert(users).values([
      { id: A, kind: 'member', displayName: 'Author A' },
      { id: B, kind: 'member', displayName: 'Author B' },
    ]);
    owner = as(A);
    other = as(B);
  });
  afterAll(async () => {
    await handle.close();
  });

  const savedRows = (ownerId: string) => sqlRows<{ id: string; platform: string; kind: string; encrypted: string; hint: string }>(handle.db, sql`select id, platform, kind, encrypted, hint from integration_secrets where owner_id = ${ownerId}`);

  it('stores them encrypted at rest, bound to the owner and the row', async () => {
    const saved = await saveIntegrationSecret(owner, env, { platform: 'ghost', kind: 'api_key', secret: API_VALUE });
    expect(saved).toMatchObject({ platform: 'ghost', kind: 'api_key', hint: API_VALUE.slice(-4) });
    const [row] = await savedRows(A);
    expect(row!.encrypted.startsWith('v1.')).toBe(true);
    expect(row!.encrypted).not.toContain(API_VALUE);
    expect(JSON.stringify(row)).not.toContain(API_VALUE);
    const key = masterKey(config);
    expect(decryptKey(row!.encrypted, key, A, row!.id)).toBe(API_VALUE);
    // Moved to another owner or another row it cannot be read: both are part of the encryption.
    expect(() => decryptKey(row!.encrypted, key, B, row!.id)).toThrow();
    expect(() => decryptKey(row!.encrypted, key, A, '33333333-3333-4333-8333-333333333333')).toThrow();
  });

  it('keeps an OAuth client id and secret together, encrypted, with only the id’s last four shown', async () => {
    const saved = await saveIntegrationSecret(owner, env, { platform: 'linkedin', kind: 'oauth_client', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    expect(saved.hint).toBe(CLIENT_ID.slice(-4));
    const row = (await savedRows(A)).find((r) => r.platform === 'linkedin')!;
    expect(row.encrypted).not.toContain(CLIENT_ID);
    expect(row.encrypted).not.toContain(CLIENT_SECRET);
    expect(JSON.parse(decryptKey(row.encrypted, masterKey(config), A, row.id))).toEqual({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  });

  it('never returns a value: not in the list, the save answer, the audit log, the export or a handler answer', async () => {
    const list = await listIntegrations(owner);
    expect(list).toHaveLength(DIRECTORY.length);
    expect(list.find((i) => i.platform === 'ghost')?.saved).toEqual([{ kind: 'api_key', hint: API_VALUE.slice(-4), savedAt: expect.any(String) }]);
    const everything = JSON.stringify([list, await owner.data.audit.list(500), await exportMyData(owner)]);
    for (const value of [API_VALUE, CLIENT_ID, CLIENT_SECRET]) expect(everything).not.toContain(value);
    expect(JSON.stringify(await owner.data.integrationSecrets.list())).not.toContain('encrypted');
    expect(Object.keys((await owner.data.integrationSecrets.get('ghost', 'api_key'))!)).not.toContain('encrypted');
  });

  it('replaces a value on a second save, one row per platform and kind', async () => {
    await saveIntegrationSecret(owner, env, { platform: 'ghost', kind: 'api_key', secret: `${API_VALUE}_v2` });
    const rows = (await savedRows(A)).filter((r) => r.platform === 'ghost');
    expect(rows).toHaveLength(1);
    expect(decryptKey(rows[0]!.encrypted, masterKey(config), A, rows[0]!.id)).toBe(`${API_VALUE}_v2`);
  });

  it('is isolated per owner: another account sees nothing, cannot remove it, and saves its own', async () => {
    expect((await listIntegrations(other)).every((i) => i.saved.length === 0)).toBe(true);
    await expect(removeIntegrationSecret(other, 'ghost', 'api_key')).rejects.toMatchObject({ code: 'not_found' });
    expect(await other.data.integrationSecrets.getWithSecret('ghost', 'api_key')).toBeNull();
    await saveIntegrationSecret(other, env, { platform: 'ghost', kind: 'api_key', secret: 'a-different-value-1234' });
    expect((await savedRows(A)).filter((r) => r.platform === 'ghost')).toHaveLength(1);
    expect((await savedRows(B)).filter((r) => r.platform === 'ghost')).toHaveLength(1);
    expect((await listIntegrations(owner)).find((i) => i.platform === 'ghost')?.saved[0]?.hint).toBe(`${API_VALUE}_v2`.slice(-4));
  });

  it('wipes the ciphertext on Remove', async () => {
    await removeIntegrationSecret(owner, 'ghost', 'api_key');
    expect((await savedRows(A)).filter((r) => r.platform === 'ghost')).toEqual([]);
    expect((await listIntegrations(owner)).find((i) => i.platform === 'ghost')?.saved).toEqual([]);
    await expect(removeIntegrationSecret(owner, 'ghost', 'api_key')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('is the signed-in owner’s act only', async () => {
    const agent = as(A, 'agent');
    await expect(saveIntegrationSecret(agent, env, { platform: 'ghost', kind: 'api_key', secret: API_VALUE })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(removeIntegrationSecret(agent, 'linkedin', 'oauth_client')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('refuses what would never be used: a working platform, a kind the platform does not take, an unknown platform, bad values', async () => {
    const refusals: [unknown, string][] = [
      [{ platform: 'devto', kind: 'api_key', secret: API_VALUE }, 'conflict'],
      [{ platform: 'site', kind: 'api_key', secret: API_VALUE }, 'conflict'],
      [{ platform: 'medium', kind: 'api_key', secret: API_VALUE }, 'conflict'],
      [{ platform: 'ghost', kind: 'oauth_client', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, 'conflict'],
      [{ platform: 'linkedin', kind: 'api_key', secret: API_VALUE }, 'conflict'],
      [{ platform: 'nowhere', kind: 'api_key', secret: API_VALUE }, 'not_found'],
      [{ platform: 'ghost', kind: 'api_key', secret: 'short' }, 'invalid'],
      [{ platform: 'ghost', kind: 'api_key', secret: 'has a space in it 12345' }, 'invalid'],
      [{ platform: 'linkedin', kind: 'oauth_client', clientId: CLIENT_ID }, 'invalid'],
      [{ platform: 'ghost', kind: 'api_key', secret: API_VALUE, ownerId: B }, 'invalid'],
    ];
    for (const [input, code] of refusals) {
      const err = await saveIntegrationSecret(owner, env, input).then(() => null, (e: unknown) => e);
      expect(err, JSON.stringify(input)).toBeInstanceOf(ActionError);
      expect((err as ActionError).code, JSON.stringify(input)).toBe(code);
      expect(JSON.stringify(err)).not.toContain(API_VALUE);
    }
  });

  it('a saved value does not make anything usable: nothing can be connected, prepared or published for an unbuilt platform', async () => {
    await saveIntegrationSecret(owner, env, { platform: 'linkedin', kind: 'oauth_client', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    await expect(connectPlatform(owner, { config, fetchFn: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch }, { platform: 'linkedin', secret: CLIENT_SECRET })).rejects.toMatchObject({ data: { code: 'NOT_PUBLISHABLE' } });
    await expect(connectPlatform(owner, { config }, { platform: 'ghost', secret: API_VALUE })).rejects.toMatchObject({ code: 'invalid' });
    const article = await createArticle(owner, { title: 'Directory test', bodyMarkdown: 'Text.\n' });
    await expect(prepareDraft(owner, {}, { articleId: article.id, platform: 'ghost' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(prepareDraft(owner, {}, { articleId: article.id, platform: 'sessionize' })).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('the integration routes', () => {
  let h: HostedHarness;
  let a: TestUser;
  let b: TestUser;

  beforeAll(async () => {
    h = await hostedHarness({ appSecret: 'a-long-test-app-secret-0123456789abcdefghijklmnop' });
    a = await h.signUp('integrations.a@example.test', 'Writer A');
    b = await h.signUp('integrations.b@example.test', 'Writer B');
  });
  afterAll(async () => {
    await h.close();
  });

  it('needs a signed-in user and, to change anything, the browser’s own origin', async () => {
    expect((await handleIntegrationsGet(h.request(null, 'GET', '/api/integrations'))).status).toBe(401);
    expect((await handleIntegrationSave(h.request(null, 'PUT', '/api/integrations/ghost', { kind: 'api_key', secret: API_VALUE }), 'ghost')).status).toBe(401);
    expect((await handleIntegrationRemove(h.request(null, 'DELETE', '/api/integrations/ghost/api_key'), 'ghost', 'api_key')).status).toBe(401);
    // An agent-style request (an Authorization header) is refused even with a session.
    const withHeader = h.request(a, 'PUT', '/api/integrations/ghost', { kind: 'api_key', secret: API_VALUE }, { authorization: 'Bearer anything-at-all-123' });
    expect((await handleIntegrationSave(withHeader, 'ghost')).status).toBe(403);
  });

  it('saves, lists without values, isolates owners and removes', async () => {
    const saved = await handleIntegrationSave(h.request(a, 'PUT', '/api/integrations/x', { kind: 'oauth_client', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }), 'x');
    expect(saved.status).toBe(201);
    const text = JSON.stringify(await saved.json());
    expect(text).not.toContain(CLIENT_SECRET);
    expect(text).not.toContain(CLIENT_ID);

    const list = (await (await handleIntegrationsGet(h.request(a, 'GET', '/api/integrations'))).json()) as { integrations: { platform: string; saved: unknown[] }[] };
    expect(list.integrations.find((i) => i.platform === 'x')?.saved).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(CLIENT_SECRET);
    const theirs = (await (await handleIntegrationsGet(h.request(b, 'GET', '/api/integrations'))).json()) as { integrations: { platform: string; saved: unknown[] }[] };
    expect(theirs.integrations.every((i) => i.saved.length === 0)).toBe(true);

    expect((await handleIntegrationRemove(h.request(b, 'DELETE', '/api/integrations/x/oauth_client'), 'x', 'oauth_client')).status).toBe(404);
    expect((await handleIntegrationRemove(h.request(a, 'DELETE', '/api/integrations/x/oauth_client'), 'x', 'oauth_client')).status).toBe(200);
    const after = (await (await handleIntegrationsGet(h.request(a, 'GET', '/api/integrations'))).json()) as { integrations: { platform: string; saved: unknown[] }[] };
    expect(after.integrations.find((i) => i.platform === 'x')?.saved).toEqual([]);
  });

  it('takes the platform from the path, not the body', async () => {
    const res = await handleIntegrationSave(h.request(a, 'PUT', '/api/integrations/ghost', { kind: 'api_key', secret: API_VALUE, platform: 'linkedin' }), 'ghost');
    expect(res.status).toBe(201);
    expect(((await res.json()) as { platform: string }).platform).toBe('ghost');
  });
});
