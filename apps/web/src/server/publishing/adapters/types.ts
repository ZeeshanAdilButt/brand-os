import type { DraftPayload, LintIssue, PlatformId, PlatformInfo, TagReport } from '../../../lib/publishing';
import type { PlatformConnection } from '../../db/schema';

/** What an adapter needs for one call. The key is in memory only for the length of the call. */
export interface AdapterContext {
  /** The plain-text key. Never logged, never placed in a message. */
  secret: string;
  /** Non-secret settings from the connection (the Hashnode publication). */
  config: PlatformConnection['config'];
  fetch: typeof fetch;
  now: () => Date;
  baseUrl: string;
  timeoutMs: number;
}

/** The part of a draft an adapter sees. */
export interface AdapterDraft {
  id: string;
  payload: DraftPayload;
  /** The private copy on the platform, if one exists. */
  remoteId: string | null;
}

/** What the person typed or the article holds, before the platform's rules are applied. */
export interface AdaptInput {
  title: string;
  description: string;
  tags: string[];
  canonicalUrl: string | null;
  coverImageUrl: string | null;
  series: string | null;
  bodyMarkdown: string;
}

export interface HealthResult {
  /** Who the platform says the key belongs to, for display. */
  who: string;
  /** Non-secret things found by the probe, stored on the connection. */
  config?: PlatformConnection['config'];
}

export interface StageResult {
  remoteId: string;
  /** Where the owner can look at the private copy, when the platform gives a link. */
  previewUrl: string | null;
}

export interface PublishResult {
  remoteId: string;
  remoteUrl: string | null;
}

export type CheckResult =
  | { state: 'published'; remoteId: string | null; remoteUrl: string | null }
  /** Found, and private: it did not go live. */
  | { state: 'private' }
  /** Looked for and could not be found where it should be. Not proof that it never went out. */
  | { state: 'not_found' };

/**
 * One publishing destination. Every method that sends something is called by the service at most once
 * per user action: `stage` may be retried by the service (private, repeatable), `publish` never is.
 * Methods throw PlatformError with a classified kind; they never put the key in a message.
 */
export interface PlatformAdapter {
  readonly id: PlatformId;
  readonly info: PlatformInfo;
  /** Apply the platform's rules to the article text: tag form and count, footers, series. Pure. */
  adapt(input: AdaptInput): { payload: DraftPayload; tagReport: TagReport };
  /** Platform-specific problems in an adapted payload. Pure. */
  validate(payload: DraftPayload): LintIssue[];
  /** The JSON that will be sent, so the approval card shows it exactly. `published` is what the call will set. Pure. */
  preview(payload: DraftPayload, published: boolean, config: PlatformConnection['config'], remoteId?: string | null): unknown;
  /** Read-only probe: who is this key, and can it reach what we need? */
  health(ctx: AdapterContext): Promise<HealthResult>;
  /**
   * Create or update the PRIVATE copy (`published: false`). It must read the remote article first when it
   * is updating one and refuse to touch a live one.
   */
  stage(ctx: AdapterContext, draft: AdapterDraft): Promise<StageResult>;
  /** Make the staged copy public with exactly the approved payload. The only method that can. */
  publish(ctx: AdapterContext, draft: AdapterDraft): Promise<PublishResult>;
  /** Read-only: is it live, private or missing? Never changes anything. */
  check(ctx: AdapterContext, draft: AdapterDraft): Promise<CheckResult>;
}
