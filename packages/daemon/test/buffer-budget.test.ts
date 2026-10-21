import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.js';
import { createRepos, type Repos } from '../src/db/repos.js';
import { ApiBudget, BUFFER_FREE_LIMITS, BUFFER_QUOTA_HEADERS, type BudgetPurpose } from '../src/services/api-budget.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

type Window = '15m' | '24h' | '30d';

let db: Db;
let repos: Repos;
let clock: Date;
let budget: ApiBudget;

const now = (): Date => clock;
const advance = (ms: number): void => {
  clock = new Date(clock.getTime() + ms);
};

/** Quota headers as Buffer is assumed to send them (the names live in BUFFER_QUOTA_HEADERS). */
function quota(windows: Partial<Record<Window, { limit: number; remaining: number; resetInSeconds?: number }>>): Headers {
  const headers = new Headers();
  for (const [window, q] of Object.entries(windows)) {
    const names = BUFFER_QUOTA_HEADERS[window as Window];
    headers.set(names.limit, String(q.limit));
    headers.set(names.remaining, String(q.remaining));
    if (q.resetInSeconds !== undefined) headers.set(names.reset, String(q.resetInSeconds));
  }
  return headers;
}

beforeEach(() => {
  clock = new Date('2026-10-19T10:00:00.000Z');
  db = openDb(':memory:');
  repos = createRepos(db, { now: () => clock.toISOString() });
  budget = new ApiBudget(repos, now);
});

afterEach(() => {
  db.close();
});

describe('ApiBudget without any headers (local counting)', () => {
  it('starts at the Free plan limits with everything remaining', () => {
    expect(BUFFER_FREE_LIMITS).toEqual({ '15m': 100, '24h': 250, '30d': 3000 });
    expect(budget.snapshot('buffer')).toEqual({
      m15: { limit: 100, remaining: 100 },
      d1: { limit: 250, remaining: 250 },
      d30: { limit: 3000, remaining: 3000 },
    });
  });

  it('counts each recorded call against every window', () => {
    for (let i = 0; i < 7; i++) budget.record('buffer', new Headers());
    expect(budget.snapshot('buffer')).toEqual({
      m15: { limit: 100, remaining: 93 },
      d1: { limit: 250, remaining: 243 },
      d30: { limit: 3000, remaining: 2993 },
    });
  });

  it('lets calls age out of each window on its own clock', () => {
    for (let i = 0; i < 10; i++) budget.record('buffer', new Headers());
    advance(16 * MIN);
    expect(budget.snapshot('buffer').m15.remaining).toBe(100);
    expect(budget.snapshot('buffer').d1.remaining).toBe(240);
    advance(DAY);
    expect(budget.snapshot('buffer').d1.remaining).toBe(250);
    expect(budget.snapshot('buffer').d30.remaining).toBe(2990);
    advance(30 * DAY);
    expect(budget.snapshot('buffer').d30.remaining).toBe(3000);
  });

  it('keeps its count across a daemon restart (a new ApiBudget over the same database)', () => {
    for (let i = 0; i < 5; i++) budget.record('buffer', new Headers());
    const after = new ApiBudget(repos, now);
    expect(after.snapshot('buffer').d1.remaining).toBe(245);
  });

  it('refuses non-publish purposes below 20% of the 24 h budget, and still allows a publish', () => {
    for (let i = 0; i < 200; i++) budget.record('buffer', new Headers()); // 50 of 250 left = 20%
    expect(budget.allows('buffer', 'probe')).toBe(true);
    budget.record('buffer', new Headers()); // 49 of 250 left = 19.6%
    for (const purpose of ['probe', 'stage', 'other'] as BudgetPurpose[]) {
      expect(budget.allows('buffer', purpose)).toBe(false);
    }
    expect(budget.allows('buffer', 'publish')).toBe(true);
  });
});

describe('ApiBudget with remaining-quota headers', () => {
  it('stores what the headers report in the api_budget table', () => {
    budget.record('buffer', quota({ '24h': { limit: 250, remaining: 40, resetInSeconds: 3600 }, '30d': { limit: 3000, remaining: 2500 } }));
    const rows = repos.apiBudget.get('buffer');
    expect(rows.map((r) => [r.window, r.limit, r.remaining])).toEqual([
      ['24h', 250, 40],
      ['30d', 3000, 2500],
    ]);
    expect(rows[0]?.resetsAt).toBe(new Date(clock.getTime() + 3600_000).toISOString());
  });

  it('40 of 250 left in 24 h is below 20%, so non-publish purposes are refused and publish is not', () => {
    budget.record('buffer', quota({ '24h': { limit: 250, remaining: 40, resetInSeconds: 3600 } }));
    expect(budget.snapshot('buffer').d1).toEqual({ limit: 250, remaining: 40 });
    expect(budget.allows('buffer', 'probe')).toBe(false);
    expect(budget.allows('buffer', 'stage')).toBe(false);
    expect(budget.allows('buffer', 'other')).toBe(false);
    expect(budget.allows('buffer', 'publish')).toBe(true);
  });

  it('refuses when only the 30 d budget is low', () => {
    budget.record('buffer', quota({ '30d': { limit: 3000, remaining: 500, resetInSeconds: 10 * 86400 } }));
    expect(budget.allows('buffer', 'probe')).toBe(false);
  });

  it('uses the stricter of the header value and the local count', () => {
    // Headers say plenty is left, but our own records say 211 calls were made in 24 h.
    for (let i = 0; i < 210; i++) budget.record('buffer', new Headers());
    budget.record('buffer', quota({ '24h': { limit: 250, remaining: 200, resetInSeconds: 3600 } }));
    expect(budget.snapshot('buffer').d1.remaining).toBe(250 - 211);
    expect(budget.allows('buffer', 'probe')).toBe(false);
  });

  it('a header value below the local count wins (calls made by other tools with the same key)', () => {
    budget.record('buffer', quota({ '24h': { limit: 250, remaining: 100, resetInSeconds: 3600 } }));
    expect(budget.snapshot('buffer').d1.remaining).toBe(100);
  });

  it('ignores a header remaining once its reset time has passed', () => {
    budget.record('buffer', quota({ '24h': { limit: 250, remaining: 40, resetInSeconds: 600 } }));
    expect(budget.allows('buffer', 'probe')).toBe(false);
    advance(11 * MIN);
    expect(budget.snapshot('buffer').d1.remaining).toBe(249);
    expect(budget.allows('buffer', 'probe')).toBe(true);
  });

  it('takes a larger plan limit from the headers', () => {
    budget.record('buffer', quota({ '30d': { limit: 7500, remaining: 7400, resetInSeconds: 86400 } }));
    expect(budget.snapshot('buffer').d30.limit).toBe(7500);
  });

  it('accepts a reset given as epoch seconds or as an ISO date, and survives junk values', () => {
    const names = BUFFER_QUOTA_HEADERS['24h'];
    const epoch = Math.floor((clock.getTime() + 2 * HOUR) / 1000);
    budget.record('buffer', new Headers({ [names.limit]: '250', [names.remaining]: '90', [names.reset]: String(epoch) }));
    expect(repos.apiBudget.get('buffer')[0]?.resetsAt).toBe(new Date(epoch * 1000).toISOString());

    const iso = new Date(clock.getTime() + 3 * HOUR).toISOString();
    budget.record('buffer', new Headers({ [names.limit]: '250', [names.remaining]: '80', [names.reset]: iso }));
    expect(repos.apiBudget.get('buffer')[0]?.resetsAt).toBe(iso);

    budget.record('buffer', new Headers({ [names.limit]: 'abc', [names.remaining]: 'NaN', [names.reset]: 'soon' }));
    expect(repos.apiBudget.get('buffer')[0]?.remaining).toBe(80); // junk changes nothing
    expect(budget.snapshot('buffer').d1.remaining).toBeLessThanOrEqual(80);
  });

  it('only some windows reported is fine', () => {
    budget.record('buffer', quota({ '15m': { limit: 100, remaining: 99, resetInSeconds: 60 } }));
    expect(budget.snapshot('buffer').m15).toEqual({ limit: 100, remaining: 99 });
    expect(budget.snapshot('buffer').d1.remaining).toBe(249);
  });
});
