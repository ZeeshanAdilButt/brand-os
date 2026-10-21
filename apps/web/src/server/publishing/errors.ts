import type { ErrorKind } from '../../lib/publishing';

/**
 * A failed platform call. `message` is written for a person and has had keys removed. `detail` is the
 * platform's own words (validation messages) after the same cleaning, shown as given.
 */
export class PlatformError extends Error {
  readonly httpStatus: number | null;
  readonly retryAfterMs: number | null;
  readonly detail: string | null;
  /** True when the failure happened before anything that changes state was transmitted (a read that failed first). */
  readonly notSent: boolean;

  constructor(
    readonly kind: ErrorKind,
    message: string,
    options: { httpStatus?: number | null; retryAfterMs?: number | null; detail?: string | null; notSent?: boolean } = {},
  ) {
    super(message);
    this.name = 'PlatformError';
    this.httpStatus = options.httpStatus ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.detail = options.detail ?? null;
    this.notSent = options.notSent ?? false;
  }

  /**
   * After a request that changes something was sent: could it have taken effect? A clear refusal (the
   * key, the plan, the content, the rate limit, a missing thing) says no. A dropped connection, a
   * timeout, a server error, a redirect or an answer we cannot read says maybe, and "maybe" is never
   * treated as "no".
   */
  get ambiguous(): boolean {
    if (this.notSent) return false;
    return this.kind === 'server' || this.kind === 'timeout' || this.kind === 'network' || this.kind === 'redirect' || this.kind === 'protocol';
  }

  /** The same failure, marked as having happened before the state-changing request was sent. */
  asNotSent(): PlatformError {
    return new PlatformError(this.kind, this.message, { httpStatus: this.httpStatus, retryAfterMs: this.retryAfterMs, detail: this.detail, notSent: true });
  }

  /** Worth another try for a private, repeatable call (staging): the failure is on the platform's side or the wire. */
  get transient(): boolean {
    if (this.kind === 'rate_limit') return (this.retryAfterMs ?? 30_000) <= 10_000;
    return this.kind === 'server' || this.kind === 'network' || this.kind === 'timeout';
  }
}
