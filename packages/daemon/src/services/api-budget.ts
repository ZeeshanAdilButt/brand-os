import type { BudgetWindow, Repos } from '../db/repos.js';

export type BudgetProvider = 'buffer';

/**
 * Why a call is being made. A `publish` is never refused by the budget guard, so the last of the
 * quota is always kept for publishing. Everything else (including `recovery`, the read-back that
 * checks whether an `unknown` draft went out) is refused once less than 20% remains.
 */
export type BudgetPurpose = 'publish' | 'probe' | 'stage' | 'recovery' | 'other';

/** Buffer Free plan (verified on buffer.com/pricing, 2026-10-19): 100 per 15 min, 250 per 24 h, 3,000 per 30 d. */
export const BUFFER_FREE_LIMITS: Readonly<Record<BudgetWindow, number>> = { '15m': 100, '24h': 250, '30d': 3000 };

/**
 * The response headers that carry Buffer's remaining quota, per window.
 *
 * UNVERIFIED until S2(i): these names are a best guess. If Buffer sends none of them, nothing
 * breaks: `ApiBudget` also counts every call itself, so the guard works on local counts alone.
 * A reset value may be seconds from now, epoch seconds, or a date string; all three are read.
 */
export const BUFFER_QUOTA_HEADERS: Readonly<Record<BudgetWindow, { limit: string; remaining: string; reset: string }>> = {
  '15m': { limit: 'x-ratelimit-limit-15m', remaining: 'x-ratelimit-remaining-15m', reset: 'x-ratelimit-reset-15m' },
  '24h': { limit: 'x-ratelimit-limit-24h', remaining: 'x-ratelimit-remaining-24h', reset: 'x-ratelimit-reset-24h' },
  '30d': { limit: 'x-ratelimit-limit-30d', remaining: 'x-ratelimit-remaining-30d', reset: 'x-ratelimit-reset-30d' },
};

/** Non-publish calls are refused when less than this share of the 24 h or 30 d budget remains. */
export const LOW_BUDGET_FRACTION = 0.2;

const WINDOW_MS: Readonly<Record<BudgetWindow, number>> = {
  '15m': 15 * 60_000,
  '24h': 24 * 3_600_000,
  '30d': 30 * 86_400_000,
};
const WINDOWS: readonly BudgetWindow[] = ['15m', '24h', '30d'];

const HEADER_MAP: Readonly<Record<BudgetProvider, typeof BUFFER_QUOTA_HEADERS>> = { buffer: BUFFER_QUOTA_HEADERS };
const PLAN_LIMITS: Readonly<Record<BudgetProvider, Readonly<Record<BudgetWindow, number>>>> = { buffer: BUFFER_FREE_LIMITS };

export interface WindowQuota {
  limit: number;
  remaining: number;
}
export interface BudgetSnapshot {
  m15: WindowQuota;
  d1: WindowQuota;
  d30: WindowQuota;
}

/**
 * Tracks how much of a provider's API quota is left, from two sources, and trusts the stricter:
 *
 * - the remaining-quota headers on the provider's responses (stored in the `api_budget` table); a
 *   reported value counts only until its reset time;
 * - the calls this daemon made itself, kept as timestamps in the `settings` table so a restart does
 *   not forget them, counted per sliding window.
 *
 * `record` is called once after every request (also after a failed one: a request that went out
 * may have been counted by the provider), so it is also the call counter.
 */
export class ApiBudget {
  readonly #repos: Repos;
  readonly #now: () => Date;

  constructor(repos: Repos, now: () => Date) {
    this.#repos = repos;
    this.#now = now;
  }

  record(provider: BudgetProvider, headers: Headers): void {
    const at = this.#now().getTime();
    const horizon = at - WINDOW_MS['30d'];
    const calls = this.#calls(provider).filter((t) => t > horizon);
    calls.push(at);
    this.#repos.settings.set(callsKey(provider), JSON.stringify(calls));

    const known = new Map(this.#repos.apiBudget.get(provider).map((row) => [row.window, row]));
    for (const window of WINDOWS) {
      const names = HEADER_MAP[provider][window];
      const remaining = wholeNumber(headers.get(names.remaining));
      if (remaining === undefined) continue;
      const limit = wholeNumber(headers.get(names.limit)) ?? known.get(window)?.limit ?? PLAN_LIMITS[provider][window];
      const resetsAt = parseReset(headers.get(names.reset), at) ?? at + WINDOW_MS[window];
      this.#repos.apiBudget.record(provider, window, limit, remaining, new Date(resetsAt).toISOString());
    }
  }

  /** `false` when a non-publish call should be refused to keep the rest of the quota for publishing. */
  allows(provider: BudgetProvider, purpose: BudgetPurpose): boolean {
    if (purpose === 'publish') return true;
    const { d1, d30 } = this.snapshot(provider);
    return d1.remaining >= d1.limit * LOW_BUDGET_FRACTION && d30.remaining >= d30.limit * LOW_BUDGET_FRACTION;
  }

  snapshot(provider: BudgetProvider): BudgetSnapshot {
    const at = this.#now().getTime();
    const calls = this.#calls(provider);
    const rows = new Map(this.#repos.apiBudget.get(provider).map((row) => [row.window, row]));
    const quota = (window: BudgetWindow): WindowQuota => {
      const row = rows.get(window);
      const limit = row?.limit ?? PLAN_LIMITS[provider][window];
      const used = calls.filter((t) => t > at - WINDOW_MS[window]).length;
      let remaining = Math.max(0, limit - used);
      if (row !== undefined && Date.parse(row.resetsAt) > at) remaining = Math.min(remaining, row.remaining);
      return { limit, remaining };
    };
    return { m15: quota('15m'), d1: quota('24h'), d30: quota('30d') };
  }

  #calls(provider: BudgetProvider): number[] {
    const raw = this.#repos.settings.get(callsKey(provider));
    if (raw === undefined) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((t): t is number => typeof t === 'number' && Number.isFinite(t)) : [];
    } catch {
      return [];
    }
  }
}

const callsKey = (provider: BudgetProvider): string => `api_calls:${provider}`;

function wholeNumber(value: string | null): number | undefined {
  if (value === null || !/^\s*\d+\s*$/.test(value)) return undefined;
  return Number(value);
}

/** A reset as epoch ms: seconds from now, epoch seconds, epoch ms, or a date string. */
function parseReset(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const n = Number(text);
    if (n < 1e9) return now + n * 1000;
    return n < 1e12 ? n * 1000 : n;
  }
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : at;
}
