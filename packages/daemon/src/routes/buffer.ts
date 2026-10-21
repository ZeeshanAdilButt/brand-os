import type { Draft, LinkedinPayload, PlatformId } from '@cph/core';
import type { Config } from '../config.js';
import type { AuditEntry } from '../db/repos.js';
import { GateError } from '../gate/errors.js';
import { assertVerifiedApproval, type VerifiedApproval } from '../gate/verified.js';
import type { SecretStore } from '../secrets/secret-store.js';
import type { ApiBudget } from '../services/api-budget.js';
import { BufferClient, BufferGraphQLError, BufferMutationError, type BufferChannel, type BufferCreatePostInput } from './buffer-client.js';
import { PlatformError, StageRefused, type Health, type Publication, type RemoteRef, type Route } from './types.js';

/**
 * The `post.status` Buffer reports for a post saved as a draft. UNVERIFIED until S2(i). A stage that
 * gets anything else back deletes the post at once.
 */
export const BUFFER_DRAFT_STATUS = 'draft';
/** The status of a post that has gone out. UNVERIFIED until S2(i). */
const BUFFER_SENT_STATUS = 'sent';
/** Buffer's `service` value for a LinkedIn channel. UNVERIFIED until S2(d). */
const LINKEDIN_SERVICE = 'linkedin';

export const BUFFER_CHANNELS_URL = 'https://publish.buffer.com/channels';
/** Where to delete a post by hand. A direct link to one post waits on S2(c). */
export const BUFFER_PUBLISH_URL = 'https://publish.buffer.com';
export const BUFFER_RECONNECT_ACTION = `Reconnect LinkedIn in Buffer: ${BUFFER_CHANNELS_URL}`;

const BUFFER_NOT_DRAFT_DELETED = 'Buffer did not save this as a draft; it was deleted';
const BUFFER_NOT_DRAFT_KEPT =
  'Buffer did not save this as a draft and the delete failed. Delete it by hand in Buffer now: a post may be queued or live';

/**
 * Buffer's key is stored under the platform this route serves. The `credentials` table keys on a
 * platform id, and a Buffer key is not one; later Buffer-backed routes (X, YouTube) read this entry.
 */
const SECRET_PLATFORM: PlatformId = 'linkedin';

const STAGEABLE: ReadonlySet<string> = new Set(['draft', 'staged']);

/** What a route may change in config: the cached organization id and the mapped LinkedIn channel. */
export interface PlatformsConfigPatch {
  buffer?: { organizationId: string };
  linkedin?: { bufferChannelId: string };
}

/** A toast plus, for `critical`, a red dashboard card. The dashboard (T0.19) renders it. */
export interface BufferAlert {
  level: 'warning' | 'critical';
  title: string;
  message: string;
  link?: string;
}

export interface BufferRouteDeps {
  secrets: SecretStore;
  fetchFn: typeof fetch;
  now: () => Date;
  budget: ApiBudget;
  /** The live config. Read on every call, so a mapping saved from the dashboard is seen at once. */
  config: () => Config;
  /** Merges the patch into `config.platforms` and writes config.json. The route never writes files itself. */
  saveConfig: (patch: PlatformsConfigPatch) => void;
  /** Records that a draft failed, with the reason. The route never changes a draft's status otherwise. */
  markFailed: (draftId: string, reason: string) => void;
  audit: (entry: AuditEntry) => void;
  alert: (alert: BufferAlert) => void;
  /**
   * Where the last probe result and channel list survive a restart (the `settings` table). Without
   * it the cache is memory-only, and `lastHealth`, `linkedinChannels` and `mapChannel` are empty
   * until the next probe, up to a day away.
   */
  store?: { get(key: string): string | undefined; set(key: string, value: string): void };
}

/** A stage got a post that is not a draft back from Buffer. By the time this is thrown the cleanup has run. */
export class BufferStageError extends Error {
  override readonly name = 'BufferStageError';
}

/**
 * A shareNow came back as a Buffer draft: not clearly published, not clearly refused. Deliberately not
 * a clean refusal, so the publish service records 'unknown' (never 'published', never retried).
 */
export class BufferPublishNotSentError extends Error {
  override readonly name = 'BufferPublishNotSentError';
}

interface Cached {
  health: Health;
  channels: BufferChannel[];
  checkedAt: string;
}

const ACTOR = 'buffer-route';
const cacheKey = (account: string): string => `buffer_probe_cache:${account}`;

/**
 * LinkedIn through Buffer.
 *
 * - `health` is a metered probe: one `channels(cachedOrgId)` call, never `organizations`. The
 *   daemon runs it once a day (`createHealthScheduler`) and `publish` runs it right before sending.
 *   `lastHealth` serves the cached result to `cph status` and the dashboard without a request.
 * - `stage` saves a private Buffer draft and checks that Buffer really made it a draft.
 * - `publish` is the only method that sends `shareNow`. It needs a `VerifiedApproval` for this exact
 *   draft and hash, and it never retries.
 */
export class BufferRoute implements Route<LinkedinPayload> {
  readonly kind = 'buffer' as const;
  readonly platform = 'linkedin' as const;
  readonly #deps: BufferRouteDeps;
  readonly #cache = new Map<string, Cached>();
  readonly #loaded = new Set<string>();

  constructor(deps: BufferRouteDeps) {
    this.#deps = deps;
  }

  /** The metered probe. Refused with BUDGET_LOW, without a request, when the budget is low. */
  health(account: string): Promise<Health> {
    return this.#probe(account, 'probe');
  }

  /** The last probe result and when it was taken, or `undefined` before the first probe. */
  lastHealth(account: string): { health: Health; checkedAt: string } | undefined {
    const cached = this.#cached(account);
    return cached === undefined ? undefined : { health: cached.health, checkedAt: cached.checkedAt };
  }

  /** LinkedIn channels from the last `connect` or probe, for the dashboard's mapping dropdown. */
  linkedinChannels(account: string): BufferChannel[] {
    return (this.#cached(account)?.channels ?? []).filter((c) => c.service === LINKEDIN_SERVICE);
  }

  async connect(account: string, input: Record<string, string>): Promise<Health> {
    const apiKey = input['apiKey'];
    if (apiKey === undefined || apiKey.trim() === '') {
      return { state: 'not_configured', detail: 'An apiKey is required.', nextAction: 'Paste a Buffer API key from publish.buffer.com/settings/api.' };
    }
    const client = this.#client(apiKey);
    let organizationId: string;
    let channels: BufferChannel[];
    let extraOrganizations = 0;
    try {
      const organizations = await client.organizations();
      const first = organizations[0];
      if (first === undefined) {
        return { state: 'not_configured', detail: 'This Buffer account has no organization.', nextAction: 'Create a Buffer organization and add your LinkedIn channel.' };
      }
      organizationId = first.id;
      extraOrganizations = organizations.length - 1;
      channels = await client.channels(organizationId, { purpose: 'other' });
    } catch (error) {
      if (isRejectedKey(error)) return rejectedKey();
      throw error;
    }
    this.#deps.secrets.put(SECRET_PLATFORM, account, { apiKey });
    this.#deps.saveConfig({ buffer: { organizationId } });
    const mapped = this.#deps.config().platforms.linkedin?.bufferChannelId;
    const health = this.#remember(account, channels, mapped);
    return extraOrganizations > 0 && health.state === 'connected'
      ? { ...health, detail: `Using the first of ${extraOrganizations + 1} Buffer organizations.` }
      : health;
  }

  /** Saves the chosen LinkedIn channel to config and re-reads the cached channel list. No request. */
  mapChannel(account: string, channelId: string): Health {
    const cached = this.#cached(account);
    const channel = cached?.channels.find((c) => c.id === channelId && c.service === LINKEDIN_SERVICE);
    if (cached === undefined || channel === undefined) {
      throw new Error(`"${channelId}" is not a LinkedIn channel in the last list Buffer returned; reconnect or refresh first`);
    }
    this.#deps.saveConfig({ linkedin: { bufferChannelId: channelId } });
    return this.#remember(account, cached.channels, channelId, cached.checkedAt);
  }

  async stage(d: Draft<LinkedinPayload>): Promise<RemoteRef> {
    if (!STAGEABLE.has(d.status)) {
      throw new StageRefused(`cannot stage a draft in status "${d.status}"; only draft or staged drafts can be staged`);
    }
    const client = this.#client(this.#requireKey(d.account));
    const channelId = this.#channelId();
    // The private-stage literal: addToQueue only ever travels with saveToDraft: true.
    const input: BufferCreatePostInput = {
      channelId,
      text: d.payload.text,
      schedulingType: 'automatic',
      mode: 'addToQueue',
      saveToDraft: true,
      ...linkMetadata(d.payload),
    };
    let post;
    try {
      post = await client.createPost(input);
    } catch (error) {
      if (error instanceof BufferMutationError) this.#deps.markFailed(d.id, error.message);
      throw error;
    }
    if (post.status !== BUFFER_DRAFT_STATUS) await this.#undoNonDraft(client, d, post);

    // A re-stage: the new draft exists, so the old private one can go. Failing to delete it is not fatal.
    if (d.remoteRef !== undefined && d.remoteRef !== post.id) {
      try {
        await client.deletePost(d.remoteRef);
      } catch (error) {
        this.#deps.audit({
          actorChannel: ACTOR,
          action: 'buffer_old_draft_not_deleted',
          draftId: d.id,
          platform: 'linkedin',
          detail: { postId: d.remoteRef, message: error instanceof Error ? error.message : String(error) },
        });
      }
    }
    return { remoteId: post.id };
  }

  async publish(d: Draft<LinkedinPayload>, a: VerifiedApproval): Promise<Publication> {
    assertVerifiedApproval(a);
    if (a.draftId !== d.id) {
      throw new GateError('NO_APPROVAL', 'the approval was granted for a different draft', { draftId: d.id });
    }
    if (a.payloadSha256 !== d.payloadSha256) {
      throw new GateError('HASH_MISMATCH', 'the approval does not cover the draft as it is now', { draftId: d.id });
    }
    const apiKey = this.#requireKey(d.account);

    // The pre-publish probe: one channels() call, exempt from the budget guard. If the mapped channel
    // is gone or disconnected nothing is sent.
    const health = await this.#probe(d.account, 'publish');
    if (health.state !== 'connected') {
      throw new GateError('UNHEALTHY', health.nextAction ?? health.detail ?? 'Buffer is not ready to publish', { state: health.state });
    }
    const channelId = this.#channelId();

    // One request, no retry, no assets (a link attachment cannot be combined with non-empty assets).
    const client = this.#client(apiKey);
    const input: BufferCreatePostInput = {
      channelId,
      text: d.payload.text,
      schedulingType: 'automatic',
      mode: 'shareNow',
      ...linkMetadata(d.payload),
    };
    let post;
    try {
      post = await client.createPost(input);
    } catch (error) {
      // A MutationError is Buffer saying "not done". Anything else is ambiguous and is left to the
      // publish service to treat as unknown.
      if (error instanceof BufferMutationError) this.#deps.markFailed(d.id, error.message);
      throw error;
    }
    if (post.status === BUFFER_DRAFT_STATUS) {
      throw new BufferPublishNotSentError(
        `Buffer saved post ${post.id} as a draft instead of sending it; check Buffer before anything else, it will not be retried`,
      );
    }
    return { remoteId: post.id, costUsd: 0 };
  }

  /** Deletes the post Buffer holds for a later time (used from T1.7). */
  async cancelScheduled(d: Draft<LinkedinPayload>): Promise<void> {
    if (d.remoteScheduledId === undefined) throw new Error('this draft has no scheduled Buffer post to cancel');
    await this.#client(this.#requireKey(d.account)).deletePost(d.remoteScheduledId);
  }

  async checkOnPlatform(d: Draft<LinkedinPayload>): Promise<'published' | 'not_found' | 'unknown'> {
    // `remoteRef` is the private staged draft; a publish creates a separate shareNow post and leaves the
    // draft as it was, so the draft's state says nothing about whether the publish went out. Only an id
    // known to be the scheduled post can answer (a bare shareNow with no stored id stays unknown).
    const postId = d.remoteScheduledId;
    if (postId === undefined) return 'unknown';
    const client = this.#client(this.#requireKey(d.account));
    let post;
    try {
      post = await client.post(postId);
    } catch (error) {
      // The read-back query is UNVERIFIED until S2; a schema complaint must not crash the sweep.
      if (error instanceof BufferGraphQLError) return 'unknown';
      throw error;
    }
    // No post for the id is not proof that nothing went out (the read-back query is unverified): unknown.
    if (post === null) return 'unknown';
    if (post.status === BUFFER_SENT_STATUS) return 'published';
    return post.status === BUFFER_DRAFT_STATUS ? 'not_found' : 'unknown';
  }

  costEstimate(_d: Draft<LinkedinPayload>): number {
    return 0;
  }

  // ------------------------------------------------------------------ internals

  async #probe(account: string, purpose: 'probe' | 'publish'): Promise<Health> {
    const apiKey = this.#storedKey(account);
    if (apiKey === null) {
      return { state: 'not_configured', nextAction: 'Connect Buffer with an API key from publish.buffer.com/settings/api.' };
    }
    const organizationId = this.#deps.config().platforms.buffer?.organizationId;
    if (organizationId === undefined) {
      return { state: 'not_configured', nextAction: 'Reconnect Buffer so the organization can be looked up once.' };
    }
    let channels: BufferChannel[];
    try {
      channels = await this.#client(apiKey).channels(organizationId, { purpose });
    } catch (error) {
      if (isRejectedKey(error)) {
        const health = rejectedKey();
        this.#keep(account, { health, channels: this.#cached(account)?.channels ?? [], checkedAt: this.#deps.now().toISOString() });
        return health;
      }
      throw error;
    }
    return this.#remember(account, channels, this.#deps.config().platforms.linkedin?.bufferChannelId);
  }

  /** The cached probe for `account`, read from the store on first use after a restart. */
  #cached(account: string): Cached | undefined {
    if (!this.#loaded.has(account)) {
      this.#loaded.add(account);
      const raw = this.#deps.store?.get(cacheKey(account));
      if (raw !== undefined && !this.#cache.has(account)) {
        try {
          const parsed = JSON.parse(raw) as Cached;
          if (typeof parsed.health?.state === 'string' && Array.isArray(parsed.channels) && typeof parsed.checkedAt === 'string') {
            this.#cache.set(account, parsed);
          }
        } catch {
          // An unreadable cache is the same as none: the next probe rebuilds it.
        }
      }
    }
    return this.#cache.get(account);
  }

  #keep(account: string, cached: Cached): void {
    this.#loaded.add(account);
    this.#cache.set(account, cached);
    this.#deps.store?.set(cacheKey(account), JSON.stringify(cached));
  }

  /** Works out the health for `channels` against the mapped channel, and caches both. */
  #remember(account: string, channels: BufferChannel[], mappedId: string | undefined, checkedAt?: string): Health {
    const health = evaluate(channels, mappedId);
    this.#keep(account, { health, channels, checkedAt: checkedAt ?? this.#deps.now().toISOString() });
    return health;
  }

  /** The stage came back as something other than a draft: delete it at once and say so loudly. */
  async #undoNonDraft(client: BufferClient, d: Draft<LinkedinPayload>, post: { id: string; status: string }): Promise<never> {
    let deleted = true;
    try {
      await client.deletePost(post.id);
    } catch {
      deleted = false;
    }
    const reason = deleted ? BUFFER_NOT_DRAFT_DELETED : BUFFER_NOT_DRAFT_KEPT;
    this.#deps.markFailed(d.id, reason);
    this.#deps.audit({
      actorChannel: ACTOR,
      action: 'buffer_stage_not_draft',
      draftId: d.id,
      platform: 'linkedin',
      detail: { postId: post.id, status: post.status, expected: BUFFER_DRAFT_STATUS, deleted },
    });
    this.#deps.alert(
      deleted
        ? { level: 'warning', title: 'Buffer stage was not a draft', message: reason }
        : { level: 'critical', title: 'A Buffer post may be queued or live', message: reason, link: BUFFER_PUBLISH_URL },
    );
    throw new BufferStageError(reason);
  }

  #client(apiKey: string): BufferClient {
    return new BufferClient(apiKey, this.#deps.fetchFn, this.#deps.budget, this.#deps.now);
  }

  #storedKey(account: string): string | null {
    const apiKey = this.#deps.secrets.get(SECRET_PLATFORM, account)?.['apiKey'];
    return apiKey === undefined || apiKey === '' ? null : apiKey;
  }

  #requireKey(account: string): string {
    const apiKey = this.#storedKey(account);
    if (apiKey === null) throw new Error(`Buffer is not connected for account "${account}"; connect it first`);
    return apiKey;
  }

  #channelId(): string {
    const id = this.#deps.config().platforms.linkedin?.bufferChannelId;
    if (id === undefined) {
      throw new GateError('UNHEALTHY', 'no LinkedIn channel is mapped; choose one in the dashboard', { state: 'not_configured' });
    }
    return id;
  }
}

/** The Buffer link card, only when the payload carries one. */
function linkMetadata(p: LinkedinPayload): Pick<BufferCreatePostInput, 'metadata'> {
  return p.link === undefined ? {} : { metadata: { linkedin: { linkAttachment: { ...p.link } } } };
}

function evaluate(channels: BufferChannel[], mappedId: string | undefined): Health {
  if (mappedId === undefined) {
    return {
      state: 'not_configured',
      detail: 'Buffer is connected, but no LinkedIn channel is chosen yet.',
      nextAction: 'Choose the LinkedIn channel to use in the dashboard.',
    };
  }
  const channel = channels.find((c) => c.id === mappedId);
  if (channel === undefined || channel.isDisconnected === true) {
    return {
      state: 'needs_reconnect',
      detail: channel === undefined ? 'The mapped LinkedIn channel is not in Buffer any more.' : 'Buffer reports the LinkedIn channel as disconnected.',
      nextAction: BUFFER_RECONNECT_ACTION,
    };
  }
  return { state: 'connected', who: channel.name };
}

const isRejectedKey = (error: unknown): boolean => error instanceof PlatformError && (error.status === 401 || error.status === 403);

const rejectedKey = (): Health => ({
  state: 'needs_reconnect',
  detail: 'Buffer rejected the API key.',
  nextAction: 'Create a new API key at publish.buffer.com/settings/api and reconnect.',
});
