import { createDevtoTransform, payloadHash, type DevtoPayload, type LinkedinPayload } from '@cph/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GateError } from '../src/gate/errors.js';
import { DraftError } from '../src/services/drafts.js';
import { markFailedIn } from '../src/services/publish.js';
import { goodLinkedinText, makeRig, SLUG, type Rig } from './helpers/service-rig.js';

let r: Rig;

beforeEach(() => {
  r = makeRig();
});

afterEach(() => {
  r.db.close();
});

/** Runs `fn` and returns the DraftError it threw (failing if it threw anything else). */
async function draftError(fn: () => unknown): Promise<DraftError> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(DraftError);
  return caught as DraftError;
}

async function gateCode(fn: () => unknown): Promise<string> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(GateError);
  return (caught as GateError).code;
}

const skeleton = (): DevtoPayload => createDevtoTransform().skeleton(r.item);

describe('DraftsService.create (dev.to)', () => {
  it('omitting the payload gives the transform skeleton, reformatted, direct, hashed, lint clean', () => {
    const view = r.drafts.create({ slug: SLUG, platform: 'devto' });
    expect(view.payload).toEqual(skeleton());
    expect(view).toMatchObject({ slug: SLUG, platform: 'devto', account: 'default', route: 'direct', status: 'draft', authorship: 'reformatted', lint: [] });
    expect(view.payloadSha256).toBe(
      payloadHash({ platform: 'devto', account: 'default', route: 'direct', payload: skeleton(), mediaSha256: [], scheduledAt: null }),
    );
    expect(r.repos.drafts.get(view.id)?.payloadSha256).toBe(view.payloadSha256);
    expect(r.actions(view.id)).toEqual(['draft_created']);
  });

  it('a modified body_markdown is refused: full-text-immutable (Claude cannot rewrite the article)', async () => {
    const body_markdown = `${skeleton().body_markdown}\nOne more line Claude added.`;
    const err = await draftError(() => r.drafts.create({ slug: SLUG, platform: 'devto', payload: { body_markdown } }));
    expect(err.code).toBe('full-text-immutable');
    expect(r.repos.drafts.list()).toEqual([]);
  });

  it('merges a supplied payload over the skeleton and forces authorship reformatted', () => {
    const view = r.drafts.create({
      slug: SLUG,
      platform: 'devto',
      payload: { title: 'A sharper title', body_markdown: skeleton().body_markdown },
      authorship: 'ai-assisted',
    });
    expect(view.payload).toEqual({ ...skeleton(), title: 'A sharper title' });
    expect(view.authorship).toBe('reformatted');
  });

  it('refuses unknown keys and a live flag in the payload', async () => {
    expect((await draftError(() => r.drafts.create({ slug: SLUG, platform: 'devto', payload: { surprise: 1 } }))).code).toBe('invalid-payload');
    const live = JSON.parse('{"published": true}') as unknown;
    expect((await draftError(() => r.drafts.create({ slug: SLUG, platform: 'devto', payload: live }))).code).toBe('invalid-payload');
  });

  it('a 3-month-old post gets a notBefore in the past: T0 from the frontmatter date + 48 h, not install day', () => {
    const view = r.drafts.create({ slug: SLUG, platform: 'devto' });
    // Frontmatter date 2026-07-19, first seen live on install day 2026-10-19.
    expect(view.notBefore).toBe('2026-07-21T00:00:00.000Z');
    expect(Date.parse(view.notBefore as string)).toBeLessThan(r.clock.now.getTime());
  });

  it('refuses a dev.to draft while T0 is unknown (canonical not seen live yet)', async () => {
    r.db.close();
    r = makeRig({ live: false });
    expect((await draftError(() => r.drafts.create({ slug: SLUG, platform: 'devto' }))).code).toBe('canonical-not-live');
  });

  it('refuses with sync-first when the post on disk is newer than the synced content row', async () => {
    r.repos.content.upsert({ ...(r.repos.content.get(SLUG) as NonNullable<ReturnType<typeof r.repos.content.get>>), mdxSha256: 'e'.repeat(64) });
    const err = await draftError(() => r.drafts.create({ slug: SLUG, platform: 'devto' }));
    expect(err.code).toBe('sync-first');
    expect((await draftError(() => r.drafts.create({ slug: SLUG, platform: 'linkedin', payload: { text: goodLinkedinText(r.item) } }))).code).toBe('sync-first');
    expect(r.repos.drafts.list()).toEqual([]);
  });

  it('records the source the draft was built from (the content row hashes)', () => {
    const view = r.drafts.create({ slug: SLUG, platform: 'devto' });
    expect(r.repos.drafts.get(view.id)).toMatchObject({ sourceMdxSha256: r.item.source.mdxSha256, sourceNotesSha256: r.item.source.notesSha256 });
  });

  it('refuses an unknown post and an unsupported platform', async () => {
    expect((await draftError(() => r.drafts.create({ slug: 'no-such-post', platform: 'devto' }))).code).toBe('unknown-post');
    const platform = 'x' as 'devto';
    expect((await draftError(() => r.drafts.create({ slug: SLUG, platform }))).code).toBe('unsupported-platform');
  });
});

describe('DraftsService.create (LinkedIn)', () => {
  it('uses the configured route and marks rewritten text ai-assisted', () => {
    const text = goodLinkedinText(r.item);
    const view = r.drafts.create({ slug: SLUG, platform: 'linkedin', payload: { text } });
    expect(view).toMatchObject({ route: 'buffer', authorship: 'ai-assisted', lint: [] });
    expect(view.payload).toEqual({ text });
    expect(view.notBefore).toBeUndefined();
  });

  it('rewritten text is always ai-assisted, whatever authorship the caller claims (ruling 8)', () => {
    const text = goodLinkedinText(r.item);
    for (const authorship of ['verbatim', 'reformatted'] as const) {
      expect(r.drafts.create({ slug: SLUG, platform: 'linkedin', payload: { text }, authorship }).authorship).toBe('ai-assisted');
    }
  });

  it('the skeleton text keeps the given authorship (default reformatted); the assist route is used when configured', () => {
    r.db.close();
    r = makeRig({ linkedinRoute: 'assist' });
    const view = r.drafts.create({ slug: SLUG, platform: 'linkedin' });
    expect(view).toMatchObject({ route: 'assist', authorship: 'reformatted' });
    // The skeleton is too short for a takeaway: lint says so, and the gate will refuse it.
    expect(view.lint.map((l) => l.rule)).toContain('li-takeaway');
  });

  it('zod-validates the payload: link null and unknown keys are refused', async () => {
    const text = goodLinkedinText(r.item);
    const nullLink = JSON.parse(`{"text": ${JSON.stringify(text)}, "link": null}`) as unknown;
    expect((await draftError(() => r.drafts.create({ slug: SLUG, platform: 'linkedin', payload: nullLink }))).code).toBe('invalid-payload');
    expect((await draftError(() => r.drafts.create({ slug: SLUG, platform: 'linkedin', payload: { text, image: 'x' } }))).code).toBe(
      'invalid-payload',
    );
  });

  it('lint runs with the configured linkCard: a card is an error while linkCard is off', () => {
    const text = goodLinkedinText(r.item);
    const link = { url: 'https://x.test', title: 't', description: 'd', thumbnailUrl: 'https://x.test/c.png' };
    const view = r.drafts.create({ slug: SLUG, platform: 'linkedin', payload: { text, link } });
    expect(view.lint.map((l) => l.rule)).toContain('li-link-card-disabled');
  });
});

describe('DraftsService.update', () => {
  it('after approval: the approval is invalidated (draft_edited), and publish then refuses HASH_MISMATCH', async () => {
    const draft = r.drafts.create({ slug: SLUG, platform: 'devto' });
    await r.drafts.stage(draft.id);
    const approvalId = await r.approve(draft.id);

    const edited = await r.drafts.update(draft.id, { title: 'Edited after approval' });
    expect(edited.payloadSha256).not.toBe(draft.payloadSha256);
    expect((edited.payload as DevtoPayload).title).toBe('Edited after approval');
    expect(r.repos.approvals.get(approvalId)?.status).toBe('invalidated');
    expect(r.actions(draft.id)).toContain('draft_edited');

    let caught: unknown;
    try {
      await r.publish.publish(draft.id, approvalId);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GateError);
    expect((caught as GateError).code).toBe('HASH_MISMATCH');
    expect(r.devto.publishCalls).toHaveLength(0);
  });

  it('recomputes hash and lint, and keeps body_markdown immutable', async () => {
    const draft = r.drafts.create({ slug: SLUG, platform: 'devto' });
    const edited = await r.drafts.update(draft.id, { tags: ['prometheus'] });
    const stored = r.repos.drafts.get(draft.id);
    expect(stored?.payloadSha256).toBe(edited.payloadSha256);
    expect(edited.payloadSha256).toBe(
      payloadHash({ platform: 'devto', account: 'default', route: 'direct', payload: edited.payload, mediaSha256: [], scheduledAt: null }),
    );
    const err = await draftError(() => r.drafts.update(draft.id, { body_markdown: 'rewritten' }));
    expect(err.code).toBe('full-text-immutable');
  });

  it('LinkedIn text edits recompute authorship and lint', async () => {
    const draft = r.drafts.create({ slug: SLUG, platform: 'linkedin' });
    expect(draft.lint.length).toBeGreaterThan(0);
    const edited = await r.drafts.update(draft.id, { text: goodLinkedinText(r.item) });
    expect(edited).toMatchObject({ authorship: 'ai-assisted', lint: [] });
    expect((edited.payload as LinkedinPayload).text).toBe(goodLinkedinText(r.item));
  });

  it.each(['publishing', 'unknown', 'published', 'handed_off'] as const)('refuses edits while the draft is %s', async (status) => {
    const draft = r.drafts.create({ slug: SLUG, platform: 'devto' });
    r.repos.drafts.update(draft.id, { status });
    const err = await draftError(() => r.drafts.update(draft.id, { title: 'nope' }));
    expect(err.code).toBe('not-editable');
    expect(r.repos.drafts.get(draft.id)?.payloadSha256).toBe(draft.payloadSha256);
  });

  it('a draft held by a platform scheduler is cancelled remotely after the local edit', async () => {
    const draft = r.drafts.create({ slug: SLUG, platform: 'linkedin', payload: { text: goodLinkedinText(r.item) } });
    r.repos.drafts.update(draft.id, { remoteScheduledId: 'buffer-post-9', status: 'scheduled' });
    const edited = await r.drafts.update(draft.id, { text: `${goodLinkedinText(r.item)} ` });
    expect(r.buffer.cancelCalls).toHaveLength(1);
    expect(r.buffer.cancelCalls[0]?.remoteScheduledId).toBe('buffer-post-9');
    expect(edited.remoteScheduledId).toBeUndefined();
    expect(edited.status).toBe('draft');
    expect(r.actions(draft.id)).toEqual(expect.arrayContaining(['draft_edited', 'remote_cancelled']));
    // The hold is gone: the edited draft can be approved again.
    expect(r.gate.request(draft.id).status).toBe('pending');
  });

  it('a failed remote cancel keeps the id, audits it and raises a critical toast', async () => {
    const draft = r.drafts.create({ slug: SLUG, platform: 'linkedin', payload: { text: goodLinkedinText(r.item) } });
    r.repos.drafts.update(draft.id, { remoteScheduledId: 'buffer-post-9', status: 'scheduled' });
    r.buffer.cancelImpl = () => Promise.reject(new Error('Buffer said 500'));
    const edited = await r.drafts.update(draft.id, { text: `${goodLinkedinText(r.item)} ` });
    expect(edited.remoteScheduledId).toBe('buffer-post-9');
    expect(r.actions(draft.id)).toContain('remote_cancel_failed');
    expect(r.notifier.toasts.map((t) => t.level)).toContain('critical');

    // While the old post is still scheduled on the platform, the draft cannot be approved again.
    expect(await gateCode(() => r.gate.request(draft.id))).toBe('REMOTE_SCHEDULED');
    // the owner deletes it by hand and confirms: the hold clears, audited.
    expect(r.drafts.confirmRemoteCancelled(draft.id).remoteScheduledId).toBeUndefined();
    expect(r.actions(draft.id).at(-1)).toBe('remote_cancel_confirmed');
    expect(r.gate.request(draft.id).status).toBe('pending');
    expect((await draftError(() => r.drafts.confirmRemoteCancelled(draft.id))).code).toBe('no-remote-schedule');
  });

  it('a remote schedule set after approval blocks approve and authorize too (REMOTE_SCHEDULED)', async () => {
    const draft = r.drafts.create({ slug: SLUG, platform: 'linkedin', payload: { text: goodLinkedinText(r.item) } });
    const { approvalId: pending } = r.gate.request(draft.id);
    const approved = await r.approve(draft.id);
    r.repos.drafts.update(draft.id, { remoteScheduledId: 'buffer-post-9' });
    const checked = r.gate.checklist(draft.id);
    expect(await gateCode(() => r.gate.approve(pending, { channel: 'dashboard_hello', checked, mode: 'approve_only' }))).toBe('REMOTE_SCHEDULED');
    expect(await gateCode(() => r.gate.authorize(draft.id, approved, { allowModes: ['approve_only'] }))).toBe('REMOTE_SCHEDULED');
    expect(r.repos.approvals.get(approved)?.usedAt).toBeUndefined();
  });
});

describe('DraftsService.stage, get, list, preview', () => {
  it('stage calls the route once, stores the remote ref and audits staged', async () => {
    const draft = r.drafts.create({ slug: SLUG, platform: 'devto' });
    const ref = await r.drafts.stage(draft.id);
    expect(ref.remoteId).toBe('101');
    expect(r.devto.stageCalls).toHaveLength(1);
    expect(r.drafts.get(draft.id)).toMatchObject({ status: 'staged', remoteRef: '101' });
    expect(r.actions(draft.id)).toEqual(['draft_created', 'staged']);
  });

  it.each(['publishing', 'unknown', 'published', 'handed_off', 'failed'] as const)('stage refuses a %s draft without calling the route', async (status) => {
    const draft = r.drafts.create({ slug: SLUG, platform: 'devto' });
    r.repos.drafts.update(draft.id, { status });
    expect((await draftError(() => r.drafts.stage(draft.id))).code).toBe('not-stageable');
    expect(r.devto.stageCalls).toHaveLength(0);
    expect(r.repos.drafts.get(draft.id)?.status).toBe(status);
  });

  it('a stage whose route call returns after a concurrent authorize does not flip the draft', async () => {
    const draft = r.drafts.create({ slug: SLUG, platform: 'devto' });
    await r.drafts.stage(draft.id);
    const approvalId = await r.approve(draft.id);
    const markFailed = markFailedIn(r.repos, r.audit);
    r.devto.stageImpl = async () => {
      // The publish is authorized while the re-stage is on the wire, then the route reports a failure.
      await r.gate.authorize(draft.id, approvalId, { allowModes: ['approve_only'] });
      markFailed(draft.id, 'Buffer did not save this as a draft');
      return { remoteId: '202' };
    };
    expect((await draftError(() => r.drafts.stage(draft.id))).code).toBe('not-stageable');
    expect(r.repos.drafts.get(draft.id)).toMatchObject({ status: 'publishing', remoteRef: '101' });
    expect(r.actions(draft.id)).toEqual(expect.arrayContaining(['authorize_ok', 'mark_failed_ignored', 'stage_discarded']));
  });

  it('stage refuses a route without a private stage', async () => {
    r.db.close();
    r = makeRig({ linkedinRoute: 'assist' });
    const draft = r.drafts.create({ slug: SLUG, platform: 'linkedin' });
    expect((await draftError(() => r.drafts.stage(draft.id))).code).toBe('no-stage');
  });

  it('a stage error is audited (redacted) and rethrown', async () => {
    const draft = r.drafts.create({ slug: SLUG, platform: 'devto' });
    r.devto.stageImpl = () => Promise.reject(new Error('api-key: not-a-real-key-0123456789abcdef rejected'));
    await expect(r.drafts.stage(draft.id)).rejects.toThrow(/rejected/);
    const [row] = r.repos.audit.list({ draftId: draft.id, limit: 1 });
    expect(row?.action).toBe('stage_failed');
    expect(JSON.stringify(row?.detail)).not.toContain('not-a-real-key-0123456789abcdef');
  });

  it('get, list and preview', () => {
    const a = r.drafts.create({ slug: SLUG, platform: 'devto' });
    const b = r.drafts.create({ slug: SLUG, platform: 'linkedin' });
    expect(r.drafts.get(a.id)).toEqual(a);
    expect(r.drafts.list().map((d) => d.id)).toEqual([a.id, b.id]);
    expect(r.drafts.list({ platform: 'linkedin' }).map((d) => d.id)).toEqual([b.id]);
    const preview = r.drafts.preview(SLUG, 'devto');
    expect(preview).toEqual({ payload: skeleton(), lint: [] });
    expect(() => r.drafts.get('missing')).toThrow(DraftError);
  });
});
