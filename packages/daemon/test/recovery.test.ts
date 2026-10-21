import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GateError } from '../src/gate/errors.js';
import { DevtoRoute } from '../src/routes/devto.js';
import { MemoryKeyStore } from '../src/secrets/keystore.js';
import { SecretStore } from '../src/secrets/secret-store.js';
import { DraftError } from '../src/services/drafts.js';
import { FakeRoute } from './helpers/fake-route.js';
import { goodLinkedinText, makeRig, SLUG, type Rig } from './helpers/service-rig.js';

const FAKE_KEY = 'not-a-real-key-0123456789abcdef';
const ARTICLE_ID = 4242;

let r: Rig;

afterEach(() => {
  r.db.close();
});

/** A dev.to that lists article 4242 as published (or unpublished), and records every request. */
function fakeDevto(list: 'published' | 'unpublished'): { fetchFn: typeof fetch; requests: { method: string; path: string }[] } {
  const requests: { method: string; path: string }[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    requests.push({ method, path: url.pathname });
    const which = /^\/api\/articles\/me\/(published|unpublished)$/.exec(url.pathname)?.[1];
    if (method === 'GET' && which !== undefined) {
      const body = which === list ? [{ id: ARTICLE_ID, published: list === 'published', url: 'https://dev.to/zee/post-4242' }] : [];
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return Promise.resolve(new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 }));
  };
  return { fetchFn, requests };
}

/** A rig whose dev.to route is the real DevtoRoute over a fake dev.to, with a stored key. */
function rigWithRealDevto(list: 'published' | 'unpublished'): { fake: ReturnType<typeof fakeDevto> } {
  const fake = fakeDevto(list);
  r = makeRig({
    routes: (repos) => {
      const secrets = new SecretStore(new MemoryKeyStore(), repos);
      secrets.ensureMasterKey();
      secrets.put('devto', 'default', { apiKey: FAKE_KEY });
      const route = new DevtoRoute({ secrets, fetchFn: fake.fetchFn, now: () => new Date(), markFailed: () => undefined });
      return [route, new FakeRoute('linkedin', 'buffer'), new FakeRoute('linkedin', 'assist', { handOff: true })];
    },
  });
  return { fake };
}

/** A dev.to draft left in `publishing`, as after a crash between consume and the platform's answer. */
function leftPublishing(): string {
  const draft = r.drafts.create({ slug: SLUG, platform: 'devto' });
  r.repos.drafts.update(draft.id, { status: 'publishing', remoteRef: String(ARTICLE_ID) });
  return draft.id;
}

describe('RecoveryService.sweepOnStartup', () => {
  it('moves a publishing draft to unknown, checks dev.to, and records the publication it finds', async () => {
    const { fake } = rigWithRealDevto('published');
    const draftId = leftPublishing();

    await r.recovery.sweepOnStartup();

    const draft = r.repos.drafts.get(draftId);
    expect(draft?.status).toBe('published');
    const pub = r.repos.publications.findByHash('devto', draft?.payloadSha256 as string);
    expect(pub).toMatchObject({ draftId, platform: 'devto', remoteId: String(ARTICLE_ID) });
    expect(r.actions(draftId)).toEqual(['draft_created', 'recovered_unknown', 'check_on_platform']);
    // Only reads: never a PUT or POST.
    expect(fake.requests.every((q) => q.method === 'GET')).toBe(true);
    expect(fake.requests.length).toBeGreaterThan(0);
  });

  it('an article still private on dev.to gives failed (a fresh approval can follow)', async () => {
    rigWithRealDevto('unpublished');
    const draftId = leftPublishing();
    await r.recovery.sweepOnStartup();
    expect(r.repos.drafts.get(draftId)).toMatchObject({ status: 'failed' });
    expect(r.repos.publications.findByHash('devto', r.repos.drafts.get(draftId)?.payloadSha256 as string)).toBeUndefined();
  });

  it('calls checkOnPlatform (never publish) and leaves unknown when the platform cannot tell', async () => {
    r = makeRig();
    r.devto.checkImpl = () => Promise.resolve('unknown');
    const draftId = leftPublishing();
    await r.recovery.sweepOnStartup();
    expect(r.devto.checkCalls).toHaveLength(1);
    expect(r.devto.publishCalls).toHaveLength(0);
    expect(r.repos.drafts.get(draftId)?.status).toBe('unknown');
    expect(r.notifier.toasts.some((t) => t.level === 'critical')).toBe(true);
  });

  it('a check that throws (Buffer BUDGET_LOW) leaves the draft unknown', async () => {
    r = makeRig();
    const draft = r.drafts.create({ slug: SLUG, platform: 'linkedin', payload: { text: goodLinkedinText(r.item) } });
    r.repos.drafts.update(draft.id, { status: 'publishing' });
    r.buffer.checkImpl = () => Promise.reject(new GateError('BUDGET_LOW', 'Buffer budget is low'));
    await r.recovery.sweepOnStartup();
    expect(r.repos.drafts.get(draft.id)?.status).toBe('unknown');
    expect(r.actions(draft.id)).toContain('check_on_platform_failed');
    expect(r.buffer.publishCalls).toHaveLength(0);
  });

  it('a route with no platform read leaves the draft unknown for a manual check', async () => {
    r = makeRig({ linkedinRoute: 'assist' });
    const draft = r.drafts.create({ slug: SLUG, platform: 'linkedin', payload: { text: goodLinkedinText(r.item) } });
    r.repos.drafts.update(draft.id, { status: 'publishing' });
    await r.recovery.sweepOnStartup();
    expect(r.repos.drafts.get(draft.id)?.status).toBe('unknown');
  });
});

describe('RecoveryService.checkOnPlatform and resolveByHand', () => {
  beforeEach(() => {
    r = makeRig();
  });

  it('checkOnPlatform refuses a draft that is not unknown', async () => {
    const draft = r.drafts.create({ slug: SLUG, platform: 'devto' });
    await expect(r.recovery.checkOnPlatform(draft.id)).rejects.toBeInstanceOf(DraftError);
    expect(r.devto.checkCalls).toHaveLength(0);
  });

  it('checkOnPlatform resolves published once; a second check does not add a second row', async () => {
    const draftId = leftPublishing();
    r.repos.drafts.update(draftId, { status: 'unknown' });
    expect(await r.recovery.checkOnPlatform(draftId)).toBe('published');
    await expect(r.recovery.checkOnPlatform(draftId)).rejects.toBeInstanceOf(DraftError);
    expect(r.devto.publishCalls).toHaveLength(0);
  });

  it('resolveByHand marks an unknown draft published (with its URL) or failed', () => {
    const a = leftPublishing();
    r.repos.drafts.update(a, { status: 'unknown' });
    r.recovery.resolveByHand(a, 'published', { remoteUrl: 'https://dev.to/zee/post-4242' });
    expect(r.repos.drafts.get(a)?.status).toBe('published');
    expect(r.repos.publications.findByHash('devto', r.repos.drafts.get(a)?.payloadSha256 as string)?.remoteUrl).toBe(
      'https://dev.to/zee/post-4242',
    );

    const b = r.drafts.create({ slug: SLUG, platform: 'linkedin', payload: { text: goodLinkedinText(r.item) } }).id;
    r.repos.drafts.update(b, { status: 'unknown' });
    r.recovery.resolveByHand(b, 'failed');
    expect(r.repos.drafts.get(b)?.status).toBe('failed');
    expect(() => r.recovery.resolveByHand(b, 'failed')).toThrow(DraftError);
  });
});
