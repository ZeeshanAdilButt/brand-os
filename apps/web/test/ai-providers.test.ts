import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installContext, type AppContext } from '../src/server/context';
import { forOwner } from '../src/server/data/tenant';
import { ensureLocalOwner } from '../src/server/data/users';
import type { DbHandle } from '../src/server/db/client';
import { createSafeFetch, type PinnedSender } from '../src/server/ai/safe-fetch';
import { deriveTrust, isPrivateTarget } from '../src/server/ai/target';
import {
  handleProviderCreate,
  handleProviderDefault,
  handleProviderDelete,
  handleProviderPatch,
  handleProvidersGet,
  handleProviderTest,
  type AiHandlerDeps,
} from '../src/server/http/ai-handlers';
import { hostedHarness, type HostedHarness, type TestUser } from './hosted-harness';
import { memoryDb, sqlRows, testConfig } from './helpers';

const APP_SECRET = 'a-long-test-app-secret-0123456789abcdefghijklmnop';
const fakeKey = () => `fk_${randomBytes(16).toString('hex')}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response) => (await res.json()) as Record<string, any>;
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const anthropicOk = { content: [{ type: 'text', text: 'ready' }], usage: { input_tokens: 9, output_tokens: 2 }, model: 'claude-test', stop_reason: 'end_turn' };

interface Call {
  url: string;
  headers: Record<string, string>;
}

function recordingFetch(respond: (call: Call, n: number) => Response) {
  const calls: Call[] = [];
  const fn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url: String(input), headers });
    return respond(calls.at(-1)!, calls.length);
  }) as typeof fetch;
  return { fn, calls };
}

describe('providers in hosted mode', () => {
  let h: HostedHarness;
  let a: TestUser;
  let b: TestUser;
  let aProviderId: string;
  const aKey = fakeKey();

  beforeAll(async () => {
    h = await hostedHarness({ appSecret: APP_SECRET });
    a = await h.signUp('prov.a@example.test', 'Writer A');
    b = await h.signUp('prov.b@example.test', 'Writer B');
    const res = await handleProviderCreate(
      h.request(a, 'POST', '/api/ai/providers', { kind: 'api_key', protocol: 'anthropic', name: 'Claude', model: 'claude-sonnet-5-5', apiKey: aKey }),
    );
    expect(res.status).toBe(201);
    aProviderId = (await json(res)).id;
  });

  afterAll(async () => {
    await h.close();
  });

  it('stores the key only as ciphertext and never returns it', async () => {
    const list = await json(await handleProvidersGet(h.request(a, 'GET', '/api/ai/providers')));
    expect(list.available).toBe(true);
    expect(list.providers).toHaveLength(1);
    expect(list.providers[0]).toMatchObject({ kind: 'api_key', protocol: 'anthropic', trust: 'external', hasKey: true, keyLast4: aKey.slice(-4), ready: true, isDefault: true });
    expect(JSON.stringify(list)).not.toContain(aKey);

    const [row] = await sqlRows<{ encrypted_key: string; key_last4: string }>(h.handle.db, sql`select encrypted_key, key_last4 from ai_providers where id = ${aProviderId}`);
    expect(row!.encrypted_key.startsWith('v1.')).toBe(true);
    expect(row!.encrypted_key).not.toContain(aKey);
    expect(row!.key_last4).toBe(aKey.slice(-4));

    const everything = JSON.stringify(await sqlRows(h.handle.db, sql`select * from audit_events where owner_id = ${a.userId}`));
    expect(everything).not.toContain(aKey);
  });

  it('does not return the key from create, update or default either', async () => {
    const created = await handleProviderCreate(h.request(a, 'POST', '/api/ai/providers', { kind: 'api_key', protocol: 'anthropic', name: 'Second', model: 'm', apiKey: aKey }));
    const body = await created.text();
    expect(body).not.toContain(aKey);
    const id = JSON.parse(body).id as string;
    const patched = await handleProviderPatch(h.request(a, 'PATCH', `/api/ai/providers/${id}`, { name: 'Renamed' }), id);
    expect(await patched.text()).not.toContain(aKey);
    const made = await handleProviderDefault(h.request(a, 'POST', `/api/ai/providers/${id}/default`, {}), id);
    expect(await made.text()).not.toContain(aKey);
    await handleProviderDelete(h.request(a, 'DELETE', `/api/ai/providers/${id}`), id);
  });

  it('tests a connection with the decrypted key and a tiny prompt that holds no article text', async () => {
    const { fn, calls } = recordingFetch(() => jsonResponse(anthropicOk));
    const res = await handleProviderTest(h.request(a, 'POST', `/api/ai/providers/${aProviderId}/test`, {}), aProviderId, { ai: { fetchFn: fn } });
    const outcome = await json(res);
    expect(outcome).toMatchObject({ ok: true, sample: 'ready' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]?.headers['x-api-key']).toBe(aKey);
    const listed = await json(await handleProvidersGet(h.request(a, 'GET', '/api/ai/providers')));
    expect(listed.providers[0].lastTest).toMatchObject({ ok: true });
  });

  it('redacts the key in a failed test, in the answer and in what is stored', async () => {
    const { fn } = recordingFetch(() => jsonResponse({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${aKey}` } }, 401));
    const outcome = await json(await handleProviderTest(h.request(a, 'POST', `/api/ai/providers/${aProviderId}/test`, {}), aProviderId, { ai: { fetchFn: fn } }));
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain(aKey);
    const [row] = await sqlRows<{ last_test_message: string }>(h.handle.db, sql`select last_test_message from ai_providers where id = ${aProviderId}`);
    expect(row!.last_test_message).not.toContain(aKey);
  });

  it('keeps providers, keys and tests private to their owner', async () => {
    const asB = await json(await handleProvidersGet(h.request(b, 'GET', '/api/ai/providers')));
    expect(asB.providers).toEqual([]);
    expect(asB.available).toBe(false);
    const { fn, calls } = recordingFetch(() => jsonResponse(anthropicOk));
    const deps: AiHandlerDeps = { ai: { fetchFn: fn } };
    expect((await handleProviderTest(h.request(b, 'POST', `/api/ai/providers/${aProviderId}/test`, {}), aProviderId, deps)).status).toBe(404);
    expect((await handleProviderPatch(h.request(b, 'PATCH', `/api/ai/providers/${aProviderId}`, { name: 'Hijacked', enabled: false }), aProviderId)).status).toBe(404);
    expect((await handleProviderDefault(h.request(b, 'POST', `/api/ai/providers/${aProviderId}/default`, {}), aProviderId)).status).toBe(404);
    expect((await handleProviderDelete(h.request(b, 'DELETE', `/api/ai/providers/${aProviderId}`), aProviderId)).status).toBe(404);
    expect(calls).toHaveLength(0);
    const still = await forOwner(a.userId, h.ctx.db).providers.get(aProviderId);
    expect(still).toMatchObject({ name: 'Claude', enabled: true });
    expect(await forOwner(b.userId, h.ctx.db).providers.get(aProviderId)).toBeNull();
  });

  it('requires a signed-in user', async () => {
    expect((await handleProvidersGet(h.request(null, 'GET', '/api/ai/providers'))).status).toBe(401);
    expect((await handleProviderCreate(h.request(null, 'POST', '/api/ai/providers', { kind: 'claude_code_handoff', name: 'x' }))).status).toBe(401);
  });

  it('refuses a model on the visitor\'s machine, plain http and private addresses on a hosted server', async () => {
    const create = (body: unknown) => handleProviderCreate(h.request(b, 'POST', '/api/ai/providers', body));
    const local = await create({ kind: 'local', name: 'x', baseUrl: 'http://localhost:11434/v1', model: 'm' });
    expect(local.status).toBe(400);
    expect((await json(local)).fields.baseUrl).toMatch(/hosted server cannot reach/);
    const http = await create({ kind: 'api_key', protocol: 'openai_compatible', name: 'x', baseUrl: 'http://api.example.test/v1', model: 'm', apiKey: fakeKey() });
    expect((await json(http)).fields.baseUrl).toMatch(/https/);
    for (const address of ['https://127.0.0.1/v1', 'https://192.168.1.10/v1', 'https://169.254.169.254/v1', 'https://localhost/v1', 'https://db.internal/v1', 'https://api.example.test:8080/v1']) {
      const res = await create({ kind: 'api_key', protocol: 'openai_compatible', name: 'x', baseUrl: address, model: 'm', apiKey: fakeKey() });
      expect(res.status, address).toBe(400);
    }
    expect(await forOwner(b.userId, h.ctx.db).providers.count()).toBe(0);
  });

  it('accepts a public https address for an OpenAI-compatible service', async () => {
    const res = await handleProviderCreate(
      h.request(b, 'POST', '/api/ai/providers', { kind: 'api_key', protocol: 'openai_compatible', name: 'Gateway', baseUrl: 'https://api.example.test/v1/', model: 'm', apiKey: fakeKey() }),
    );
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ baseUrl: 'https://api.example.test/v1', trust: 'external' });
  });

  it('reserves the CLI agent type without building it', async () => {
    const res = await handleProviderCreate(h.request(b, 'POST', '/api/ai/providers', { kind: 'local_cli_agent', name: 'cli' }));
    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatch(/not available yet/);
  });
});

describe('providers without APP_SECRET on a hosted server', () => {
  it('cannot save a key and says exactly what to set', async () => {
    const h = await hostedHarness();
    try {
      const u = await h.signUp('nosecret@example.test');
      const res = await handleProviderCreate(h.request(u, 'POST', '/api/ai/providers', { kind: 'api_key', protocol: 'anthropic', name: 'Claude', model: 'm', apiKey: fakeKey() }));
      expect(res.status).toBe(503);
      expect((await json(res)).error).toMatch(/APP_SECRET/);
      expect(await forOwner(u.userId, h.ctx.db).providers.count()).toBe(0);
      // A hand-off provider needs no key and works.
      expect((await handleProviderCreate(h.request(u, 'POST', '/api/ai/providers', { kind: 'claude_code_handoff', name: 'Claude Code' }))).status).toBe(201);
    } finally {
      await h.close();
    }
  });
});

describe('providers in local mode', () => {
  let handle: DbHandle;
  let uninstall: () => void;
  const APP = 'http://localhost:3100';
  const req = (method: string, path: string, body?: unknown) =>
    new Request(`${APP}${path}`, {
      method,
      headers: { host: 'localhost:3100', ...(method === 'GET' ? {} : { origin: APP, 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeAll(async () => {
    handle = await memoryDb();
    await ensureLocalOwner(handle.db);
    const ctx: AppContext = { config: testConfig(), db: handle.db, auth: null };
    uninstall = installContext(ctx);
  });
  afterAll(async () => {
    uninstall();
    await handle.close();
  });

  it('starts in no-AI mode: nothing is configured and nothing is available', async () => {
    const list = await json(await handleProvidersGet(req('GET', '/api/ai/providers')));
    expect(list).toEqual({ providers: [], available: false });
  });

  it('keeps text local only for a local model on this machine or a private network', async () => {
    const ollama = await json(await handleProviderCreate(req('POST', '/api/ai/providers', { kind: 'local', name: 'Ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama-test' })));
    expect(ollama).toMatchObject({ trust: 'local', protocol: 'openai_compatible', ready: true, isDefault: true, hasKey: false });
    const lan = await json(await handleProviderCreate(req('POST', '/api/ai/providers', { kind: 'local', name: 'LAN box', baseUrl: 'http://192.168.1.20:8080/v1', model: 'm' })));
    expect(lan.trust).toBe('local');
    // A "local" provider pointed at a public address is not local: the text leaves the network.
    const remote = await json(await handleProviderCreate(req('POST', '/api/ai/providers', { kind: 'local', name: 'Remote', baseUrl: 'https://models.example.test/v1', model: 'm' })));
    expect(remote.trust).toBe('external');
  });

  it('lets the hand-off be ready with no model and no key, and runs nothing', async () => {
    const handoff = await json(await handleProviderCreate(req('POST', '/api/ai/providers', { kind: 'claude_code_handoff', name: 'Claude Code' })));
    expect(handoff).toMatchObject({ kind: 'claude_code_handoff', ready: true, trust: 'external', model: null, protocol: null });
    const test = await handleProviderTest(req('POST', `/api/ai/providers/${handoff.id}/test`, {}), handoff.id);
    expect(test.status).toBe(400);
    expect((await json(test)).error).toMatch(/wait for your Claude Code/);
  });

  it('validates input with field messages', async () => {
    const noModel = await json(await handleProviderCreate(req('POST', '/api/ai/providers', { kind: 'local', name: 'x', baseUrl: 'http://localhost:1/v1' })));
    expect(noModel.fields.model).toBeTruthy();
    const noKey = await json(await handleProviderCreate(req('POST', '/api/ai/providers', { kind: 'api_key', protocol: 'anthropic', name: 'x', model: 'm' })));
    expect(noKey.fields.apiKey).toBeTruthy();
    const badUrl = await json(await handleProviderCreate(req('POST', '/api/ai/providers', { kind: 'local', name: 'x', baseUrl: 'ftp://localhost/v1', model: 'm' })));
    expect(badUrl.fields.baseUrl).toBeTruthy();
    const creds = await json(await handleProviderCreate(req('POST', '/api/ai/providers', { kind: 'local', name: 'x', baseUrl: 'http://user:pass@localhost/v1', model: 'm' })));
    expect(creds.fields.baseUrl).toMatch(/key field/);
    const cap = await json(await handleProviderCreate(req('POST', '/api/ai/providers', { kind: 'local', name: 'x', baseUrl: 'http://localhost/v1', model: 'm', monthlyTokenCap: -5 })));
    expect(cap.fields.monthlyTokenCap).toBeTruthy();
  });

  it('moves the default when the default is removed, and can turn a provider off', async () => {
    const list = await json(await handleProvidersGet(req('GET', '/api/ai/providers')));
    const def = list.providers.find((p: { isDefault: boolean }) => p.isDefault);
    const other = list.providers.find((p: { id: string; kind: string }) => p.id !== def.id && p.kind === 'local');
    expect((await handleProviderDelete(req('DELETE', `/api/ai/providers/${def.id}`), def.id)).status).toBe(200);
    const after = await json(await handleProvidersGet(req('GET', '/api/ai/providers')));
    expect(after.providers.filter((p: { isDefault: boolean }) => p.isDefault)).toHaveLength(1);
    expect(after.providers.find((p: { id: string }) => p.id === def.id)).toBeUndefined();
    const off = await json(await handleProviderPatch(req('PATCH', `/api/ai/providers/${other.id}`, { enabled: false }), other.id));
    expect(off).toMatchObject({ enabled: false, ready: false, notReadyReason: 'Turned off.' });
    const moved = await json(await handleProviderDefault(req('POST', `/api/ai/providers/${after.providers.at(-1).id}/default`, {}), after.providers.at(-1).id));
    expect(moved.isDefault).toBe(true);
    expect((await json(await handleProvidersGet(req('GET', '/api/ai/providers')))).providers.filter((p: { isDefault: boolean }) => p.isDefault)).toHaveLength(1);
  });

  it('replaces and clears a saved key without ever showing it', async () => {
    const first = fakeKey();
    const created = await json(await handleProviderCreate(req('POST', '/api/ai/providers', { kind: 'api_key', protocol: 'openai_compatible', name: 'Svc', baseUrl: 'https://api.example.test/v1', model: 'm', apiKey: first })));
    expect(created.keyLast4).toBe(first.slice(-4));
    const second = fakeKey();
    const replaced = await json(await handleProviderPatch(req('PATCH', `/api/ai/providers/${created.id}`, { apiKey: second }), created.id));
    expect(replaced.keyLast4).toBe(second.slice(-4));
    expect(JSON.stringify(replaced)).not.toContain(second);
    const cleared = await json(await handleProviderPatch(req('PATCH', `/api/ai/providers/${created.id}`, { clearKey: true }), created.id));
    expect(cleared).toMatchObject({ hasKey: false, ready: false, notReadyReason: 'Add the API key.' });
  });
});

describe('where text goes', () => {
  it('knows private addresses from public ones', () => {
    for (const url of ['http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:8080/v1', 'http://192.168.0.5/v1', 'http://10.1.2.3/v1', 'http://box.local/v1', 'http://myserver/v1', 'http://host.docker.internal:11434/v1']) {
      expect(isPrivateTarget(new URL(url)), url).toBe(true);
    }
    for (const url of ['https://api.example.test/v1', 'https://8.8.8.8/v1', 'https://models.example.test:8443/v1']) {
      expect(isPrivateTarget(new URL(url)), url).toBe(false);
    }
  });

  it('derives trust from the kind and address, not from anything typed', () => {
    expect(deriveTrust('local', 'http://localhost:11434/v1')).toBe('local');
    expect(deriveTrust('local', 'https://models.example.test/v1')).toBe('external');
    expect(deriveTrust('api_key', 'http://localhost:11434/v1')).toBe('external');
    expect(deriveTrust('claude_code_handoff', null)).toBe('external');
    expect(deriveTrust('local', null)).toBe('external');
  });

  it('calls a user-supplied address only after resolving it to a public address, and pins the connection', async () => {
    const sent: { address: string; host: string | undefined }[] = [];
    const send: PinnedSender = async (r) => {
      sent.push({ address: r.address, host: r.headers.host });
      return jsonResponse({ ok: true });
    };
    const publicFetch = createSafeFetch({ resolve: async () => [{ address: '93.184.216.34', family: 4 }], send });
    expect((await publicFetch('https://api.example.test/v1/chat/completions', { method: 'POST', body: '{}' })).status).toBe(200);
    expect(sent).toEqual([{ address: '93.184.216.34', host: 'api.example.test' }]);

    const rebinding = createSafeFetch({ resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }], send });
    await expect(rebinding('https://api.example.test/v1')).rejects.toThrow(/private network|this computer/);
    const metadata = createSafeFetch({ resolve: async () => [{ address: '169.254.169.254', family: 4 }], send });
    await expect(metadata('https://api.example.test/v1')).rejects.toThrow();
    const plain = createSafeFetch({ resolve: async () => [{ address: '93.184.216.34', family: 4 }], send });
    await expect(plain('http://api.example.test/v1')).rejects.toThrow(/https/);
    expect(sent).toHaveLength(1);
  });
});
