import type { ErrorKind } from '../../lib/publishing';

/**
 * A failed platform call. `message` is written for a person and has had keys removed. `detail` is the
 * platform's own words (validation messages) after the same cleaning, shown as given.
 */
export class PlatformError extends Error {
  readonly httpStatus: number | null;
  readonly retryAfterMs: number | null;
  readonly detail: string | null;

  constructor(
    readonly kind: ErrorKind,
    message: string,
    options: { httpStatus?: number | null; retryAfterMs?: number | null; detail?: string | null } = {},
  ) {
    super(message);
    this.name = 'PlatformError';
    this.httpStatus = options.httpStatus ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.detail = options.detail ?? null;
  }

  /**
   * After a request that changes something was sent: could it have taken effect? A clear refusal (the
   * key, the plan, the content, the rate limit, a missing thing) says no. A dropped connection, a
   * timeout, a server error, a redirect or an answer we cannot read says maybe, and "maybe" is never
   * treated as "no".
   */
  get ambiguous(): boolean {
    return this.kind === 'server' || this.kind === 'timeout' || this.kind === 'network' || this.kind === 'redirect' || this.kind === 'protocol';
  }

  /** Worth another try for a private, repeatable call (staging): the failure is on the platform's side or the wire. */
  get transient(): boolean {
    if (this.kind === 'rate_limit') return (this.retryAfterMs ?? 30_000) <= 10_000;
    return this.kind === 'server' || this.kind === 'network' || this.kind === 'timeout';
  }
}
