import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildContentItem,
  DEFAULT_BASE_URL,
  devtoTransform,
  payloadHash,
  type ContentItem,
  type DevtoPayload,
  type PlatformId,
} from '@cph/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.js';
import { createRepos, type NewDraft, type Repos } from '../src/db/repos.js';
import { GateError, type GateCode } from '../src/gate/errors.js';
import { ApprovalGate, APPROVAL_INSTRUCTIONS, approvalPrompt, approvalTag, approveUrlFor, payloadPreview, READ_PAYLOAD_ITEM } from '../src/gate/approval-gate.js';
import { isVerifiedApproval } from '../src/gate/verified.js';
import type { GitRunner } from '../src/site/git.js';
import { SiteReader } from '../src/site/site-reader.js';
import { syncContent } from '../src/sync.js';
import { WindowsHelloPresence } from '../src/gate/presence.js';
import { FakePresence } from './helpers/fake-presence.js';

const FIXTURES = fileURLToPath(new URL('../../core/test/fixtures/', import.meta.url));
const SLUG = 'prometheus-cardinality-explained';
const LIVE = '2026-10-19T08:00:00.000Z';
const START = '2026-10-19T10:00:00.000Z';
const MIN = 60_000;
const HOUR = 60 * MIN;

let db: Db;
let repos: Repos;
let clock: Date;
let presence: FakePresence;
let healthy: boolean | Error;
let healthCalls: { platform: PlatformId; account: string }[];
let item: ContentItem;
let gate: ApprovalGate;

const at = (offsetMs: number, from = START): Date => new Date(Date.parse(from) + offsetMs);

function loadItem(mdxEdit = (s: string): string => s): ContentItem {
  return buildContentItem({
    slug: SLUG,
    mdxRaw: mdxEdit(readFileSync(`${FIXTURES}sample-post.mdx`, 'utf8')),
    notesRaw: readFileSync(`${FIXTURES}sample-notes.md`, 'utf8'),
    repoCommit: 'abc1234',
    dirty: false,
    baseUrl: DEFAULT_BASE_URL,
  });
}

function seedContent(overrides: { canonicalLiveAt?: string | null; published?: boolean } = {}): void {
  const liveAt = overrides.canonicalLiveAt === undefined ? LIVE : overrides.canonicalLiveAt;
  repos.content.upsert({
    slug: SLUG,
    canonicalUrl: item.canonicalUrl,
    title: item.frontmatter.title,
    date: item.frontmatter.date,
    mdxSha256: item.source.mdxSha256,
    ...(item.source.notesSha256 === undefined ? {} : { notesSha256: item.source.notesSha256 }),
    repoCommit: 'abc1234',
    dirty: false,
    published: overrides.published ?? true,
    ...(liveAt === null ? {} : { canonicalLiveAt: liveAt, t0: liveAt }),
  });
}

function hashOf(payload: unknown, scheduledAt: string | null = null): string {
  return payloadHash({ platform: 'devto', account: 'default', route: 'direct', payload, mediaSha256: [], scheduledAt });
}

function devtoPayload(edit: (p: DevtoPayload) => DevtoPayload = (p) => p): DevtoPayload {
  return edit(devtoTransform.skeleton(item));
}

function insertDraft(overrides: Partial<NewDraft<DevtoPayload>> = {}): string {
  const payload = overrides.payload ?? devtoPayload();
  const draft: NewDraft<DevtoPayload> = {
    id: 'd1',
    slug: SLUG,
    platform: 'devto',
    account: 'default',
    route: 'direct',
    kind: 'article',
    status: 'draft',
    payload,
    payloadSha256: hashOf(payload, overrides.scheduledAt ?? null),
    authorship: 'reformatted',
    lint: [],
    // Built from the post the content row records (DraftsService.create stores these).
    sourceMdxSha256: item.source.mdxSha256,
    ...(item.source.notesSha256 === undefined ? {} : { sourceNotesSha256: item.source.notesSha256 }),
    ...overrides,
  };
  repos.drafts.insert(draft);
  return draft.id;
}

function newGate(): ApprovalGate {
  return new ApprovalGate({
    repos,
    now: () => clock,
    health: (platform, account) => {
      healthCalls.push({ platform, account });
      return healthy instanceof Error ? Promise.reject(healthy) : Promise.resolve(healthy);
    },
    presence,
    loadContentItem: (slug) => (slug === SLUG ? item : undefined),
  });
}

/** Request and approve (all boxes ticked, presence verified). Returns the approval id. */
async function approved(draftId = 'd1', mode: 'publish_now' | 'approve_only' | 'schedule' = 'publish_now'): Promise<string> {
  const { approvalId } = gate.request(draftId);
  await gate.approve(approvalId, { channel: 'dashboard_hello', checked: gate.checklist(draftId), mode });
  return approvalId;
}

/** The refusal carries `code`, and the newest audit row records that same code. */
async function expectRefusal(action: Promise<unknown> | (() => unknown), code: GateCode): Promise<GateError> {
  let caught: unknown;
  try {
    if (typeof action === 'function') action();
    else await action;
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected GateError ${code}`).toBeInstanceOf(GateError);
  const err = caught as GateError;
  expect(err.code).toBe(code);
  const [latest] = repos.audit.list({ limit: 1 });
  expect(latest?.action).toMatch(/_refused$/);
  expect(latest?.detail).toMatchObject({ code });
  return err;
}

beforeEach(() => {
  db = openDb(':memory:');
  clock = new Date(START);
  repos = createRepos(db, { now: () => clock.toISOString() });
  repos.settings.set('publishing_enabled', 'true');
  presence = new FakePresence('verified');
  healthy = true;
  healthCalls = [];
  item = loadItem();
  seedContent();
  insertDraft();
  gate = newGate();
});

afterEach(() => {
  db.close();
});

describe('fixture sanity', () => {
  it('the dev.to skeleton of the sample post is lint-clean, so every refusal below has one cause', () => {
    const errors = devtoTransform.lint(devtoPayload(), item).filter((r) => r.severity === 'error');
    expect(errors).toEqual([]);
  });

  it('a fully approved draft authorizes, mints a VerifiedApproval and marks the draft publishing', async () => {
    const approvalId = await approved();
    const v = await gate.authorize('d1', approvalId);
    expect(v).toMatchObject({ approvalId, draftId: 'd1', payloadSha256: hashOf(devtoPayload()), mode: 'publish_now', scheduledAt: null });
    expect(isVerifiedApproval(v)).toBe(true);
    expect(repos.approvals.get(approvalId)?.usedAt).toBe(START);
    expect(repos.drafts.get('d1')?.status).toBe('publishing');
    expect(healthCalls).toEqual([{ platform: 'devto', account: 'default' }]);
    const [latest] = repos.audit.list({ limit: 1 });
    expect(latest).toMatchObject({ action: 'authorize_ok', draftId: 'd1', approvalId, hash: hashOf(devtoPayload()) });
  });

  it('a hand-built object with the right fields is not a VerifiedApproval', () => {
    expect(isVerifiedApproval({ approvalId: 'a', draftId: 'd1', payloadSha256: 'f'.repeat(64) })).toBe(false);
  });
});

describe('the gate table (T0.13 Step 1)', () => {
  it('authorize without approval: NO_APPROVAL', async () => {
    await expectRefusal(gate.authorize('d1', 'no-such-approval'), 'NO_APPROVAL');
  });

  it('pending, not approved: NOT_APPROVED', async () => {
    const { approvalId } = gate.request('d1');
    await expectRefusal(gate.authorize('d1', approvalId), 'NOT_APPROVED');
    expect(repos.approvals.get(approvalId)?.usedAt).toBeUndefined();
  });

  it('approved, now + 31 min: EXPIRED', async () => {
    const approvalId = await approved();
    clock = at(31 * MIN);
    await expectRefusal(gate.authorize('d1', approvalId), 'EXPIRED');
    expect(repos.approvals.get(approvalId)?.usedAt).toBeUndefined();
    expect(repos.drafts.get('d1')?.status).toBe('draft');
  });

  it('approved, then drafts.update changes text: HASH_MISMATCH', async () => {
    const approvalId = await approved();
    const edited = devtoPayload((p) => ({ ...p, body_markdown: `${p.body_markdown}\n\nOne more line.` }));
    repos.drafts.update('d1', { payload: edited, payloadSha256: hashOf(edited) });
    await expectRefusal(gate.authorize('d1', approvalId), 'HASH_MISMATCH');
    expect(repos.approvals.get(approvalId)?.usedAt).toBeUndefined();
  });

  it('approved, column hash forged to match but payload changed: HASH_MISMATCH (recomputed)', async () => {
    const approvalId = await approved();
    const edited = devtoPayload((p) => ({ ...p, title: `${p.title} (edited)` }));
    // payload_sha256 still holds the approved hash: only recomputing from the payload can see the edit.
    repos.drafts.update('d1', { payload: edited });
    expect(repos.drafts.get('d1')?.payloadSha256).toBe(repos.approvals.get(approvalId)?.payloadSha256);
    await expectRefusal(gate.authorize('d1', approvalId), 'HASH_MISMATCH');
    expect(repos.approvals.get(approvalId)?.usedAt).toBeUndefined();
  });

  it('authorize twice: second USED', async () => {
    const approvalId = await approved();
    await gate.authorize('d1', approvalId);
    await expectRefusal(gate.authorize('d1', approvalId), 'USED');
  });

  it('spending one approval invalidates the draft\'s other pending and approved approvals: no second spend without a new Hello', async () => {
    const first = await approved();
    const spare = await approved();
    const { approvalId: pending } = gate.request('d1');
    await gate.authorize('d1', first);
    expect(repos.approvals.get(spare)?.status).toBe('invalidated');
    expect(repos.approvals.get(pending)?.status).toBe('invalidated');

    // The attempt failed cleanly (nothing went out): the draft is 'failed' and could be approved again.
    repos.drafts.update('d1', { status: 'failed' });
    const err = await expectRefusal(gate.authorize('d1', spare), 'NOT_APPROVED');
    expect(err.message).toMatch(/another approval for this draft was used/);
    expect(repos.approvals.get(spare)?.usedAt).toBeUndefined();
    await expectRefusal(gate.approve(pending, { channel: 'dashboard_hello', checked: gate.checklist('d1'), mode: 'approve_only' }), 'NOT_APPROVED');

    // A new request and a new Hello work.
    const fresh = await approved();
    await expect(gate.authorize('d1', fresh)).resolves.toMatchObject({ approvalId: fresh });
  });

  it('Promise.all of two authorizes: exactly one resolves', async () => {
    const approvalId = await approved();
    const results = await Promise.allSettled([gate.authorize('d1', approvalId), gate.authorize('d1', approvalId)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(GateError);
    expect((rejected[0]?.reason as GateError).code).toBe('USED');
    expect(repos.audit.list().filter((e) => e.action === 'authorize_ok')).toHaveLength(1);
  });

  it('publishing_enabled=false: PUBLISHING_DISABLED, even with a valid approval', async () => {
    const approvalId = await approved();
    repos.settings.set('publishing_enabled', 'false');
    await expectRefusal(gate.authorize('d1', approvalId), 'PUBLISHING_DISABLED');
    expect(repos.approvals.get(approvalId)?.usedAt).toBeUndefined();
    // Anything other than the exact string 'true' is disabled.
    repos.settings.set('publishing_enabled', 'TRUE');
    await expectRefusal(gate.authorize('d1', approvalId), 'PUBLISHING_DISABLED');
  });

  it('approve with one verify box missing: CHECKLIST_INCOMPLETE', async () => {
    const { approvalId } = gate.request('d1');
    const checklist = gate.checklist('d1');
    await expectRefusal(
      gate.approve(approvalId, { channel: 'dashboard_hello', checked: checklist.slice(0, -1), mode: 'publish_now' }),
      'CHECKLIST_INCOMPLETE',
    );
    expect(presence.prompts).toEqual([]);
    expect(repos.approvals.get(approvalId)?.status).toBe('pending');
  });

  it.each(['canceled', 'unavailable', 'error'] as const)(
    'approve with a fake presence returning %s: PRESENCE_FAILED; stays pending; no presence_verified_at',
    async (answer) => {
      presence.set(answer);
      const { approvalId } = gate.request('d1');
      await expectRefusal(
        gate.approve(approvalId, { channel: 'dashboard_hello', checked: gate.checklist('d1'), mode: 'publish_now' }),
        'PRESENCE_FAILED',
      );
      const row = repos.approvals.get(approvalId);
      expect(row?.status).toBe('pending');
      expect(row?.presenceVerifiedAt).toBeUndefined();
      expect(row?.decidedAt).toBeUndefined();
    },
  );

  it('approve with a presence check that throws: PRESENCE_FAILED; stays pending', async () => {
    presence.set(new Error('powershell.exe exited 1'));
    const { approvalId } = gate.request('d1');
    await expectRefusal(
      gate.approve(approvalId, { channel: 'dashboard_hello', checked: gate.checklist('d1'), mode: 'publish_now' }),
      'PRESENCE_FAILED',
    );
    expect(repos.approvals.get(approvalId)).toMatchObject({ status: 'pending' });
    expect(repos.approvals.get(approvalId)?.presenceVerifiedAt).toBeUndefined();
  });

  it('approval row forced to approved without presence_verified_at (simulated DB tamper): PRESENCE_FAILED at authorize', async () => {
    const { approvalId } = gate.request('d1');
    repos.approvals.setStatus(approvalId, 'approved');
    await expectRefusal(gate.authorize('d1', approvalId), 'PRESENCE_FAILED');
    expect(repos.approvals.get(approvalId)?.usedAt).toBeUndefined();
  });

  it('approve with all boxes ticked and presence verified: approved, channel dashboard_hello, presence_verified_at set', async () => {
    const { approvalId } = gate.request('d1');
    clock = at(2 * MIN);
    await gate.approve(approvalId, { channel: 'dashboard_hello', checked: gate.checklist('d1'), mode: 'publish_now' });
    expect(repos.approvals.get(approvalId)).toMatchObject({
      status: 'approved',
      channel: 'dashboard_hello',
      mode: 'publish_now',
      presenceVerifiedAt: at(2 * MIN).toISOString(),
      decidedAt: at(2 * MIN).toISOString(),
    });
    const d1 = repos.drafts.get('d1');
    const title = (d1?.payload as { title: string }).title;
    const tag = `#${(d1?.payloadSha256 as string).slice(0, 8).toUpperCase()}`;
    expect(presence.prompts).toEqual([`Approve dev.to via direct · ${tag} · ${SLUG} · "${[...title].slice(0, 40).join('')}…"`]);
    expect(repos.audit.list({ limit: 1 })[0]).toMatchObject({ action: 'approved', approvalId, actorChannel: 'dashboard_hello' });
  });

  it('request when lint has errors: LINT_ERRORS', async () => {
    const bad = devtoPayload((p) => ({ ...p, canonical_url: `${p.canonical_url}?utm_source=devto` }));
    insertDraft({ id: 'd2', payload: bad });
    const err = await expectRefusal(() => gate.request('d2'), 'LINT_ERRORS');
    expect(err.detail).toMatchObject({ rules: ['canonical-url'] });
    expect(repos.approvals.listByDraft('d2')).toEqual([]);
  });

  it('request when canonical not live: CANONICAL_NOT_LIVE', async () => {
    seedContent({ canonicalLiveAt: null });
    await expectRefusal(() => gate.request('d1'), 'CANONICAL_NOT_LIVE');
    seedContent({ published: false });
    await expectRefusal(() => gate.request('d1'), 'CANONICAL_NOT_LIVE');
    expect(repos.approvals.listByDraft('d1')).toEqual([]);
  });

  it('source changed after approval: SOURCE_CHANGED', async () => {
    const approvalId = await approved();
    // Exactly what sync.ts does when the MDX or notes change: flag the draft, invalidate its approvals.
    repos.transaction(() => {
      repos.drafts.update('d1', { status: 'source_changed' });
      repos.approvals.setStatus(approvalId, 'invalidated');
    });
    await expectRefusal(gate.authorize('d1', approvalId), 'SOURCE_CHANGED');
    expect(repos.approvals.get(approvalId)?.usedAt).toBeUndefined();
  });

  it('dev.to draft with not_before = live + 48 h, now = live + 1 h: NOT_BEFORE', async () => {
    insertDraft({ id: 'd2', notBefore: at(48 * HOUR, LIVE).toISOString() });
    clock = at(1 * HOUR, LIVE);
    const approvalId = await approved('d2');
    await expectRefusal(gate.authorize('d2', approvalId), 'NOT_BEFORE');
    expect(repos.approvals.get(approvalId)?.usedAt).toBeUndefined();
  });

  it('publication already exists for hash+platform: DUPLICATE', async () => {
    const approvalId = await approved();
    repos.publications.insert({
      id: 'p1',
      draftId: 'd1',
      platform: 'devto',
      account: 'default',
      payloadSha256: hashOf(devtoPayload()),
      publishedAt: LIVE,
      costUsd: 0,
    });
    await expectRefusal(gate.authorize('d1', approvalId), 'DUPLICATE');
    expect(repos.approvals.get(approvalId)?.usedAt).toBeUndefined();
  });

  it('health false: UNHEALTHY', async () => {
    const approvalId = await approved();
    healthy = false;
    await expectRefusal(gate.authorize('d1', approvalId), 'UNHEALTHY');
    expect(repos.approvals.get(approvalId)?.usedAt).toBeUndefined();
    expect(repos.drafts.get('d1')?.status).toBe('draft');
  });

  it("request() result serialized: no field that, if passed back, authorizes anything", () => {
    const result = gate.request('d1');
    const serialized = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
    expect(Object.keys(serialized)).toEqual(['approvalId', 'status', 'approveUrl', 'instructions']);
    expect(Object.keys(result)).toEqual(['approvalId', 'status', 'approveUrl', 'instructions']);
    expect(serialized['status']).toBe('pending');
    expect(serialized['approveUrl']).toBe(`http://127.0.0.1:4646/approvals/${result.approvalId}`);
    expect(serialized['instructions']).toBe(
      `Ask the owner to approve at http://127.0.0.1:4646/approvals/${result.approvalId}. Then call get_approval_status every 15 s for up to 10 minutes; stop on published, approved, denied or expired.`,
    );
  });
});

describe('approve and deny lifecycle', () => {
  it('checklist is the read-payload box plus every verify-before-publishing note, in order', () => {
    expect(gate.checklist('d1')).toEqual([READ_PAYLOAD_ITEM, ...(item.notes?.verifyBeforePublishing ?? [])]);
    expect(READ_PAYLOAD_ITEM).toBe('I have read this exact payload');
    expect(gate.checklist('d1')).toHaveLength(3);
  });

  it('approve with the read-payload box missing is refused before any presence prompt', async () => {
    const { approvalId } = gate.request('d1');
    await expectRefusal(
      gate.approve(approvalId, { channel: 'dashboard_hello', checked: gate.checklist('d1').slice(1), mode: 'publish_now' }),
      'CHECKLIST_INCOMPLETE',
    );
    expect(presence.prompts).toEqual([]);
  });

  it('a denied approval can never become approved', async () => {
    const { approvalId } = gate.request('d1');
    gate.deny(approvalId, { channel: 'dashboard_hello' });
    expect(repos.approvals.get(approvalId)?.status).toBe('denied');
    await expectRefusal(
      gate.approve(approvalId, { channel: 'dashboard_hello', checked: gate.checklist('d1'), mode: 'publish_now' }),
      'NOT_APPROVED',
    );
    expect(repos.approvals.get(approvalId)?.status).toBe('denied');
    expect(presence.prompts).toEqual([]);
  });

  it('an invalidated approval can never become approved', async () => {
    const { approvalId } = gate.request('d1');
    repos.approvals.setStatus(approvalId, 'invalidated');
    await expectRefusal(
      gate.approve(approvalId, { channel: 'dashboard_hello', checked: gate.checklist('d1'), mode: 'publish_now' }),
      'SOURCE_CHANGED',
    );
    expect(repos.approvals.get(approvalId)?.status).toBe('invalidated');
  });

  it('a pending approval past its TTL cannot be approved, and is marked expired', async () => {
    const { approvalId } = gate.request('d1');
    clock = at(31 * MIN);
    await expectRefusal(
      gate.approve(approvalId, { channel: 'dashboard_hello', checked: gate.checklist('d1'), mode: 'publish_now' }),
      'EXPIRED',
    );
    expect(repos.approvals.get(approvalId)?.status).toBe('expired');
    expect(presence.prompts).toEqual([]);
  });

  it('an approval invalidated while the presence prompt is open is not approved', async () => {
    const { approvalId } = gate.request('d1');
    const slow: FakePresence = Object.assign(new FakePresence(), {
      verify: (prompt: string) => {
        slow.prompts.push(prompt);
        // sync runs while the owner is looking at the Hello prompt
        repos.approvals.setStatus(approvalId, 'invalidated');
        repos.drafts.update('d1', { status: 'source_changed' });
        return Promise.resolve('verified' as const);
      },
    });
    presence = slow;
    gate = newGate();
    await expectRefusal(
      gate.approve(approvalId, { channel: 'dashboard_hello', checked: gate.checklist('d1'), mode: 'publish_now' }),
      'SOURCE_CHANGED',
    );
    expect(repos.approvals.get(approvalId)?.status).toBe('invalidated');
    expect(repos.approvals.get(approvalId)?.presenceVerifiedAt).toBeUndefined();
  });

  it('approving twice is refused the second time (only pending can be approved)', async () => {
    const approvalId = await approved();
    await expectRefusal(
      gate.approve(approvalId, { channel: 'dashboard_hello', checked: gate.checklist('d1'), mode: 'publish_now' }),
      'NOT_APPROVED',
    );
    expect(presence.prompts).toHaveLength(1);
  });

  it('approve refuses when the draft changed since the request', async () => {
    const { approvalId } = gate.request('d1');
    const edited = devtoPayload((p) => ({ ...p, description: 'changed' }));
    repos.drafts.update('d1', { payload: edited, payloadSha256: hashOf(edited) });
    await expectRefusal(
      gate.approve(approvalId, { channel: 'dashboard_hello', checked: gate.checklist('d1'), mode: 'publish_now' }),
      'HASH_MISMATCH',
    );
    expect(presence.prompts).toEqual([]);
  });

  it('approve refuses an unknown channel or mode (WRONG_CHANNEL) without prompting', async () => {
    const { approvalId } = gate.request('d1');
    const checked = gate.checklist('d1');
    await expectRefusal(
      gate.approve(approvalId, { channel: 'api_token' as never, checked, mode: 'publish_now' }),
      'WRONG_CHANNEL',
    );
    await expectRefusal(gate.approve(approvalId, { channel: 'dashboard_hello', checked, mode: 'all' as never }), 'WRONG_CHANNEL');
    expect(presence.prompts).toEqual([]);
    expect(repos.approvals.get(approvalId)?.status).toBe('pending');
  });

  it('deny needs no presence, moves pending to denied, and refuses anything not pending', async () => {
    const { approvalId } = gate.request('d1');
    gate.deny(approvalId, { channel: 'elicitation' });
    expect(presence.prompts).toEqual([]);
    expect(repos.approvals.get(approvalId)).toMatchObject({ status: 'denied' });
    expect(repos.audit.list({ limit: 1 })[0]).toMatchObject({ action: 'denied', approvalId });
    await expectRefusal(() => gate.deny(approvalId, { channel: 'dashboard_hello' }), 'NOT_APPROVED');
    await expectRefusal(() => gate.deny('nope', { channel: 'dashboard_hello' }), 'NO_APPROVAL');
    await expectRefusal(gate.authorize('d1', approvalId), 'NOT_APPROVED');
  });

  it('a schedule approval lives until fire time + 15 min', async () => {
    const fire = at(2 * HOUR).toISOString();
    insertDraft({ id: 'd2', scheduledAt: fire });
    const approvalId = await approved('d2', 'schedule');
    expect(repos.approvals.get(approvalId)).toMatchObject({ mode: 'schedule', expiresAt: at(2 * HOUR + 15 * MIN).toISOString() });
    clock = at(2 * HOUR + 10 * MIN);
    await expect(gate.authorize('d2', approvalId)).resolves.toMatchObject({ approvalId, draftId: 'd2', mode: 'schedule', scheduledAt: fire });
  });

  it('schedule mode on a draft with no scheduledAt is refused', async () => {
    const { approvalId } = gate.request('d1');
    await expectRefusal(
      gate.approve(approvalId, { channel: 'dashboard_hello', checked: gate.checklist('d1'), mode: 'schedule' }),
      'WRONG_CHANNEL',
    );
    expect(presence.prompts).toEqual([]);
  });
});

describe('authorize hardening', () => {
  it('an approval for another draft does not authorize this one: NO_APPROVAL', async () => {
    insertDraft({ id: 'd2' });
    const approvalId = await approved('d2');
    await expectRefusal(gate.authorize('d1', approvalId), 'NO_APPROVAL');
    expect(repos.approvals.get(approvalId)?.usedAt).toBeUndefined();
  });

  it('a draft flagged source_changed refuses even if its approval was not invalidated', async () => {
    const approvalId = await approved();
    repos.drafts.update('d1', { status: 'source_changed' });
    await expectRefusal(gate.authorize('d1', approvalId), 'SOURCE_CHANGED');
  });

  it('a post edited on disk since the last sync refuses with SOURCE_CHANGED (lint never runs on stale text)', async () => {
    const approvalId = await approved();
    item = loadItem((mdx) => `${mdx}\nA new closing paragraph.\n`);
    await expectRefusal(gate.authorize('d1', approvalId), 'SOURCE_CHANGED');
  });

  it('a draft built from an older version of the post refuses SOURCE_CHANGED, even when sync recorded the new post and never flagged it', async () => {
    const approvalId = await approved();
    // The post changed and the content row now records the new version (disk and row agree), but
    // the draft is still 'draft' and its approval was never invalidated.
    item = loadItem((mdx) => `${mdx}\nA new closing paragraph.\n`);
    seedContent();
    expect(repos.drafts.get('d1')?.status).toBe('draft');
    const err = await expectRefusal(gate.authorize('d1', approvalId), 'SOURCE_CHANGED');
    expect(err.message).toMatch(/another version of the post/);
    expect(repos.approvals.get(approvalId)?.usedAt).toBeUndefined();
    await expectRefusal(() => gate.request('d1'), 'SOURCE_CHANGED');
  });

  it('a draft with no recorded source (made before schema v2) refuses SOURCE_CHANGED', async () => {
    db.prepare('UPDATE drafts SET source_mdx_sha256 = NULL WHERE id = ?').run('d1');
    await expectRefusal(() => gate.request('d1'), 'SOURCE_CHANGED');
  });

  it('a dev.to body that is not the post as rendered now refuses LINT_ERRORS (devto-body)', async () => {
    insertDraft({ id: 'd3', payload: devtoPayload((p) => ({ ...p, body_markdown: `${p.body_markdown}\nA paragraph the post does not have.\n` })) });
    const err = await expectRefusal(() => gate.request('d3'), 'LINT_ERRORS');
    expect(err.detail?.['rules']).toContain('devto-body');
  });

  it('a post that can no longer be read refuses with SOURCE_CHANGED', async () => {
    const approvalId = await approved();
    gate = new ApprovalGate({
      repos,
      now: () => clock,
      health: () => Promise.resolve(true),
      presence,
      loadContentItem: () => undefined,
    });
    await expectRefusal(gate.authorize('d1', approvalId), 'SOURCE_CHANGED');
  });

  it('lint errors that appear after approval refuse at authorize: LINT_ERRORS', async () => {
    const approvalId = await approved();
    gate = new ApprovalGate({
      repos,
      now: () => clock,
      health: () => Promise.resolve(true),
      presence,
      loadContentItem: () => item,
      lintDraft: () => [{ rule: 'late-rule', severity: 'error', message: 'new rule' }],
    });
    await expectRefusal(gate.authorize('d1', approvalId), 'LINT_ERRORS');
  });

  it('a lint warning does not block', async () => {
    gate = new ApprovalGate({
      repos,
      now: () => clock,
      health: () => Promise.resolve(true),
      presence,
      loadContentItem: () => item,
      lintDraft: () => [{ rule: 'soft', severity: 'warning', message: 'fyi' }],
    });
    const approvalId = await approved();
    await expect(gate.authorize('d1', approvalId)).resolves.toMatchObject({ approvalId });
  });

  it.each(['publishing', 'unknown', 'published', 'handed_off'] as const)(
    'a draft already %s refuses with DUPLICATE (a second approval cannot post it again)',
    async (status) => {
      const approvalId = await approved();
      repos.drafts.update('d1', { status });
      await expectRefusal(gate.authorize('d1', approvalId), 'DUPLICATE');
      expect(repos.approvals.get(approvalId)?.usedAt).toBeUndefined();
    },
  );

  it('two approvals for one draft racing: exactly one authorizes', async () => {
    const first = await approved();
    const second = await approved();
    const results = await Promise.allSettled([gate.authorize('d1', first), gate.authorize('d1', second)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    // The winner's transaction invalidates the loser's approval (one Hello, one attempt), so the loser
    // is refused before it can reach the draft status check.
    expect((rejected?.reason as GateError).code).toBe('NOT_APPROVED');
    const used = [first, second].filter((id) => repos.approvals.get(id)?.usedAt !== undefined);
    expect(used).toHaveLength(1);
    const loser = used[0] === first ? second : first;
    expect(repos.approvals.get(loser)?.status).toBe('invalidated');
  });

  it('publishing turned off while the health check runs: PUBLISHING_DISABLED, nothing consumed', async () => {
    const approvalId = await approved();
    gate = new ApprovalGate({
      repos,
      now: () => clock,
      health: () => {
        repos.settings.set('publishing_enabled', 'false');
        return Promise.resolve(true);
      },
      presence,
      loadContentItem: () => item,
    });
    await expectRefusal(gate.authorize('d1', approvalId), 'PUBLISHING_DISABLED');
    expect(repos.approvals.get(approvalId)?.usedAt).toBeUndefined();
  });

  it('the approval expiring while the health check runs: EXPIRED, nothing consumed', async () => {
    const approvalId = await approved();
    gate = new ApprovalGate({
      repos,
      now: () => clock,
      health: () => {
        clock = at(30 * MIN);
        return Promise.resolve(true);
      },
      presence,
      loadContentItem: () => item,
    });
    await expectRefusal(gate.authorize('d1', approvalId), 'EXPIRED');
    expect(repos.approvals.get(approvalId)?.usedAt).toBeUndefined();
  });

  it('a health check that throws: UNHEALTHY', async () => {
    const approvalId = await approved();
    healthy = new Error('ECONNRESET');
    await expectRefusal(gate.authorize('d1', approvalId), 'UNHEALTHY');
  });

  it('a forged channel on the approval row: WRONG_CHANNEL', async () => {
    const approvalId = await approved();
    db.pragma('ignore_check_constraints = ON');
    db.prepare("UPDATE approvals SET channel = 'api_token' WHERE id = ?").run(approvalId);
    db.pragma('ignore_check_constraints = OFF');
    await expectRefusal(gate.authorize('d1', approvalId), 'WRONG_CHANNEL');
  });

  it('approveUrlFor and the instructions use the loopback URL', () => {
    expect(approveUrlFor('abc')).toBe('http://127.0.0.1:4646/approvals/abc');
    expect(APPROVAL_INSTRUCTIONS('http://x/1')).toBe(
      'Ask the owner to approve at http://x/1. Then call get_approval_status every 15 s for up to 10 minutes; stop on published, approved, denied or expired.',
    );
  });

  it('request on a source_changed draft: SOURCE_CHANGED', async () => {
    repos.drafts.update('d1', { status: 'source_changed' });
    await expectRefusal(() => gate.request('d1'), 'SOURCE_CHANGED');
  });
});

describe('approval modes (spec 2.6: the MCP publish path accepts only Approve only)', () => {
  it('a publish_now approval is refused on an approve_only path: WRONG_CHANNEL, nothing consumed', async () => {
    const approvalId = await approved('d1', 'publish_now');
    await expectRefusal(gate.authorize('d1', approvalId, { allowModes: ['approve_only'] }), 'WRONG_CHANNEL');
    expect(repos.approvals.get(approvalId)?.usedAt).toBeUndefined();
    expect(repos.drafts.get('d1')?.status).toBe('draft');
  });

  it('a schedule approval is refused on an approve_only path', async () => {
    insertDraft({ id: 'd2', scheduledAt: at(2 * HOUR).toISOString() });
    const approvalId = await approved('d2', 'schedule');
    await expectRefusal(gate.authorize('d2', approvalId, { allowModes: ['approve_only'] }), 'WRONG_CHANNEL');
  });

  it('an approve_only approval authorizes on an approve_only path and carries its mode', async () => {
    const approvalId = await approved('d1', 'approve_only');
    const v = await gate.authorize('d1', approvalId, { allowModes: ['approve_only'] });
    expect(v).toMatchObject({ approvalId, mode: 'approve_only', scheduledAt: null });
    expect(isVerifiedApproval(v)).toBe(true);
  });

  it('with no allowModes every mode is accepted', async () => {
    const approvalId = await approved('d1', 'approve_only');
    await expect(gate.authorize('d1', approvalId)).resolves.toMatchObject({ mode: 'approve_only' });
  });
});

describe('draft status allowlist (shared with sync)', () => {
  it.each(['publishing', 'unknown', 'published', 'handed_off'] as const)('request and approve refuse a %s draft: DUPLICATE', async (status) => {
    const { approvalId } = gate.request('d1');
    repos.drafts.update('d1', { status });
    await expectRefusal(() => gate.request('d1'), 'DUPLICATE');
    await expectRefusal(
      gate.approve(approvalId, { channel: 'dashboard_hello', checked: gate.checklist('d1'), mode: 'publish_now' }),
      'DUPLICATE',
    );
    expect(presence.prompts).toEqual([]);
  });

  it('a draft with an unrecognised status (DB tamper) is refused everywhere: NOT_APPROVED', async () => {
    const approvalId = await approved();
    db.pragma('ignore_check_constraints = ON');
    db.prepare("UPDATE drafts SET status = 'bogus' WHERE id = 'd1'").run();
    db.pragma('ignore_check_constraints = OFF');
    await expectRefusal(gate.authorize('d1', approvalId), 'NOT_APPROVED');
    await expectRefusal(() => gate.request('d1'), 'NOT_APPROVED');
    expect(repos.approvals.get(approvalId)?.usedAt).toBeUndefined();
  });

  it.each(['failed', 'held'] as const)('a %s draft can be re-approved and published while its source is unchanged', async (status) => {
    insertDraft({ id: 'd2', status });
    const approvalId = await approved('d2');
    await expect(gate.authorize('d2', approvalId)).resolves.toMatchObject({ draftId: 'd2' });
  });

  describe('end to end with a real sync', () => {
    let root: string;
    let repo: string;
    const postFile = (): string => join(repo, 'content', 'posts', `${SLUG}.mdx`);

    beforeEach(() => {
      // A space in the name: every Windows path in this project may contain one.
      root = mkdtempSync(join(tmpdir(), 'cph gate '));
      repo = join(root, 'example-blog-site');
      mkdirSync(join(repo, 'content', 'posts'), { recursive: true });
      mkdirSync(join(repo, 'content', 'publishing-notes'), { recursive: true });
      copyFileSync(`${FIXTURES}sample-post.mdx`, postFile());
      copyFileSync(`${FIXTURES}sample-notes.md`, join(repo, 'content', 'publishing-notes', `${SLUG}.md`));
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    const fakeGit: GitRunner = (args) => Promise.resolve({ stdout: args.includes('rev-parse') ? 'abc1234\n' : '' });
    const fetchFn = ((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const res = new Response(`<html><head><title>${item.frontmatter.title}</title></head></html>`, { status: 200 });
      Object.defineProperty(res, 'url', { value: url });
      return Promise.resolve(res);
    }) as typeof fetch;
    const sync = () => syncContent({ reader: new SiteReader(repo, fakeGit), repos, fetchFn, now: () => clock, timeZone: 'UTC' });

    /** What T0.18 wiring does: read the post from disk now, synchronously. */
    function diskGate(): ApprovalGate {
      return new ApprovalGate({
        repos,
        now: () => clock,
        health: () => Promise.resolve(true),
        presence,
        loadContentItem: (slug) =>
          buildContentItem({
            slug,
            mdxRaw: readFileSync(join(repo, 'content', 'posts', `${slug}.mdx`), 'utf8'),
            notesRaw: readFileSync(join(repo, 'content', 'publishing-notes', `${slug}.md`), 'utf8'),
            repoCommit: 'abc1234',
            dirty: false,
            baseUrl: DEFAULT_BASE_URL,
          }),
      });
    }

    it.each(['failed', 'held'] as const)(
      '%s draft: request + approve, then the MDX is edited and synced: authorize refuses SOURCE_CHANGED',
      async (status) => {
        await sync();
        insertDraft({ id: 'd2', status });
        gate = diskGate();
        const approvalId = await approved('d2');

        writeFileSync(postFile(), `${readFileSync(postFile(), 'utf8')}\nOne more paragraph.\n`);
        const result = await sync();

        expect(result.changed).toEqual([SLUG]);
        expect(repos.drafts.get('d2')?.status).toBe('source_changed');
        expect(repos.approvals.get(approvalId)?.status).toBe('invalidated');
        await expectRefusal(gate.authorize('d2', approvalId), 'SOURCE_CHANGED');
        expect(repos.approvals.get(approvalId)?.usedAt).toBeUndefined();
      },
    );
  });
});

describe('the Hello prompt names the exact approval', () => {
  const base = { platform: 'linkedin' as const, route: 'buffer' as const, slug: 'same-post' };

  it('carries the hash tag and a 40-grapheme preview, so two drafts for one post ask differently', () => {
    const a = approvalPrompt({ ...base, payload: { text: 'First take on the post' }, payloadSha256: `3f9a12c0${'a'.repeat(56)}` });
    const b = approvalPrompt({ ...base, payload: { text: 'Second take on the post' }, payloadSha256: `77b0e1d2${'b'.repeat(56)}` });
    expect(a).toBe('Approve LinkedIn via buffer · #3F9A12C0 · same-post · "First take on the post…"');
    expect(b).toBe('Approve LinkedIn via buffer · #77B0E1D2 · same-post · "Second take on the post…"');
    // Same text, different hash (another hashed field changed): still a different prompt.
    expect(approvalPrompt({ ...base, payload: { text: 'First take on the post' }, payloadSha256: 'c'.repeat(64) })).not.toBe(a);
  });

  it('puts the tag before the slug, so the 200-character cap never cuts it off', async () => {
    const longSlug = `a-very-long-post-slug-${'x'.repeat(190)}`;
    const prompt = approvalPrompt({ ...base, slug: longSlug, payload: { text: 'Take' }, payloadSha256: `3f9a12c0${'a'.repeat(56)}` });
    expect(prompt.length).toBeGreaterThan(200);
    expect(prompt.slice(0, 200)).toContain('#3F9A12C0');
    // The prompt Windows Hello actually shows (cut by WindowsHelloPresence) still carries the tag.
    const calls: string[][] = [];
    const hello = new WindowsHelloPresence({
      scriptPath: 'hello.ps1',
      execFile: (_file, args, _options, callback) => {
        calls.push([...args]);
        callback(null, '{"availability":"Available","result":"Verified"}', '');
        return undefined;
      },
    });
    await hello.verify(prompt);
    const shown = calls[0]?.at(-1) ?? '';
    expect(shown.length).toBeLessThanOrEqual(200);
    expect(shown).toContain('#3F9A12C0');
  });

  it('counts graphemes, folds whitespace, and falls back to the title', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    const preview = payloadPreview({ text: family.repeat(45) });
    expect([...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(preview)]).toHaveLength(41);
    expect(preview.endsWith(`${family}…`)).toBe(true);
    expect(payloadPreview({ text: 'a\r\n\n  b\tc' })).toBe('a b c…');
    expect(payloadPreview({ title: 'How High Cardinality Hurts Prometheus' })).toBe('How High Cardinality Hurts Prometheus…');
    expect(approvalTag(`0123abcd${'0'.repeat(56)}`)).toBe('#0123ABCD');
  });
});
