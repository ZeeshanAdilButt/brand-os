/**
 * A small in-memory sliding-window limiter. It is per process, which is right for local mode and a
 * single hosted instance; a multi-instance deployment needs a shared store (noted in DECISIONS.md).
 */
export interface LimitResult {
  ok: boolean;
  /** Whole seconds until a request would be allowed, 0 when ok. */
  retryAfterSec: number;
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Count one request against `key`. */
  take(key: string): LimitResult {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 5_000) this.prune(now);
    return { ok: true, retryAfterSec: 0 };
  }

  private prune(now: number) {
    for (const [key, times] of this.hits) {
      if (times.every((t) => now - t >= this.windowMs)) this.hits.delete(key);
    }
  }
}

export interface AgentLimiters {
  /** Requests per credential. */
  perCredential: RateLimiter;
  /** Failed sign-in attempts per client, so guessing secrets is slow. */
  failures: RateLimiter;
}

export function defaultLimiters(): AgentLimiters {
  return { perCredential: new RateLimiter(120, 60_000), failures: new RateLimiter(20, 60_000) };
}
