import { randomUUID } from 'node:crypto';
import type { Draft } from '@cph/core';
import { errorText, type Audit } from '../audit.js';
import type { Repos } from '../db/repos.js';
import type { Notifier } from '../notify.js';
import { validateLinkedinPostUrl } from '../routes/assist-linkedin.js';
import type { RouteRegistry } from '../routes/registry.js';
import { DraftError } from './drafts.js';

export type CheckOutcome = 'published' | 'failed' | 'unknown';

export interface RecoveryServiceDeps {
  repos: Repos;
  routes: RouteRegistry;
  audit: Audit;
  notifier: Notifier;
  now: () => Date;
  newId?: () => string;
}

export interface SweepReport {
  /** Drafts moved from 'publishing' to 'unknown' by this sweep. */
  recovered: string[];
  /** The outcome of the platform check for every draft that was 'unknown' after the move. */
  checked: Record<string, CheckOutcome>;
}

const ACTOR = 'recovery';
const NOT_FOUND_REASON = 'not found live on the platform after a publish with an unknown result; approve it again to retry';

/**
 * Resolves drafts whose publish result is unknown. A draft found in 'publishing' at startup was cut
 * off mid-call (crash, kill, power loss) and becomes 'unknown'. 'unknown' is resolved only by a
 * platform read (`checkOnPlatform`) or by the owner marking it by hand. Nothing here ever calls a
 * route's `publish`: a retry could double-post.
 */
export class RecoveryService {
  readonly #deps: RecoveryServiceDeps;
  readonly #newId: () => string;

  constructor(deps: RecoveryServiceDeps) {
    this.#deps = deps;
    this.#newId = deps.newId ?? randomUUID;
  }

  /** At daemon start, before anything can publish: every 'publishing' draft becomes 'unknown', then each 'unknown' draft is checked where the route can read. */
  async sweepOnStartup(): Promise<SweepReport> {
    const { repos } = this.#deps;
    const recovered: string[] = [];
    repos.transaction(() => {
      for (const draft of repos.drafts.list({ status: 'publishing' })) {
        repos.drafts.update(draft.id, { status: 'unknown', failureReason: 'the daemon stopped while this publish was in flight' });
        this.#audit('recovered_unknown', draft, { from: 'publishing' });
        recovered.push(draft.id);
      }
    });

    const checked: Record<string, CheckOutcome> = {};
    for (const draft of repos.drafts.list({ status: 'unknown' })) {
      checked[draft.id] = await this.checkOnPlatform(draft.id);
    }
    const open = Object.values(checked).filter((outcome) => outcome === 'unknown').length;
    if (open > 0) {
      await this.#deps.notifier.toast(
        'Publish results need checking',
        `${open} draft(s) may or may not be live. Open the dashboard and use "Check on platform" or mark them by hand.`,
        'critical',
      );
    }
    return { recovered, checked };
  }

  /**
   * Asks the platform whether an 'unknown' draft went out (dashboard "Check on platform", MCP
   * check_on_platform, `cph check`). Found live: the publication is recorded. Found not live:
   * 'failed', so a fresh approval can follow. Cannot tell (no read, a read error, BUDGET_LOW): stays
   * 'unknown'.
   */
  async checkOnPlatform(draftId: string): Promise<CheckOutcome> {
    const draft = this.#unknownDraft(draftId);
    const route = this.#deps.routes.get(draft.platform, draft.route);
    if (route?.checkOnPlatform === undefined) {
      this.#audit('check_on_platform', draft, { result: 'unsupported' });
      return 'unknown';
    }
    let answer: 'published' | 'not_found' | 'unknown';
    try {
      answer = await route.checkOnPlatform(draft);
    } catch (error) {
      this.#audit('check_on_platform_failed', draft, { error: errorText(error) });
      return 'unknown';
    }
    if (answer === 'unknown') {
      this.#audit('check_on_platform', draft, { result: 'unknown' });
      return 'unknown';
    }
    return this.#resolve(draftId, answer === 'published' ? 'published' : 'failed', { source: 'platform' });
  }

  /** The dashboard card's manual mark, after the owner looked on the platform himself. */
  resolveByHand(draftId: string, outcome: 'published' | 'failed', options: { remoteUrl?: string; actor?: string } = {}): void {
    const draft = this.#unknownDraft(draftId);
    let remoteUrl: string | undefined;
    if (options.remoteUrl !== undefined) remoteUrl = draft.platform === 'linkedin' ? validateLinkedinPostUrl(options.remoteUrl) : httpsUrl(options.remoteUrl);
    this.#resolve(draftId, outcome, { source: 'manual', actor: options.actor ?? 'dashboard', ...(remoteUrl === undefined ? {} : { remoteUrl }) });
  }

  // ---- internals -------------------------------------------------------------------------------

  #unknownDraft(draftId: string): Draft {
    const draft = this.#deps.repos.drafts.get(draftId);
    if (draft === undefined) throw new DraftError('unknown-draft', `no draft ${draftId}`);
    if (draft.status !== 'unknown') {
      throw new DraftError('not-unknown', `only a draft whose publish result is unknown can be checked or marked; this one is ${draft.status}`, {
        status: draft.status,
      });
    }
    return draft;
  }

  /** Records the outcome once: the draft must still be 'unknown' inside the transaction. */
  #resolve(draftId: string, outcome: 'published' | 'failed', how: { source: 'platform' | 'manual'; actor?: string; remoteUrl?: string }): CheckOutcome {
    const { repos } = this.#deps;
    return repos.transaction(() => {
      const draft = this.#unknownDraft(draftId);
      const action = how.source === 'platform' ? 'check_on_platform' : 'resolved_by_hand';
      if (outcome === 'failed') {
        repos.drafts.update(draftId, { status: 'failed', failureReason: NOT_FOUND_REASON });
        this.#audit(action, draft, { result: 'failed' }, how.actor);
        return 'failed';
      }
      const remoteId = draft.remoteScheduledId ?? draft.remoteRef;
      repos.publications.insert({
        id: this.#newId(),
        draftId,
        platform: draft.platform,
        account: draft.account,
        payloadSha256: draft.payloadSha256,
        ...(remoteId === undefined ? {} : { remoteId }),
        ...(how.remoteUrl === undefined ? {} : { remoteUrl: how.remoteUrl }),
        publishedAt: this.#deps.now().toISOString(),
        costUsd: 0,
      });
      repos.drafts.update(draftId, { status: 'published', failureReason: null });
      this.#audit(action, draft, { result: 'published', ...(remoteId === undefined ? {} : { remoteId }), ...(how.remoteUrl === undefined ? {} : { remoteUrl: how.remoteUrl }) }, how.actor);
      return 'published';
    });
  }

  #audit(action: string, draft: Draft, detail: Record<string, unknown>, actor = ACTOR): void {
    this.#deps.audit({ actorChannel: actor, action, draftId: draft.id, hash: draft.payloadSha256, platform: draft.platform, detail });
  }
}

function httpsUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new Error('the post URL is not a valid URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') throw new Error('the post URL must be https without credentials');
  return parsed.href;
}
