import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DELETE as credentialDelete } from '../src/app/api/agent-credentials/[id]/route';
import { GET as credentialsGet, POST as credentialsPost } from '../src/app/api/agent-credentials/route';
import { GET as agentMe } from '../src/app/api/agent/me/route';
import { createCredential } from '../src/server/actions/agent-credentials';
import { sessionToOwner } from '../src/server/actions/owner';
import { RateLimiter } from '../src/server/agent/rate-limit';
import { generateSecret, hashSecret, looksLikeSecret } from '../src/server/agent/secret';
import { handleAgentMe } from '../src/server/http/agent-handlers';
import { hostedHarness, type HostedHarness, type TestUser } from './hosted-harness';
import { sqlRows } from './helpers';

let h: HostedHarness;
let a: TestUser;
let b: TestUser;

const params = (id: string) => ({ params: Promise.resolve({ id }) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response) => (await res.json()) as Record<string, any>;
const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

async function create(user: TestUser, name: string, scopes: string[]) {
  const res = await credentialsPost(h.request(user, 'POST', '/api/agent-credentials', { name, scopes }));
  expect(res.status).toBe(201);
  return (await json(res)) as { credential: { id: string; prefix: string; scopes: string[] }; secret: string };
}

beforeAll(async () => {
  h = await hostedHarness();
  a = await h.signUp('agent.a@example.test', 'Agent A');
  b = await h.signUp('agent.b@example.test', 'Agent B');
});

afterAll(async () => {
  await h.close();
});

describe('agent secrets', () => {
  it('are random, shaped, and stored only as a hash', async () => {
    const one = generateSecret();
    const two = generateSecret();
    expect(one.secret).not.toBe(two.secret);
    expect(looksLikeSecret(one.secret)).toBe(true);
    expect(looksLikeSecret('bos_short')).toBe(false);
    expect(looksLikeSecret(`x${one.secret.slice(1)}`)).toBe(false);
    expect(one.hash).toBe(hashSecret(one.secret));
    expect(one.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(one.secret.startsWith(one.prefix)).toBe(true);
    expect(one.prefix.length).toBeLessThan(10);
  });

  it('are shown once, and the database holds a hash that is not the secret', async () => {
    const made = await create(a, 'laptop', ['read']);
    expect(looksLikeSecret(made.secret)).toBe(true);
    const rows = await sqlRows<{ secret_hash: string; prefix: string }>(h.handle.db, sql`select secret_hash, prefix from agent_credentials where id = ${made.credential.id}`);
    const row = rows[0]!;
    expect(row.secret_hash).toBe(hashSecret(made.secret));
    expect(row.secret_hash).not.toContain(made.secret);
    const everything = JSON.stringify(await sqlRows(h.handle.db, sql`select * from agent_credentials where id = ${made.credential.id}`));
    expect(everything).not.toContain(made.secret);

    const listed = await json(await credentialsGet(h.request(a, 'GET', '/api/agent-credentials')));
    expect(JSON.stringify(listed)).not.toContain(made.secret);
    expect(JSON.stringify(listed)).not.toContain(row.secret_hash);
    expect(listed.credentials.some((c: { id: string }) => c.id === made.credential.id)).toBe(true);
  });

  it('are validated: a name and at least one known scope are required', async () => {
    const noName = await credentialsPost(h.request(a, 'POST', '/api/agent-credentials', { name: '  ', scopes: ['read'] }));
    expect(noName.status).toBe(400);
    const noScopes = await credentialsPost(h.request(a, 'POST', '/api/agent-credentials', { name: 'x', scopes: [] }));
    expect(noScopes.status).toBe(400);
    const unknown = await credentialsPost(h.request(a, 'POST', '/api/agent-credentials', { name: 'x', scopes: ['publish'] }));
    expect(unknown.status).toBe(400);
  });

  it('can only be managed by a signed-in person', async () => {
    expect((await credentialsGet(h.request(null, 'GET', '/api/agent-credentials'))).status).toBe(401);
    expect((await credentialsPost(h.request(null, 'POST', '/api/agent-credentials', { name: 'x', scopes: ['read'] }))).status).toBe(401);
    // An agent acting through the action layer cannot mint another credential.
    const owner = sessionToOwner({ userId: a.userId }, h.ctx, 'agent');
    await expect(createCredential(owner, { name: 'sneaky', scopes: ['read'] })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('the agent API', () => {
  it('refuses a missing, malformed or unknown credential with the same answer', async () => {
    const unknown = generateSecret().secret;
    const attempts = [{}, { authorization: 'Bearer nope' }, { authorization: 'Basic abc' }, bearer(unknown)];
    for (const headers of attempts) {
      const res = await agentMe(h.request(null, 'GET', '/api/agent/me', undefined, headers));
      expect(res.status).toBe(401);
      expect((await json(res)).error).toMatch(/not valid/);
    }
  });

  it('uses the credential, and nothing else, to choose the owner', async () => {
    const mine = await create(a, 'for A', ['read']);
    const theirs = await create(b, 'for B', ['read']);
    const asA = await agentMe(h.request(null, 'GET', `/api/agent/me?ownerId=${b.userId}&userId=${b.userId}`, undefined, { ...bearer(mine.secret), 'x-owner-id': b.userId }));
    expect(asA.status).toBe(200);
    const body = await json(asA);
    expect(body.credential.name).toBe('for A');
    const asB = await json(await agentMe(h.request(null, 'GET', '/api/agent/me', undefined, bearer(theirs.secret))));
    expect(asB.credential.name).toBe('for B');
  });

  it('records last use', async () => {
    const made = await create(a, 'last used', ['read']);
    const before = (await json(await credentialsGet(h.request(a, 'GET', '/api/agent-credentials')))).credentials.find((c: { id: string }) => c.id === made.credential.id);
    expect(before.lastUsedAt).toBeNull();
    expect((await agentMe(h.request(null, 'GET', '/api/agent/me', undefined, bearer(made.secret)))).status).toBe(200);
    const after = (await json(await credentialsGet(h.request(a, 'GET', '/api/agent-credentials')))).credentials.find((c: { id: string }) => c.id === made.credential.id);
    expect(after.lastUsedAt).not.toBeNull();
  });

  it('enforces scopes', async () => {
    const onlyTasks = await create(a, 'tasks only', ['ai_tasks']);
    const res = await agentMe(h.request(null, 'GET', '/api/agent/me', undefined, bearer(onlyTasks.secret)));
    expect(res.status).toBe(403);
    expect((await json(res)).error).toMatch(/"read" scope/);
  });

  it('stops working the moment a credential is revoked, and says nothing more than "not valid"', async () => {
    const made = await create(a, 'to revoke', ['read']);
    expect((await agentMe(h.request(null, 'GET', '/api/agent/me', undefined, bearer(made.secret)))).status).toBe(200);
    const revoked = await credentialDelete(h.request(a, 'DELETE', `/api/agent-credentials/${made.credential.id}`), params(made.credential.id));
    expect(revoked.status).toBe(200);
    expect((await json(revoked)).revokedAt).not.toBeNull();
    const after = await agentMe(h.request(null, 'GET', '/api/agent/me', undefined, bearer(made.secret)));
    expect(after.status).toBe(401);
    // Revoking twice is harmless.
    expect((await credentialDelete(h.request(a, 'DELETE', `/api/agent-credentials/${made.credential.id}`), params(made.credential.id))).status).toBe(200);
    // The attempt is in the owner's audit log.
    const audit = await sqlRows(h.handle.db, sql`select action from audit_events where owner_id = ${a.userId} and action = 'agent.denied_revoked'`);
    expect(audit.length).toBeGreaterThan(0);
  });

  it('rate limits per credential and slows repeated failures', async () => {
    const limiters = {
      perCredential: new RateLimiter(2, 60_000),
      failures: new RateLimiter(2, 60_000),
    };
    const made = await create(a, 'limited', ['read']);
    const call = (headers: Record<string, string>) => handleAgentMe(h.request(null, 'GET', '/api/agent/me', undefined, headers), { limiters });
    expect((await call(bearer(made.secret))).status).toBe(200);
    expect((await call(bearer(made.secret))).status).toBe(200);
    const limited = await call(bearer(made.secret));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);

    const bad = bearer(generateSecret().secret);
    expect((await call(bad)).status).toBe(401);
    expect((await call(bad)).status).toBe(401);
    expect((await call(bad)).status).toBe(429);
  });

  it('records agent activity in the owner\'s audit log', async () => {
    const [row] = await sqlRows<{ n: number }>(h.handle.db, sql`select count(*)::int as n from audit_events where owner_id = ${a.userId} and actor = 'agent'`);
    expect(row!.n).toBeGreaterThanOrEqual(1);
  });
});

describe('isolation between owners', () => {
  it('lists only your own credentials', async () => {
    const mine = await create(a, 'private to A', ['read']);
    const asB = await json(await credentialsGet(h.request(b, 'GET', '/api/agent-credentials')));
    expect(asB.credentials.some((c: { id: string }) => c.id === mine.credential.id)).toBe(false);
  });

  it('cannot revoke another owner\'s credential, even with its id, and it keeps working', async () => {
    const mine = await create(a, 'target', ['read']);
    const attempt = await credentialDelete(h.request(b, 'DELETE', `/api/agent-credentials/${mine.credential.id}`), params(mine.credential.id));
    expect(attempt.status).toBe(404);
    expect((await agentMe(h.request(null, 'GET', '/api/agent/me', undefined, bearer(mine.secret)))).status).toBe(200);
  });
});
