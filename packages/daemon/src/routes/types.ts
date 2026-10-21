import type { Draft, PlatformId, RouteKind } from '@cph/core';
import type { VerifiedApproval } from '../gate/verified.js';

export interface Health {
  state: 'connected' | 'expiring' | 'needs_reconnect' | 'not_configured' | 'manual_only';
  who?: string;
  detail?: string;
  nextAction?: string;
}

export interface RemoteRef {
  remoteId: string;
  previewUrl?: string;
}

export interface Publication {
  remoteId: string;
  remoteUrl?: string;
  costUsd: number;
}

/** What an assist route (T0.16) hands the user: text for the clipboard, a page to open, steps to follow. */
export interface AssistKit {
  copiedText: string;
  openUrl: string;
  checklist: string[];
}

/**
 * One way of getting a draft onto a platform. `publish` is the only method that may make content
 * public, and it takes a `VerifiedApproval`, which only the approval gate can mint.
 */
export interface Route<P> {
  readonly kind: RouteKind;
  readonly platform: PlatformId;
  health(account: string): Promise<Health>;
  /** Validates the credentials against the platform, then stores the secret. */
  connect?(account: string, input: Record<string, string>): Promise<Health>;
  /** Puts a private copy of the draft on the platform. Never makes anything public. */
  stage?(d: Draft<P>): Promise<RemoteRef>;
  publish(d: Draft<P>, a: VerifiedApproval): Promise<Publication>;
  /** Cancels a post that the platform itself is holding for a later time (T1.7). */
  cancelScheduled?(d: Draft<P>): Promise<void>;
  /** Asks the platform whether an `unknown` draft went out (T0.17). */
  checkOnPlatform?(d: Draft<P>): Promise<'published' | 'not_found' | 'unknown'>;
  /** Assist routes only: copies the text, opens the page and returns the steps. Gated like a publish. */
  handOff?(d: Draft<P>, a: VerifiedApproval): Promise<AssistKit>;
  costEstimate(d: Draft<P>): number;
}

/** A stage was refused before any change was made on the platform. */
export class StageRefused extends Error {
  override readonly name = 'StageRefused';
}

/** The platform answered with a non-success status. `message` and `body` never carry credentials. */
export class PlatformError extends Error {
  override readonly name = 'PlatformError';

  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
    readonly body?: string,
  ) {
    super(message);
  }
}

/**
 * Reads a `Retry-After` header: whole seconds, or an HTTP-date (turned into the wait from `now`,
 * never negative). Anything else, or a missing header, gives `undefined`.
 */
export function parseRetryAfter(header: string | null, now: Date): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!/[A-Za-z]/.test(value)) return undefined;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now.getTime());
}

/** Every platform request gives up after this long. A publish that times out is 'unknown', never retried. */
export const PLATFORM_TIMEOUT_MS = 30_000;

/**
 * The fetch options every platform request carries: `redirect: 'error'`, so the api-key or bearer
 * header is never replayed to another host by a redirect, and a timeout signal, so a hung request
 * ends (as an error the publish service treats as ambiguous) instead of hanging the publish.
 */
export function platformFetchOptions(timeoutMs: number = PLATFORM_TIMEOUT_MS): Pick<RequestInit, 'redirect' | 'signal'> {
  return { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) };
}
