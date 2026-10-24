import { redactSecrets } from '../ai/redact';
import { PlatformError } from '../publishing/errors';
import { clean, explanationFrom, parseRetryAfter, send, waitText, type HttpResult, DEFAULT_RETRY_AFTER_MS } from '../publishing/http';
import { nowOf, timeoutOf, type ConnectEnv } from './env';

/**
 * Why a check or a sign-in step failed, as a short code the database can keep and a sentence a person can read. The
 * sentence never contains a secret: every message passes through `redactSecrets` with the secrets in play.
 */
export type FailureCode =
  | 'rejected'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'unreachable'
  | 'provider_error'
  | 'bad_input'
  | 'unexpected'
  | 'expired'
  | 'denied'
  | 'unverified'
  | 'unavailable';

export class ConnectFailure extends Error {
  constructor(
    readonly code: FailureCode,
    message: string,
    readonly options: { retryAfterMs?: number | null; httpStatus?: number | null } = {},
  ) {
    super(message);
    this.name = 'ConnectFailure';
  }
  get retryAfterMs(): number | null {
    return this.options.retryAfterMs ?? null;
  }
}

/** A PlatformError from the shared request helper, as a ConnectFailure. */
export function fromPlatformError(err: unknown): ConnectFailure {
  if (err instanceof ConnectFailure) return err;
  if (err instanceof PlatformError) {
    const code: FailureCode =
      err.kind === 'auth' ? 'rejected' : err.kind === 'forbidden_plan' ? 'forbidden' : err.kind === 'rate_limit' ? 'rate_limited' : err.kind === 'not_found' ? 'not_found' : err.kind === 'validation' ? 'bad_input' : err.kind === 'server' ? 'provider_error' : err.kind === 'config' ? 'unavailable' : err.kind === 'protocol' ? 'unexpected' : 'unreachable';
    return new ConnectFailure(code, err.message, { retryAfterMs: err.retryAfterMs, httpStatus: err.httpStatus });
  }
  return new ConnectFailure('unexpected', 'The check failed for a reason this app does not know.');
}

export interface CallOptions {
  /** Strings that must never appear in a message. */
  secrets: readonly string[];
  /** The fetch to use. Defaults to the injected one, then the global one. */
  fetch?: typeof fetch | undefined;
}

/** One HTTP request with the shared rules: a timeout, no redirects, and every wire failure turned into a ConnectFailure. */
export async function call(env: ConnectEnv, url: string, init: { method: string; headers: Record<string, string>; body?: string }, options: CallOptions): Promise<HttpResult> {
  try {
    return await send({ fetch: options.fetch ?? env.fetchFn ?? fetch, timeoutMs: timeoutOf(env), secrets: options.secrets, now: () => nowOf(env) }, url, init);
  } catch (err) {
    throw fromPlatformError(err);
  }
}

/**
 * A non-2xx answer as a ConnectFailure. `what` names what was refused: "key", "sign-in" or "webhook address".
 */
export function refusal(name: string, what: string, res: HttpResult, env: ConnectEnv, secrets: readonly string[]): ConnectFailure {
  const detail = explanationFrom(res.text);
  const cleaned = detail ? clean(detail, secrets, 200) : null;
  const options = { httpStatus: res.status };
  if (res.status === 401) return new ConnectFailure('rejected', `${name} did not accept the ${what}. It may have been revoked or have expired.`, options);
  if (res.status === 403) return new ConnectFailure('forbidden', `${name} refused the ${what}: it is not allowed to do this${cleaned ? ` (${cleaned})` : ''}.`, options);
  if (res.status === 404) return new ConnectFailure('not_found', `${name} could not find what the ${what} points to. Check the address.`, options);
  if (res.status === 429) {
    const wait = parseRetryAfter(res.headers.get('retry-after'), nowOf(env)) ?? DEFAULT_RETRY_AFTER_MS;
    return new ConnectFailure('rate_limited', `${name} is rate limiting requests. Wait ${waitText(wait)} and try again.`, { ...options, retryAfterMs: wait });
  }
  if (res.status >= 500) return new ConnectFailure('provider_error', `${name} had a problem on its side (HTTP ${res.status}). Try again later.`, options);
  return new ConnectFailure('bad_input', cleaned ? `${name} refused the request: ${cleaned}` : `${name} refused the request (HTTP ${res.status}).`, options);
}

export function jsonOf(res: HttpResult): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(res.text);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** An answer that is not the JSON the platform documents. */
export function unreadable(name: string): ConnectFailure {
  return new ConnectFailure('unexpected', `${name} answered with something this app could not read.`);
}

/** Make a message safe: secrets and anything key-shaped removed, whitespace collapsed. */
export function safeMessage(message: string, secrets: readonly string[]): string {
  return redactSecrets(message, secrets).replace(/\s+/g, ' ').trim().slice(0, 400);
}
