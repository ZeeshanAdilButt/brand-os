import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GateError } from '../src/gate/errors.js';
import { AssistLinkedinRoute, LINKEDIN_FEED_URL } from '../src/routes/assist-linkedin.js';
import { BufferPublishNotSentError } from '../src/routes/buffer.js';
import { BufferMutationError } from '../src/routes/buffer-client.js';
import { DevtoRoute } from '../src/routes/devto.js';
import { PlatformError } from '../src/routes/types.js';
import { MemoryKeyStore } from '../src/secrets/keystore.js';
import { SecretStore } from '../src/secrets/secret-store.js';
import { DraftError } from '../src/services/drafts.js';
import { isCleanRefusal, markFailedIn } from '../src/services/publish.js';
import { FakeDevto } from './helpers/fake-devto.js';
import { FakeRoute } from './helpers/fake-route.js';
import { goodLinkedinText, makeRig, SLUG, type Rig } from './helpers/service-rig.js';

let r: Rig;

beforeEach(() => {
  r = makeRig();
});

afterEach(() => {
  r.db.close();
});

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

async function gateCode(p: Promise<unknown>): Promise<string> {
  const err = await rejection(p);
  expect(err).toBeInstanceOf(GateError);
  return (err as GateError).code;
}

/** A staged dev.to draft with an approve-only approval. */
async function stagedDevto(): Promise<{ draftId: string; approvalId: string }> {
  const draft = r.drafts.create({ slug: SLUG, platform: 'devto' });
  await r.drafts.stage(draft.id);
  return { draftId: draft.id, approvalId: await r.approve(draft.id) };
}

/** A lint-clean LinkedIn (Buffer) draft with an approve-only approval. */
async function linkedin(): Promise<{ draftId: string; approvalId: string }> {
  const draft = r.drafts.create({ slug: SLUG, platform: 'linkedin', payload: { text: goodLinkedinText(r.item) } });
  return { draftId: draft.id, approvalId: await r.approve(draft.id) };
}

describe('PublishService.publish', () => {
  it('dev.to: exactly one route call, a publication row, and the audit sequence', async () => {
    const { draftId, approvalId } = await stagedDevto();
    const result = await r.publish.publish(draftId, approvalId);

    expect(result).toEqual({ status: 'published', remoteUrl: `https://example.test/devto/${draftId}` });
    expect(r.devto.publishCalls).toHaveLength(1);
    const sent = r.devto.publishCalls[0];
    expect(sent?.draft.payloadSha256).toBe(sent?.approval.payloadSha256);
    expect(sent?.draft.status).toBe('publishing');

    const draft = r.repos.drafts.get(draftId);
    expect(draft?.status).toBe('published');
    const publication = r.repos.publications.findByHash('devto', draft?.payloadSha256 as string);
    expect(publication).toMatchObject({ draftId, platform: 'devto', account: 'default', remoteId: `remote-${draftId}` });
    expect(publication?.remoteUrl).toBe(`https://example.test/devto/${draftId}`);

    const actions = r.actions(draftId);
    expect(actions.slice(actions.indexOf('approval_requested'))).toEqual([
      'approval_requested',
      'approved',
      'authorize_ok',
      'publish_started',
      'published',
    ]);
  });

  it('a clean platform refusal (422) gives failed with the redacted error, and no second call', async () => {
    const { draftId, approvalId } = await stagedDevto();
    r.devto.publishImpl = () =>
      Promise.reject(new PlatformError('dev.to PUT failed with 422: api-key: not-a-real-key-0123456789abcdef is wrong', 422));

    const result = await r.publish.publish(draftId, approvalId);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/422/);
    expect(result.error).not.toContain('not-a-real-key-0123456789abcdef');
    expect(r.repos.drafts.get(draftId)).toMatchObject({ status: 'failed' });
    expect(r.repos.drafts.get(draftId)?.failureReason).not.toContain('not-a-real-key-0123456789abcdef');
    const [row] = r.repos.audit.list({ draftId, limit: 1 });
    expect(row?.action).toBe('publish_failed');
    expect(JSON.stringify(row?.detail)).not.toContain('not-a-real-key-0123456789abcdef');

    expect(await gateCode(r.publish.publish(draftId, approvalId))).toBe('USED');
    expect(r.devto.publishCalls).toHaveLength(1);
  });

  it('a Buffer MutationError is a clean refusal: failed', async () => {
    const { draftId, approvalId } = await linkedin();
    r.buffer.publishImpl = () => Promise.reject(new BufferMutationError('Buffer refused the post'));
    expect((await r.publish.publish(draftId, approvalId)).status).toBe('failed');
    expect(r.buffer.publishCalls).toHaveLength(1);
  });

  it.each([
    ['a timeout', () => new DOMException('The operation was aborted due to timeout', 'TimeoutError')],
    ['a network error', () => new TypeError('fetch failed')],
    ['a 503', () => new PlatformError('dev.to PUT failed with 503', 503)],
  ])('%s gives unknown (not failed), a critical toast, and no second call', async (_name, makeError) => {
    const { draftId, approvalId } = await stagedDevto();
    r.devto.publishImpl = () => Promise.reject(makeError());

    const result = await r.publish.publish(draftId, approvalId);
    expect(result.status).toBe('unknown');
    expect(r.repos.drafts.get(draftId)?.status).toBe('unknown');
    expect(r.notifier.toasts).toHaveLength(1);
    expect(r.notifier.toasts[0]?.level).toBe('critical');
    expect(r.actions(draftId).at(-1)).toBe('publish_unknown');

    // Neither the same approval nor a fresh one can send it again.
    expect(await gateCode(r.publish.publish(draftId, approvalId))).toBe('USED');
    expect(await gateCode(Promise.resolve().then(() => r.gate.request(draftId)))).toBe('DUPLICATE');
    expect(r.devto.publishCalls).toHaveLength(1);
  });

  it('dry_run:linkedin=true makes no route call and returns dry_run', async () => {
    r.repos.settings.set('dry_run:linkedin', 'true');
    const { draftId, approvalId } = await linkedin();
    const result = await r.publish.publish(draftId, approvalId);
    expect(result).toEqual({ status: 'dry_run' });
    expect(r.buffer.publishCalls).toHaveLength(0);
    expect(r.repos.drafts.get(draftId)?.status).toBe('draft');
    expect(r.actions(draftId).at(-1)).toBe('dry_run');
    expect(r.repos.publications.findByHash('linkedin', r.repos.drafts.get(draftId)?.payloadSha256 as string)).toBeUndefined();
  });

  it('a concurrent double publish makes exactly one route call (Review Focus #2)', async () => {
    const { draftId, approvalId } = await stagedDevto();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    r.devto.publishImpl = async (d) => {
      await held;
      return { remoteId: `remote-${d.id}`, costUsd: 0 };
    };

    const first = r.publish.publish(draftId, approvalId);
    const second = r.publish.publish(draftId, approvalId);
    const secondErr = await rejection(second);
    expect(secondErr).toBeInstanceOf(GateError);
    expect(['USED', 'DUPLICATE']).toContain((secondErr as GateError).code);
    release();
    expect((await first).status).toBe('published');
    expect(r.devto.publishCalls).toHaveLength(1);
  });

  it('the MCP path accepts only approve-only approvals', async () => {
    const draft = r.drafts.create({ slug: SLUG, platform: 'devto' });
    await r.drafts.stage(draft.id);
    const approvalId = await r.approve(draft.id, 'publish_now');
    expect(await gateCode(r.publish.publish(draft.id, approvalId))).toBe('WRONG_CHANNEL');
    expect(r.repos.approvals.get(approvalId)?.usedAt).toBeUndefined();
    expect(r.devto.publishCalls).toHaveLength(0);
  });

  it('dev.to without a staged article is refused before the approval is spent', async () => {
    const draft = r.drafts.create({ slug: SLUG, platform: 'devto' });
    const approvalId = await r.approve(draft.id);
    const err = await rejection(r.publish.publish(draft.id, approvalId));
    expect(err).toBeInstanceOf(DraftError);
    expect((err as DraftError).code).toBe('not-staged');
    expect(r.repos.approvals.get(approvalId)?.usedAt).toBeUndefined();
    expect(r.devto.publishCalls).toHaveLength(0);
  });

  it('an assist draft cannot be published, only handed off', async () => {
    r.db.close();
    r = makeRig({ linkedinRoute: 'assist' });
    const draft = r.drafts.create({ slug: SLUG, platform: 'linkedin', payload: { text: goodLinkedinText(r.item) } });
    const approvalId = await r.approve(draft.id);
    expect((await rejection(r.publish.publish(draft.id, approvalId)) as DraftError).code).toBe('assist-route');
    expect(r.repos.approvals.get(approvalId)?.usedAt).toBeUndefined();
  });

  it('a draft whose bytes change after authorize is never sent (re-read hash check)', async () => {
    r.db.close();
    r = makeRig({
      wrapGate: (gate) => ({
        approve: (id, ctx) => gate.approve(id, ctx),
        authorize: async (draftId, approvalId, options) => {
          const v = await gate.authorize(draftId, approvalId, options);
          const d = r.repos.drafts.get(draftId);
          r.repos.drafts.update(draftId, { payload: { ...(d?.payload as object), title: 'tampered' } });
          return v;
        },
      }),
    });
    const { draftId, approvalId } = await stagedDevto();
    const result = await r.publish.publish(draftId, approvalId);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/HASH_MISMATCH/);
    expect(r.devto.publishCalls).toHaveLength(0);
    expect(r.repos.drafts.get(draftId)?.status).toBe('failed');
  });
});

describe('a platform request that times out or comes back unsent', () => {
  it('a dev.to publish that times out is unknown, with one PUT and no retry', async () => {
    const FAKE_KEY = 'not-a-real-key-0123456789abcdef';
    const devto = new FakeDevto(FAKE_KEY);
    const puts: string[] = [];
    r.db.close();
    r = makeRig({
      routes: (repos) => {
        const secrets = new SecretStore(new MemoryKeyStore(), repos);
        secrets.ensureMasterKey();
        secrets.put('devto', 'default', { apiKey: FAKE_KEY });
        const fetchFn: typeof fetch = (input, init) => {
          const body = typeof init?.body === 'string' ? init.body : '';
          if (init?.method === 'PUT' && body.includes('"published":true')) {
            puts.push(body);
            return Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
          }
          return devto.fetchFn(input, init);
        };
        const route = new DevtoRoute({ secrets, fetchFn, now: () => new Date(), markFailed: markFailedIn(repos, () => undefined) });
        return [route, new FakeRoute('linkedin', 'buffer'), new FakeRoute('linkedin', 'assist', { handOff: true })];
      },
    });
    const { draftId, approvalId } = await stagedDevto();
    const result = await r.publish.publish(draftId, approvalId);
    expect(result.status).toBe('unknown');
    expect(result.error).toMatch(/timeout/);
    expect(puts).toHaveLength(1);
    expect(r.repos.drafts.get(draftId)?.status).toBe('unknown');
    expect(r.notifier.toasts.some((t) => t.title === 'Publish result unknown')).toBe(true);
  });

  it('a timeout and a Buffer shareNow that came back as a draft are never clean refusals', () => {
    expect(isCleanRefusal(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))).toBe(false);
    expect(isCleanRefusal(new BufferPublishNotSentError('Buffer saved post p1 as a draft'))).toBe(false);
  });

  it('a Buffer shareNow that came back as a draft leaves the draft unknown, not published', async () => {
    const draft = r.drafts.create({ slug: SLUG, platform: 'linkedin', payload: { text: goodLinkedinText(r.item) } });
    const approvalId = await r.approve(draft.id);
    r.buffer.publishImpl = () => Promise.reject(new BufferPublishNotSentError('Buffer saved post p1 as a draft instead of sending it'));
    const result = await r.publish.publish(draft.id, approvalId);
    expect(result.status).toBe('unknown');
    expect(r.repos.drafts.get(draft.id)?.status).toBe('unknown');
    expect(r.repos.publications.findByHash('linkedin', draft.payloadSha256)).toBeUndefined();
  });
});

describe('markFailedIn (the route markFailed dependency)', () => {
  it.each(['publishing', 'unknown', 'published', 'handed_off', 'pending_approval', 'approved', 'scheduled', 'held', 'source_changed'] as const)('is an audited no-op on a %s draft', (status) => {
    const draft = r.drafts.create({ slug: SLUG, platform: 'devto' });
    r.repos.drafts.update(draft.id, { status });
    markFailedIn(r.repos, r.audit)(draft.id, 'late stage failure');
    expect(r.repos.drafts.get(draft.id)?.status).toBe(status);
    expect(r.repos.drafts.get(draft.id)?.failureReason).toBeUndefined();
    expect(r.actions(draft.id).at(-1)).toBe('mark_failed_ignored');
  });

  it.each(['draft', 'staged', 'failed'] as const)('marks a %s draft failed', (status) => {
    const draft = r.drafts.create({ slug: SLUG, platform: 'devto' });
    r.repos.drafts.update(draft.id, { status });
    markFailedIn(r.repos, r.audit)(draft.id, 'stage refused');
    expect(r.repos.drafts.get(draft.id)).toMatchObject({ status: 'failed', failureReason: 'stage refused' });
  });

  it('marks a draft or staged draft failed, with the redacted reason', () => {
    const draft = r.drafts.create({ slug: SLUG, platform: 'devto' });
    r.repos.drafts.update(draft.id, { status: 'staged' });
    markFailedIn(r.repos, r.audit)(draft.id, 'api-key: not-a-real-key-0123456789abcdef refused');
    expect(r.repos.drafts.get(draft.id)?.status).toBe('failed');
    expect(r.repos.drafts.get(draft.id)?.failureReason).not.toContain('not-a-real-key-0123456789abcdef');
  });
});

describe('PublishService.approveAndPublish', () => {
  it('Hello verified: approve (publish_now) and publish in one request, exactly one route call', async () => {
    const draft = r.drafts.create({ slug: SLUG, platform: 'linkedin', payload: { text: goodLinkedinText(r.item) } });
    const { approvalId } = r.gate.request(draft.id);
    const result = await r.publish.approveAndPublish(approvalId, { checked: r.gate.checklist(draft.id) });
    expect(result.status).toBe('published');
    expect(r.buffer.publishCalls).toHaveLength(1);
    expect(r.repos.approvals.get(approvalId)).toMatchObject({ mode: 'publish_now', channel: 'dashboard_hello' });
    expect(r.presence.prompts).toEqual([`Approve LinkedIn via buffer · #${draft.payloadSha256.slice(0, 8).toUpperCase()} · ${SLUG} · "Prometheus cost follows series count, no…"`]);
  });

  it('Hello canceled: no route call and the approval stays pending', async () => {
    const draft = r.drafts.create({ slug: SLUG, platform: 'linkedin', payload: { text: goodLinkedinText(r.item) } });
    const { approvalId } = r.gate.request(draft.id);
    r.presence.set('canceled');
    expect(await gateCode(r.publish.approveAndPublish(approvalId, { checked: r.gate.checklist(draft.id) }))).toBe('PRESENCE_FAILED');
    expect(r.buffer.publishCalls).toHaveLength(0);
    expect(r.repos.approvals.get(approvalId)?.status).toBe('pending');
  });
});

describe('PublishService.handOff and recordPublication (assist)', () => {
  beforeEach(() => {
    r.db.close();
    r = makeRig({ linkedinRoute: 'assist' });
  });

  it('hand-off goes through authorize, returns the kit, and leaves the draft handed_off', async () => {
    const draft = r.drafts.create({ slug: SLUG, platform: 'linkedin', payload: { text: goodLinkedinText(r.item) } });
    const approvalId = await r.approve(draft.id);
    const kit = await r.publish.handOff(draft.id, approvalId);
    expect(kit.copiedText).toBe(goodLinkedinText(r.item));
    expect(r.assist.handOffCalls).toHaveLength(1);
    expect(r.repos.drafts.get(draft.id)?.status).toBe('handed_off');
    expect(r.repos.approvals.get(approvalId)?.usedAt).toBeDefined();
    expect(await gateCode(r.publish.handOff(draft.id, approvalId))).toBe('USED');
    expect(r.assist.handOffCalls).toHaveLength(1);
  });

  it('hand-off works with the real assist route (clipboard and opener faked)', async () => {
    r.db.close();
    const copied: string[] = [];
    const opened: string[] = [];
    r = makeRig({
      linkedinRoute: 'assist',
      routes: () => [
        new AssistLinkedinRoute({
          clipboard: { write: (text) => (copied.push(text), Promise.resolve()) },
          opener: (url) => (opened.push(url), Promise.resolve()),
        }),
      ],
    });
    const draft = r.drafts.create({ slug: SLUG, platform: 'linkedin', payload: { text: goodLinkedinText(r.item) } });
    const approvalId = await r.approve(draft.id);
    const kit = await r.publish.handOff(draft.id, approvalId);
    expect(copied).toEqual([goodLinkedinText(r.item)]);
    expect(opened).toEqual([LINKEDIN_FEED_URL]);
    expect(kit.openUrl).toBe(LINKEDIN_FEED_URL);
    expect(r.repos.drafts.get(draft.id)?.status).toBe('handed_off');
  });

  it('the MCP hand-off spends only an approve-only approval; approveAndHandOff is the publish_now path', async () => {
    const draft = r.drafts.create({ slug: SLUG, platform: 'linkedin', payload: { text: goodLinkedinText(r.item) } });
    const approvalId = await r.approve(draft.id, 'publish_now');
    expect(await gateCode(r.publish.handOff(draft.id, approvalId))).toBe('WRONG_CHANNEL');
    expect(r.assist.handOffCalls).toHaveLength(0);

    const other = r.drafts.create({ slug: SLUG, platform: 'linkedin', payload: { text: goodLinkedinText(r.item) } });
    const { approvalId: pending } = r.gate.request(other.id);
    await r.publish.approveAndHandOff(pending, { checked: r.gate.checklist(other.id) });
    expect(r.assist.handOffCalls).toHaveLength(1);
    expect(r.repos.drafts.get(other.id)?.status).toBe('handed_off');
  });

  it('hand-off without an approval never reaches the route', async () => {
    const draft = r.drafts.create({ slug: SLUG, platform: 'linkedin', payload: { text: goodLinkedinText(r.item) } });
    expect(await gateCode(r.publish.handOff(draft.id, 'no-such-approval'))).toBe('NO_APPROVAL');
    expect(r.assist.handOffCalls).toHaveLength(0);
  });

  it('recordPublication validates the URL, writes the publication and marks the draft published', async () => {
    const draft = r.drafts.create({ slug: SLUG, platform: 'linkedin', payload: { text: goodLinkedinText(r.item) } });
    const approvalId = await r.approve(draft.id);
    await r.publish.handOff(draft.id, approvalId);

    expect(() => r.publish.recordPublication(draft.id, 'http://evil.test/post')).toThrow();
    expect(r.repos.drafts.get(draft.id)?.status).toBe('handed_off');

    r.publish.recordPublication(draft.id, 'https://www.linkedin.com/feed/update/urn:li:activity:1/');
    expect(r.repos.drafts.get(draft.id)?.status).toBe('published');
    const pub = r.repos.publications.findByHash('linkedin', draft.payloadSha256);
    expect(pub?.remoteUrl).toBe('https://www.linkedin.com/feed/update/urn:li:activity:1/');
    expect(r.actions(draft.id).at(-1)).toBe('publication_recorded');
    // Only once.
    expect(() => r.publish.recordPublication(draft.id, 'https://www.linkedin.com/feed/update/urn:li:activity:1/')).toThrow(DraftError);
  });

  it('recordPublication refuses a draft that was never handed off', () => {
    const draft = r.drafts.create({ slug: SLUG, platform: 'linkedin', payload: { text: goodLinkedinText(r.item) } });
    expect(() => r.publish.recordPublication(draft.id, 'https://www.linkedin.com/feed/update/urn:li:activity:1/')).toThrow(DraftError);
  });
});
