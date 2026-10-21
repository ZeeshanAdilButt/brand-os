import { randomUUID } from 'node:crypto';
import type { ContentItem, Draft, PlatformId } from '@cph/core';
import type { Approval, ApprovalChannel, ApprovalMode, ApprovalStatus, Repos } from '../db/repos.js';
import { GateError } from './errors.js';
import {
  checkCanonicalLive,
  checkDraftSource,
  checkDraftStatus,
  checkRemoteScheduled,
  checkDuplicate,
  checkLint,
  checkNotBefore,
  checkPublishingEnabled,
  checkSourceCurrent,
  defaultLintDraft,
  isPast,
  recomputeHash,
  type LintDraft,
  type Refusal,
} from './prechecks.js';
import type { PresenceVerifier } from './presence.js';
import { mintVerifiedApproval, type VerifiedApproval } from './verified.js';

/** Publish-now and approve-only approvals live 30 minutes from the request (spec 2.6 rule 1). */
export const DEFAULT_TTL_MS = 30 * 60_000;
/** A scheduled approval lives until its fire time plus this grace. */
export const SCHEDULE_GRACE_MS = 15 * 60_000;
/** The first, fixed checklist box; the post's "Verify before publishing" notes follow it. */
export const READ_PAYLOAD_ITEM = 'I have read this exact payload';

const APPROVALS_URL = 'http://127.0.0.1:4646/approvals/';

export function approveUrlFor(approvalId: string): string {
  return `${APPROVALS_URL}${encodeURIComponent(approvalId)}`;
}

/** The polling contract handed to Claude (spec 2.6). */
export function APPROVAL_INSTRUCTIONS(approveUrl: string): string {
  return `Ask the owner to approve at ${approveUrl}. Then call get_approval_status every 15 s for up to 10 minutes; stop on published, approved, denied or expired.`;
}

const CHANNELS: ReadonlySet<string> = new Set<ApprovalChannel>(['dashboard_hello', 'dashboard_click', 'elicitation', 'chat_elicitation']);
const ALL_MODES: readonly ApprovalMode[] = ['publish_now', 'approve_only', 'schedule'];
const MODES: ReadonlySet<string> = new Set<ApprovalMode>(ALL_MODES);

/** Names shown in the presence prompt. */
const PLATFORM_LABELS: Record<PlatformId, string> = {
  devto: 'dev.to',
  linkedin: 'LinkedIn',
  x: 'X',
  bluesky: 'Bluesky',
  mastodon: 'Mastodon',
  hashnode: 'Hashnode',
  medium: 'Medium',
  substack: 'Substack',
  reddit: 'Reddit',
  youtube: 'YouTube',
};

/** Graphemes of the payload text (or title) shown in the Hello prompt and on the card. */
export const PROMPT_PREVIEW_GRAPHEMES = 40;
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/**
 * The approval's short tag: the first 8 hex characters of the draft's payload hash, upper-cased,
 * e.g. `#3F9A12C0`. The Hello prompt and the approval card both show it, so the owner can tell which
 * of two drafts for the same post he is approving.
 */
export function approvalTag(payloadSha256: string): string {
  return `#${payloadSha256.slice(0, 8).toUpperCase()}`;
}

/** The first 40 graphemes of the payload's text (LinkedIn) or title (dev.to), whitespace folded, then `…`. */
export function payloadPreview(payload: unknown): string {
  const p = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  const source = typeof p['text'] === 'string' ? p['text'] : typeof p['title'] === 'string' ? p['title'] : '';
  const folded = source.replace(/\s+/g, ' ').trim();
  const head = [...graphemes.segment(folded)].slice(0, PROMPT_PREVIEW_GRAPHEMES).map((s) => s.segment).join('');
  return `${head}…`;
}

/**
 * The Windows Hello prompt for one approval:
 * `Approve <Platform> via <route> · <TAG> · <slug> · "<preview>…"`. It names this exact draft, so a
 * second draft for the same post (one Claude could make and time to the expected prompt) asks
 * differently. The tag comes before the slug: the prompt is cut at 200 characters, and a long slug
 * must never cut the tag off.
 */
export function approvalPrompt(draft: Pick<Draft, 'platform' | 'route' | 'slug' | 'payload' | 'payloadSha256'>): string {
  return `Approve ${PLATFORM_LABELS[draft.platform]} via ${draft.route} · ${approvalTag(draft.payloadSha256)} · ${draft.slug} · "${payloadPreview(draft.payload)}"`;
}

const GATE_ACTOR = 'gate';

export interface ApprovalGateDeps {
  repos: Repos;
  now: () => Date;
  /** Connection health right before a publish (metered for Buffer, T0.15/T0.16). A throw is unhealthy. */
  health: (platform: PlatformId, account: string) => Promise<boolean>;
  presence: PresenceVerifier;
  /** Default 30 minutes. */
  ttlMs?: number;
  /**
   * The post as it is on disk now (built with `buildContentItem`), or `undefined` when it cannot be
   * read. Used for the checklist, the lint rerun and the "source unchanged since sync" check.
   */
  loadContentItem: (slug: string) => ContentItem | undefined;
  /** Defaults to the platform transform's `lint`. */
  lintDraft?: LintDraft;
  /** Approval ids. Defaults to `randomUUID`. */
  newId?: () => string;
}

/** What `request` returns. Nothing in it can approve or authorize anything if echoed back. */
export interface ApprovalRequest {
  approvalId: string;
  status: 'pending';
  approveUrl: string;
  instructions: string;
}

export interface ApproveContext {
  channel: ApprovalChannel;
  /** The checklist boxes ticked on the card, verbatim. */
  checked: string[];
  mode: ApprovalMode;
}

export interface AuthorizeOptions {
  /**
   * The approval modes this caller may consume. Default: all. The MCP publish path passes
   * ['approve_only'] (spec 2.6): an approval made for the dashboard's "Approve & publish" or for a
   * schedule cannot be spent by Claude. A mode outside the list is refused with WRONG_CHANNEL.
   */
  allowModes?: readonly ApprovalMode[];
}

export interface DenyContext {
  channel: ApprovalChannel;
}

interface AuditTarget {
  actor: string;
  draftId?: string;
  approvalId?: string;
  hash?: string;
  platform?: string;
}

interface Checked {
  approval: Approval;
  draft: Draft;
  hash: string;
}

/** A refusal raised inside a transaction so the transaction rolls back; audited after it. */
class Rollback extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.message);
  }
}

/**
 * A non-pending or non-approved status, as the refusal the caller should see. An invalidated
 * approval whose draft no longer hashes to the approved value was invalidated by a draft edit
 * (HASH_MISMATCH); otherwise the post changed under it (SOURCE_CHANGED).
 */
function statusRefusal(status: ApprovalStatus, wanted: ApprovalStatus, draftEdited = false, superseded = false): Refusal {
  if (status === 'invalidated' && draftEdited) {
    return { code: 'HASH_MISMATCH', message: 'the approval was invalidated because the draft was edited', detail: { status } };
  }
  if (status === 'invalidated' && superseded) {
    return {
      code: 'NOT_APPROVED',
      message: 'the approval was invalidated when another approval for this draft was used; request a new approval',
      detail: { status },
    };
  }
  if (status === 'invalidated') {
    return { code: 'SOURCE_CHANGED', message: 'the approval was invalidated because the post changed', detail: { status } };
  }
  if (status === 'expired') return { code: 'EXPIRED', message: 'the approval expired', detail: { status } };
  return { code: 'NOT_APPROVED', message: `the approval is ${status}, not ${wanted}`, detail: { status } };
}

/**
 * The hard rule (spec 2.6): nothing reaches a public surface without a single-use, unexpired,
 * presence-verified approval whose hash equals the draft's current hash.
 *
 * - `request` creates a pending approval (refusing drafts that could never pass).
 * - `approve` is the only path to 'approved', and only after the presence check returned exactly
 *   'verified'. It must never be reachable from the API-token router (T0.18).
 * - `authorize` runs every precheck, then consumes the approval and marks the draft `publishing`
 *   in one transaction, and returns the only value a route will accept.
 *
 * Every refusal is a `GateError` and is audited with its code.
 */
export class ApprovalGate {
  private readonly repos: Repos;
  private readonly now: () => Date;
  private readonly health: ApprovalGateDeps['health'];
  private readonly presence: PresenceVerifier;
  private readonly ttlMs: number;
  private readonly loadContentItem: ApprovalGateDeps['loadContentItem'];
  private readonly lintDraft: LintDraft;
  private readonly newId: () => string;

  constructor(deps: ApprovalGateDeps) {
    this.repos = deps.repos;
    this.now = deps.now;
    this.health = deps.health;
    this.presence = deps.presence;
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    this.loadContentItem = deps.loadContentItem;
    this.lintDraft = deps.lintDraft ?? defaultLintDraft;
    this.newId = deps.newId ?? randomUUID;
  }

  // ---- request -------------------------------------------------------------------------------

  request(draftId: string): ApprovalRequest {
    const draft = this.repos.drafts.get(draftId);
    if (draft === undefined) throw new Error(`unknown draft ${draftId}`);
    const hash = recomputeHash(draft);
    const target: AuditTarget = { actor: GATE_ACTOR, draftId, hash, platform: draft.platform };

    let refusal = checkDraftStatus(draft) ?? checkRemoteScheduled(draft);
    if (refusal === undefined && hash !== draft.payloadSha256) {
      refusal = { code: 'HASH_MISMATCH', message: 'the stored hash does not match the payload' };
    }
    refusal ??= this.contentChecks(draft);
    if (refusal !== undefined) throw this.refuse('request', refusal, target);

    const approvalId = this.newId();
    const expiresAt = new Date(this.now().getTime() + this.ttlMs).toISOString();
    // channel and mode are placeholders until approve() records the real ones.
    this.repos.approvals.insert({
      id: approvalId,
      draftId,
      payloadSha256: hash,
      channel: 'dashboard_hello',
      mode: 'publish_now',
      status: 'pending',
      expiresAt,
    });
    this.audit('approval_requested', { ...target, approvalId }, { expiresAt });

    const approveUrl = approveUrlFor(approvalId);
    return { approvalId, status: 'pending', approveUrl, instructions: APPROVAL_INSTRUCTIONS(approveUrl) };
  }

  // ---- checklist -----------------------------------------------------------------------------

  /** ['I have read this exact payload', ...notes.verifyBeforePublishing]. */
  checklist(draftId: string): string[] {
    const draft = this.repos.drafts.get(draftId);
    if (draft === undefined) throw new Error(`unknown draft ${draftId}`);
    const item = this.loadContentItem(draft.slug);
    if (item === undefined) {
      throw this.refuse(
        'checklist',
        { code: 'SOURCE_CHANGED', message: 'the post can no longer be read' },
        { actor: GATE_ACTOR, draftId, platform: draft.platform },
      );
    }
    return [READ_PAYLOAD_ITEM, ...(item.notes?.verifyBeforePublishing ?? [])];
  }

  // ---- approve -------------------------------------------------------------------------------

  async approve(approvalId: string, ctx: ApproveContext): Promise<void> {
    const actor = CHANNELS.has(ctx.channel) ? ctx.channel : 'invalid_channel';
    const target: AuditTarget = { actor, approvalId };
    if (!CHANNELS.has(ctx.channel) || !MODES.has(ctx.mode)) {
      throw this.refuse(
        'approve',
        { code: 'WRONG_CHANNEL', message: 'unknown approval channel or mode', detail: { channel: String(ctx.channel), mode: String(ctx.mode) } },
        target,
      );
    }

    const before = this.approvePrechecks(approvalId, ctx);
    if ('code' in before) throw this.refuse('approve', before, target);
    const { draft, hash } = before;
    Object.assign(target, { draftId: draft.id, hash, platform: draft.platform });

    // Fail closed: only the exact answer 'verified' counts; a throw is 'error'.
    const prompt = approvalPrompt({ ...draft, payloadSha256: hash });
    let result: string;
    try {
      result = await this.presence.verify(prompt);
    } catch {
      result = 'error';
    }
    if (result !== 'verified') {
      throw this.refuse('approve', { code: 'PRESENCE_FAILED', message: `presence check: ${result}`, detail: { result } }, target);
    }

    // The prompt can stay open for minutes: re-check everything, then flip pending -> approved atomically.
    let refusal: Refusal | undefined;
    this.repos.transaction(() => {
      const again = this.approvePrechecks(approvalId, ctx);
      if ('code' in again) {
        refusal = again;
        return;
      }
      const verifiedAt = this.now().toISOString();
      const scheduledAt = again.draft.scheduledAt;
      const ok = this.repos.approvals.setStatus(approvalId, 'approved', {
        from: 'pending',
        presenceVerifiedAt: verifiedAt,
        channel: ctx.channel,
        mode: ctx.mode,
        ...(ctx.mode === 'schedule' && scheduledAt !== undefined
          ? { expiresAt: new Date(Date.parse(scheduledAt) + SCHEDULE_GRACE_MS).toISOString() }
          : {}),
      });
      if (!ok) {
        refusal = { code: 'NOT_APPROVED', message: 'the approval is no longer pending' };
        return;
      }
      this.audit('approved', target, { mode: ctx.mode, presenceVerifiedAt: verifiedAt });
    });
    if (refusal !== undefined) throw this.refuse('approve', refusal, target);
  }

  // ---- deny ----------------------------------------------------------------------------------

  /** Saying no needs no presence check. Only a pending approval can be denied. */
  deny(approvalId: string, ctx: DenyContext): void {
    const actor = CHANNELS.has(ctx.channel) ? ctx.channel : 'invalid_channel';
    const target: AuditTarget = { actor, approvalId };
    if (!CHANNELS.has(ctx.channel)) {
      throw this.refuse('deny', { code: 'WRONG_CHANNEL', message: 'unknown approval channel' }, target);
    }
    const approval = this.repos.approvals.get(approvalId);
    if (approval === undefined) throw this.refuse('deny', { code: 'NO_APPROVAL', message: 'no such approval' }, target);
    Object.assign(target, { draftId: approval.draftId, hash: approval.payloadSha256 });
    if (approval.status !== 'pending') throw this.refuse('deny', statusRefusal(approval.status, 'pending'), target);
    if (!this.repos.approvals.setStatus(approvalId, 'denied', { from: 'pending', channel: ctx.channel })) {
      throw this.refuse('deny', { code: 'NOT_APPROVED', message: 'the approval is no longer pending' }, target);
    }
    this.audit('denied', target);
  }

  // ---- authorize -----------------------------------------------------------------------------

  /**
   * Order: publishing_enabled, approval exists (for this draft), approved, unused, channel, mode allowed,
   * presence verified, unexpired, hash recomputed and equal, draft status on the live allowlist
   * (source_changed -> SOURCE_CHANGED, in flight or out -> DUPLICATE), no remote scheduled post
   * (REMOTE_SCHEDULED), canonical live, source unchanged
   * since sync, lint clean, not_before passed, no duplicate, health; then consume + 'publishing' in
   * one transaction, after re-running every synchronous check.
   */
  async authorize(draftId: string, approvalId: string, options: AuthorizeOptions = {}): Promise<VerifiedApproval> {
    const allowModes: readonly ApprovalMode[] = options.allowModes ?? ALL_MODES;
    const target: AuditTarget = { actor: GATE_ACTOR, draftId, approvalId };

    const before = this.authorizePrechecks(draftId, approvalId, allowModes);
    if ('code' in before) throw this.refuse('authorize', before, target);
    const { draft, hash } = before;
    Object.assign(target, { hash, platform: draft.platform });

    let healthy: boolean;
    try {
      healthy = (await this.health(draft.platform, draft.account)) === true;
    } catch {
      healthy = false;
    }
    if (!healthy) {
      throw this.refuse('authorize', { code: 'UNHEALTHY', message: `${draft.platform}/${draft.account} is not healthy` }, target);
    }

    // Anything may have changed during the await (sync, settings, a racing authorize): check again,
    // then consume and record "in flight" atomically (Review Focus #2).
    try {
      return this.repos.transaction(() => {
        const again = this.authorizePrechecks(draftId, approvalId, allowModes);
        if ('code' in again) throw new Rollback(again);
        if (again.hash !== hash) throw new Rollback({ code: 'HASH_MISMATCH', message: 'the draft changed during authorize' });
        if (!this.repos.approvals.consume(approvalId)) {
          throw new Rollback({ code: 'USED', message: 'the approval was already used' });
        }
        if (!this.repos.drafts.update(draftId, { status: 'publishing' }, hash)) {
          throw new Rollback({ code: 'HASH_MISMATCH', message: 'the draft changed during authorize' });
        }
        // One Hello, one attempt: every other pending or approved approval for this draft dies with
        // this one, so a failed attempt can never be followed by a second spend without a new Hello.
        const superseded: string[] = [];
        for (const other of this.repos.approvals.listByDraft(draftId)) {
          if (other.id === approvalId) continue;
          if (other.status === 'pending' && this.repos.approvals.setStatus(other.id, 'invalidated', { from: 'pending' })) superseded.push(other.id);
          if (other.status === 'approved' && this.repos.approvals.setStatus(other.id, 'invalidated', { from: 'approved' })) superseded.push(other.id);
        }
        this.audit('authorize_ok', target, { mode: again.approval.mode, ...(superseded.length === 0 ? {} : { supersededApprovals: superseded }) });
        return mintVerifiedApproval({
          approvalId,
          draftId,
          payloadSha256: hash,
          mode: again.approval.mode,
          scheduledAt: again.draft.scheduledAt ?? null,
        });
      });
    } catch (err) {
      if (err instanceof Rollback) throw this.refuse('authorize', err.refusal, target);
      throw err;
    }
  }

  // ---- checks --------------------------------------------------------------------------------

  /**
   * Canonical live, source unchanged since sync, the draft built from that same source, lint clean
   * (for dev.to, lint also requires the body to be the post as rendered now).
   */
  private contentChecks(draft: Draft): Refusal | undefined {
    const content = this.repos.content.get(draft.slug);
    const live = checkCanonicalLive(content);
    if (live !== undefined) return live;
    const item = this.loadContentItem(draft.slug);
    const current = checkSourceCurrent(content, item);
    if (current !== undefined || item === undefined) return current;
    const source = checkDraftSource(draft, content);
    if (source !== undefined) return source;
    return checkLint(draft, item, this.lintDraft);
  }

  /** Approval pending and unexpired, draft unchanged since the request, every checklist box ticked. */
  private approvePrechecks(approvalId: string, ctx: ApproveContext): Checked | Refusal {
    const approval = this.repos.approvals.get(approvalId);
    if (approval === undefined) return { code: 'NO_APPROVAL', message: 'no such approval' };
    if (approval.status !== 'pending') return statusRefusal(approval.status, 'pending', false, this.superseded(approval));
    if (isPast(approval.expiresAt, this.now())) {
      this.repos.approvals.setStatus(approvalId, 'expired', { from: 'pending' });
      return { code: 'EXPIRED', message: 'the approval request expired', detail: { expiresAt: approval.expiresAt } };
    }
    const draft = this.repos.drafts.get(approval.draftId);
    if (draft === undefined) return { code: 'NO_APPROVAL', message: 'the approval has no draft' };
    const status = checkDraftStatus(draft) ?? checkRemoteScheduled(draft);
    if (status !== undefined) return status;
    const hash = recomputeHash(draft);
    if (hash !== approval.payloadSha256 || hash !== draft.payloadSha256) {
      return { code: 'HASH_MISMATCH', message: 'the draft changed after the approval was requested' };
    }
    if (ctx.mode === 'schedule' && (draft.scheduledAt === undefined || !Number.isFinite(Date.parse(draft.scheduledAt)))) {
      return { code: 'WRONG_CHANNEL', message: 'mode schedule needs a draft with a valid scheduledAt' };
    }
    const item = this.loadContentItem(draft.slug);
    if (item === undefined) return { code: 'SOURCE_CHANGED', message: 'the post can no longer be read' };
    const checked = new Set(Array.isArray(ctx.checked) ? ctx.checked : []);
    const missing = [READ_PAYLOAD_ITEM, ...(item.notes?.verifyBeforePublishing ?? [])].filter((box) => !checked.has(box));
    if (missing.length > 0) {
      return { code: 'CHECKLIST_INCOMPLETE', message: `${missing.length} checklist item(s) not ticked`, detail: { missing } };
    }
    return { approval, draft, hash };
  }

  /** Every synchronous authorize check, in the documented order. Writes only to mark an expired approval. */
  private authorizePrechecks(draftId: string, approvalId: string, allowModes: readonly ApprovalMode[]): Checked | Refusal {
    const now = this.now();
    const disabled = checkPublishingEnabled(this.repos);
    if (disabled !== undefined) return disabled;

    const approval = this.repos.approvals.get(approvalId);
    if (approval === undefined || approval.draftId !== draftId) {
      return { code: 'NO_APPROVAL', message: 'no approval for this draft' };
    }
    if (approval.status !== 'approved') {
      return statusRefusal(approval.status, 'approved', this.draftEdited(approval), this.superseded(approval));
    }
    if (approval.usedAt !== undefined) return { code: 'USED', message: 'the approval was already used', detail: { usedAt: approval.usedAt } };
    if (!CHANNELS.has(approval.channel)) {
      return { code: 'WRONG_CHANNEL', message: 'the approval did not come from a human-presence channel', detail: { channel: approval.channel } };
    }
    if (!allowModes.includes(approval.mode)) {
      return {
        code: 'WRONG_CHANNEL',
        message: `this path accepts only ${allowModes.join(', ') || 'no'} approvals, not ${approval.mode}`,
        detail: { mode: approval.mode, allowModes: [...allowModes] },
      };
    }
    if (approval.presenceVerifiedAt === undefined) {
      return { code: 'PRESENCE_FAILED', message: 'the approval has no verified presence check' };
    }
    if (isPast(approval.expiresAt, now)) {
      this.repos.approvals.setStatus(approvalId, 'expired', { from: 'approved' });
      return { code: 'EXPIRED', message: 'the approval expired', detail: { expiresAt: approval.expiresAt } };
    }

    const draft = this.repos.drafts.get(draftId);
    if (draft === undefined) return { code: 'NO_APPROVAL', message: 'no such draft' };
    const hash = recomputeHash(draft);
    if (hash !== approval.payloadSha256 || hash !== draft.payloadSha256) {
      return { code: 'HASH_MISMATCH', message: 'the draft is not what was approved' };
    }
    const status = checkDraftStatus(draft) ?? checkRemoteScheduled(draft);
    if (status !== undefined) return status;

    const content = this.contentChecks(draft);
    if (content !== undefined) return content;

    const notBefore = checkNotBefore(draft, now);
    if (notBefore !== undefined) return notBefore;
    const duplicate = checkDuplicate(this.repos, draft, hash);
    if (duplicate !== undefined) return duplicate;
    return { approval, draft, hash };
  }

  /** Another approval for the same draft has been spent (which invalidates this one). */
  private superseded(approval: Approval): boolean {
    return this.repos.approvals.listByDraft(approval.draftId).some((other) => other.id !== approval.id && other.usedAt !== undefined);
  }

  /** The approval's draft exists and no longer hashes to what the approval was given for. */
  private draftEdited(approval: Approval): boolean {
    const draft = this.repos.drafts.get(approval.draftId);
    return draft !== undefined && recomputeHash(draft) !== approval.payloadSha256;
  }

  // ---- audit ---------------------------------------------------------------------------------

  private audit(action: string, target: AuditTarget, detail?: Record<string, unknown>): void {
    this.repos.audit.append({
      actorChannel: target.actor,
      action,
      ...(target.draftId === undefined ? {} : { draftId: target.draftId }),
      ...(target.approvalId === undefined ? {} : { approvalId: target.approvalId }),
      ...(target.hash === undefined ? {} : { hash: target.hash }),
      ...(target.platform === undefined ? {} : { platform: target.platform }),
      ...(detail === undefined ? {} : { detail }),
    });
  }

  /** Audits the refusal (outside any transaction that is rolling back) and returns the error to throw. */
  private refuse(op: string, refusal: Refusal, target: AuditTarget): GateError {
    this.audit(`${op}_refused`, target, { code: refusal.code, message: refusal.message, ...refusal.detail });
    return new GateError(refusal.code, refusal.message, refusal.detail);
  }
}
