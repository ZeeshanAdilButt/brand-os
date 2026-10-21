import { randomUUID } from 'node:crypto';
import type { Draft, DraftStatus } from '@cph/core';
import { errorText, type Audit } from '../audit.js';
import type { Config } from '../config.js';
import { dryRunKey, type ApprovalMode, type DraftPatch, type Repos } from '../db/repos.js';
import type { ApprovalGate } from '../gate/approval-gate.js';
import { GateError } from '../gate/errors.js';
import { recomputeHash } from '../gate/prechecks.js';
import type { VerifiedApproval } from '../gate/verified.js';
import type { Notifier } from '../notify.js';
import { validateLinkedinPostUrl } from '../routes/assist-linkedin.js';
import { BufferMutationError } from '../routes/buffer-client.js';
import { activeRouteKind, type AnyRoute, type RouteRegistry } from '../routes/registry.js';
import { PlatformError, type AssistKit, type Publication } from '../routes/types.js';
import { DraftError } from './drafts.js';

export type DashboardChannel = 'dashboard_hello' | 'dashboard_click';

export type PublishStatus = 'published' | 'failed' | 'unknown' | 'dry_run';

export interface PublishResult {
  status: PublishStatus;
  remoteUrl?: string;
  /** Redacted. Set for failed and unknown. */
  error?: string;
}

/** The two gate operations the publish service uses (narrow, so a test can wrap them). */
export type PublishGate = Pick<ApprovalGate, 'authorize' | 'approve'>;

export interface PublishServiceDeps {
  repos: Repos;
  gate: PublishGate;
  routes: RouteRegistry;
  /** The live config: a draft made for a route that is no longer the active one is refused. */
  config: () => Config;
  audit: Audit;
  notifier: Notifier;
  now: () => Date;
  newId?: () => string;
  /** The channel recorded for the dashboard's approvals (default 'dashboard_hello'; 'dashboard_click' in click mode). */
  dashboardChannel?: DashboardChannel;
}

/** The modes the MCP / API path may spend (spec 2.6): only an Approve-only approval. */
export const MCP_ALLOW_MODES: readonly ApprovalMode[] = ['approve_only'];
/** The dashboard's Approve & publish spends the approval it just recorded. */
const DASHBOARD_MODE: ApprovalMode = 'publish_now';
const ACTOR = 'publish';

/** The only states a route's `markFailed` may move to `failed`: nothing is approved or in flight. */
const MARKABLE_FAILED: ReadonlySet<DraftStatus> = new Set<DraftStatus>(['draft', 'staged', 'failed']);

/**
 * The routes' `markFailed` dependency (ruling 4). A guarded compare-and-set on a positive list: only a
 * `draft`, `staged` or `failed` draft becomes `failed`. Anything else (in flight or out, pending or
 * approved, scheduled, held, source_changed) is left alone and audited: a late stage failure must not
 * reset such a draft to `failed`, because `failed` can be approved again and a second post could
 * follow, and it must not unflag a source_changed draft. The reason is redacted.
 */
export function markFailedIn(repos: Repos, audit: Audit): (draftId: string, reason: string) => void {
  return (draftId, reason) => {
    const text = errorText(reason);
    repos.transaction(() => {
      const draft = repos.drafts.get(draftId);
      if (draft === undefined) return;
      if (!MARKABLE_FAILED.has(draft.status)) {
        audit({
          actorChannel: ACTOR,
          action: 'mark_failed_ignored',
          draftId,
          hash: draft.payloadSha256,
          platform: draft.platform,
          detail: { status: draft.status, reason: text },
        });
        return;
      }
      repos.drafts.update(draftId, { status: 'failed', failureReason: text });
    });
  };
}

/**
 * The platform clearly said no, so nothing went out: a GraphQL MutationError, an HTTP 4xx (except
 * 408), or a GateError a route raised before sending (Buffer's pre-publish probe). Everything else
 * (timeouts, network errors, 5xx, a crash) is ambiguous: the post may be live.
 */
export function isCleanRefusal(error: unknown): boolean {
  if (error instanceof BufferMutationError || error instanceof GateError) return true;
  if (error instanceof PlatformError) return error.status >= 400 && error.status < 500 && error.status !== 408;
  return false;
}

/**
 * Publishing behind the approval gate. Every path goes through `gate.authorize`, which consumes the
 * approval and marks the draft `publishing` in one transaction; then the draft is re-read and its
 * hash checked once more right before the single route call. Nothing is ever retried:
 * - a clean refusal leaves the draft `failed` (a fresh approval can follow);
 * - anything ambiguous leaves it `unknown` with a toast, resolved only by `checkOnPlatform` or by hand.
 *
 * Refusals before the approval is spent (gate refusals, a route that cannot publish this draft)
 * throw (`GateError`, `DraftError`); outcomes after it are returned as a `PublishResult`.
 */
export class PublishService {
  readonly #deps: PublishServiceDeps;
  readonly #newId: () => string;

  constructor(deps: PublishServiceDeps) {
    this.#deps = deps;
    this.#newId = deps.newId ?? randomUUID;
  }

  /** The MCP / API path: spends only an Approve-only approval. */
  publish(draftId: string, approvalId: string): Promise<PublishResult> {
    return this.#publish(draftId, approvalId, MCP_ALLOW_MODES);
  }

  /**
   * The dashboard's Approve & publish: records the approval (Windows Hello in the daemon's process),
   * then publishes it in the same request through the same `authorize`. Hello not verified: the gate
   * throws and the approval stays pending.
   */
  async approveAndPublish(approvalId: string, ctx: { checked: string[] }): Promise<PublishResult> {
    const draftId = this.#draftIdOf(approvalId);
    if (draftId !== undefined) this.#routeFor(draftId, 'publish');
    await this.#deps.gate.approve(approvalId, { channel: this.#deps.dashboardChannel ?? 'dashboard_hello', checked: ctx.checked, mode: DASHBOARD_MODE });
    return this.#publish(this.#draftIdOf(approvalId) as string, approvalId, [DASHBOARD_MODE]);
  }

  /**
   * Assist routes, the MCP / API path: authorize an Approve-only approval like a publish, then copy
   * the text and open the page. The user posts. `approveAndHandOff` is the only publish_now path.
   */
  handOff(draftId: string, approvalId: string): Promise<AssistKit> {
    return this.#handOff(draftId, approvalId, MCP_ALLOW_MODES);
  }

  /** The dashboard's Approve & hand off (assist drafts): approve with Hello, then hand off at once. */
  async approveAndHandOff(approvalId: string, ctx: { checked: string[] }): Promise<AssistKit> {
    const draftId = this.#draftIdOf(approvalId);
    if (draftId !== undefined) this.#routeFor(draftId, 'handOff');
    await this.#deps.gate.approve(approvalId, { channel: this.#deps.dashboardChannel ?? 'dashboard_hello', checked: ctx.checked, mode: DASHBOARD_MODE });
    return this.#handOff(this.#draftIdOf(approvalId) as string, approvalId, [DASHBOARD_MODE]);
  }

  /** The user pastes back the URL of the post they made from a hand-off: record it once. */
  recordPublication(draftId: string, url: string): void {
    const { repos } = this.#deps;
    const draft = this.#draft(draftId);
    if (draft.platform !== 'linkedin') throw new DraftError('unsupported-platform', `recording a ${draft.platform} post by URL is not supported`);
    const remoteUrl = validateLinkedinPostUrl(url);
    repos.transaction(() => {
      const current = this.#draft(draftId);
      if (current.status !== 'handed_off') {
        throw new DraftError('not-handed-off', `only a handed-off draft can be recorded; this one is ${current.status}`, { status: current.status });
      }
      this.#recordPublished(current, { remoteUrl, costUsd: 0 }, 'user', 'publication_recorded');
    });
  }

  // ---- publish -----------------------------------------------------------------------------------

  async #publish(draftId: string, approvalId: string, allowModes: readonly ApprovalMode[]): Promise<PublishResult> {
    const { repos } = this.#deps;
    this.#routeFor(draftId, 'publish');

    // Consumes the approval and marks the draft 'publishing' in one transaction, or throws.
    const v = await this.#deps.gate.authorize(draftId, approvalId, { allowModes });

    let draft: Draft;
    let route: AnyRoute;
    try {
      ({ draft, route } = this.#afterAuthorize(draftId, v, 'publish'));
    } catch (error) {
      return this.#fail(draftId, v, error);
    }

    if (repos.settings.get(dryRunKey(draft.platform)) === 'true') {
      this.#settle(draftId, { status: draft.remoteRef === undefined ? 'draft' : 'staged' });
      this.#audit('dry_run', draft, v, { route: draft.route, payload: draft.payload });
      return { status: 'dry_run' };
    }

    this.#audit('publish_started', draft, v, { route: draft.route, mode: v.mode });
    let publication: Publication;
    try {
      publication = await route.publish(draft, v);
    } catch (error) {
      return isCleanRefusal(error) ? this.#fail(draftId, v, error) : this.#unknown(draft, v, error);
    }

    try {
      repos.transaction(() => this.#recordPublished(draft, publication, ACTOR, 'published', v));
    } catch (error) {
      // The platform has the post but we could not record it: never 'failed', never retried.
      return this.#unknown(draft, v, error);
    }
    return publication.remoteUrl === undefined ? { status: 'published' } : { status: 'published', remoteUrl: publication.remoteUrl };
  }

  async #handOff(draftId: string, approvalId: string, allowModes: readonly ApprovalMode[]): Promise<AssistKit> {
    this.#routeFor(draftId, 'handOff');
    const v = await this.#deps.gate.authorize(draftId, approvalId, { allowModes });

    let draft: Draft;
    let route: AnyRoute;
    try {
      ({ draft, route } = this.#afterAuthorize(draftId, v, 'handOff'));
    } catch (error) {
      this.#fail(draftId, v, error);
      throw error;
    }
    let kit: AssistKit;
    try {
      if (route.handOff === undefined) throw new DraftError('no-route', `the ${draft.route} route for ${draft.platform} has no hand-off`);
      kit = await route.handOff(draft, v);
    } catch (error) {
      // Nothing is public: the user never got the text. A fresh approval can follow.
      this.#fail(draftId, v, error, 'handoff_failed');
      throw error;
    }
    this.#settle(draftId, { status: 'handed_off' });
    this.#audit('handed_off', draft, v, { route: draft.route, openUrl: kit.openUrl });
    return kit;
  }

  // ---- checks ------------------------------------------------------------------------------------

  /**
   * Refusals that need no approval to be spent: the draft's route must exist, be the active one for
   * the platform, and be able to do this; dev.to must have a staged article. Audited, then thrown.
   */
  #routeFor(draftId: string, op: 'publish' | 'handOff'): AnyRoute | undefined {
    const draft = this.#deps.repos.drafts.get(draftId);
    if (draft === undefined) return undefined; // the gate refuses it (NO_APPROVAL) and audits it
    const refuse = (error: DraftError): never => {
      this.#deps.audit({
        actorChannel: ACTOR,
        action: `${op === 'publish' ? 'publish' : 'handoff'}_refused`,
        draftId,
        hash: draft.payloadSha256,
        platform: draft.platform,
        detail: { code: error.code, message: error.message },
      });
      throw error;
    };
    const route = this.#deps.routes.get(draft.platform, draft.route);
    if (route === undefined) return refuse(new DraftError('no-route', `no ${draft.route} route is registered for ${draft.platform}`));
    const active = activeRouteKind(draft.platform, this.#deps.config());
    if (draft.route !== active) {
      return refuse(new DraftError('inactive-route', `this draft was made for the ${draft.route} route; ${draft.platform} now uses ${active}. Create a new draft.`));
    }
    if (op === 'publish' && route.kind === 'assist') {
      return refuse(new DraftError('assist-route', 'an assist route never publishes; hand it off and post it yourself'));
    }
    if (op === 'handOff' && route.handOff === undefined) {
      return refuse(new DraftError('no-route', `the ${draft.route} route for ${draft.platform} has no hand-off`));
    }
    if (op === 'publish' && draft.platform === 'devto' && draft.remoteRef === undefined) {
      return refuse(new DraftError('not-staged', 'stage the dev.to draft first; publishing makes the staged article public'));
    }
    return route;
  }

  /**
   * Right after authorize: re-read the draft and check, once more, that it is in flight and is
   * byte-for-byte what was approved (ruling 2). Throws (nothing has been sent) on any difference.
   */
  #afterAuthorize(draftId: string, v: VerifiedApproval, op: 'publish' | 'handOff'): { draft: Draft; route: AnyRoute } {
    const draft = this.#deps.repos.drafts.get(draftId);
    if (draft === undefined) throw new GateError('NO_APPROVAL', 'the draft vanished after authorize');
    const sameHash = recomputeHash(draft) === v.payloadSha256 && draft.payloadSha256 === v.payloadSha256;
    if (!sameHash || (draft.scheduledAt ?? null) !== v.scheduledAt) {
      throw new GateError('HASH_MISMATCH', 'the draft changed after it was authorized; nothing was sent');
    }
    if (draft.status !== 'publishing') {
      throw new GateError('DUPLICATE', `the draft is ${draft.status}, not publishing; nothing was sent`);
    }
    const route = this.#deps.routes.get(draft.platform, draft.route);
    if (route === undefined || (op === 'handOff' ? route.handOff === undefined : route.kind === 'assist')) {
      throw new DraftError('no-route', `the ${draft.route} route for ${draft.platform} cannot ${op === 'publish' ? 'publish' : 'hand off'}`);
    }
    if (op === 'publish' && draft.platform === 'devto' && draft.remoteRef === undefined) {
      throw new DraftError('not-staged', 'stage the dev.to draft first');
    }
    return { draft, route };
  }

  // ---- outcomes ----------------------------------------------------------------------------------

  /** Nothing went out: `failed`, with the redacted reason, audited. A fresh approval can follow. */
  #fail(draftId: string, v: VerifiedApproval, error: unknown, action = 'publish_failed'): PublishResult {
    const reason = errorText(error);
    this.#settle(draftId, { status: 'failed', failureReason: reason });
    const draft = this.#deps.repos.drafts.get(draftId);
    if (draft !== undefined) this.#audit(action, draft, v, { error: reason, ...(error instanceof PlatformError ? { httpStatus: error.status } : {}) });
    return { status: 'failed', error: reason };
  }

  /** It may have gone out: `unknown`, audited and toasted. Never retried. */
  #unknown(draft: Draft, v: VerifiedApproval, error: unknown): PublishResult {
    const reason = errorText(error);
    this.#settle(draft.id, { status: 'unknown', failureReason: reason });
    this.#audit('publish_unknown', draft, v, { error: reason });
    void this.#deps.notifier.toast(
      'Publish result unknown',
      `The ${draft.platform} post for ${draft.slug} may or may not be live. Use "Check on platform" before anything else; it will not be retried.`,
      'critical',
    );
    return { status: 'unknown', error: reason };
  }

  /** Publication row + draft 'published' + audit. Runs inside the caller's transaction. */
  #recordPublished(draft: Draft, publication: Omit<Publication, 'remoteId'> & { remoteId?: string }, actor: string, action: string, v?: VerifiedApproval): void {
    const { repos } = this.#deps;
    repos.publications.insert({
      id: this.#newId(),
      draftId: draft.id,
      platform: draft.platform,
      account: draft.account,
      payloadSha256: v?.payloadSha256 ?? draft.payloadSha256,
      ...(publication.remoteId === undefined ? {} : { remoteId: publication.remoteId }),
      ...(publication.remoteUrl === undefined ? {} : { remoteUrl: publication.remoteUrl }),
      publishedAt: this.#deps.now().toISOString(),
      costUsd: publication.costUsd,
    });
    repos.drafts.update(draft.id, { status: 'published', failureReason: null });
    this.#deps.audit({
      actorChannel: actor,
      action,
      draftId: draft.id,
      ...(v === undefined ? {} : { approvalId: v.approvalId }),
      hash: v?.payloadSha256 ?? draft.payloadSha256,
      platform: draft.platform,
      detail: {
        route: draft.route,
        ...(publication.remoteId === undefined ? {} : { remoteId: publication.remoteId }),
        ...(publication.remoteUrl === undefined ? {} : { remoteUrl: publication.remoteUrl }),
        costUsd: publication.costUsd,
      },
    });
  }

  // ---- small helpers -----------------------------------------------------------------------------

  /** Moves an in-flight draft to its outcome. Only a draft still in 'publishing' is changed. */
  #settle(draftId: string, patch: DraftPatch): void {
    const { repos } = this.#deps;
    repos.transaction(() => {
      if (repos.drafts.get(draftId)?.status === 'publishing') repos.drafts.update(draftId, patch);
    });
  }

  #audit(action: string, draft: Draft, v: VerifiedApproval, detail: Record<string, unknown>): void {
    this.#deps.audit({ actorChannel: ACTOR, action, draftId: draft.id, approvalId: v.approvalId, hash: v.payloadSha256, platform: draft.platform, detail });
  }

  #draft(draftId: string): Draft {
    const draft = this.#deps.repos.drafts.get(draftId);
    if (draft === undefined) throw new DraftError('unknown-draft', `no draft ${draftId}`);
    return draft;
  }

  #draftIdOf(approvalId: string): string | undefined {
    return this.#deps.repos.approvals.get(approvalId)?.draftId;
  }
}
