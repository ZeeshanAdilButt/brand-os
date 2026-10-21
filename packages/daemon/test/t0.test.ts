import { describe, expect, it } from 'vitest';
import { computeT0, LATE_DEPLOY_WINDOW_DAYS } from '../src/t0.js';

describe('computeT0 (spec 2.3)', () => {
  it('returns null until the post has been seen live', () => {
    expect(computeT0('2026-07-19', null, 'UTC')).toBeNull();
  });

  it('a 3-month-old post first seen live today gets T0 = its frontmatter date at 00:00', () => {
    const t0 = computeT0('2026-07-19', '2026-10-19T10:00:00.000Z', 'UTC');
    expect(t0).toBe('2026-07-19T00:00:00.000Z');
    // dev.to notBefore = T0 + 48 h is long past, so nothing is blocked for no reason
    expect(Date.parse(t0 as string) + 48 * 3_600_000).toBeLessThan(Date.parse('2026-10-19T10:00:00.000Z'));
  });

  it('a post dated today but first seen live 3 days later (late deploy) gets T0 = canonical_live_at', () => {
    expect(computeT0('2026-10-19', '2026-10-22T09:30:00.000Z', 'UTC')).toBe('2026-10-22T09:30:00.000Z');
  });

  it('a post seen live the same day gets T0 = the frontmatter date', () => {
    expect(computeT0('2026-10-19', '2026-10-19T14:00:00.000Z', 'UTC')).toBe('2026-10-19T00:00:00.000Z');
  });

  it('a post seen live exactly 1 day after its date is not a late deploy; more than 1 day is', () => {
    expect(computeT0('2026-10-19', '2026-10-20T00:00:00.000Z', 'UTC')).toBe('2026-10-19T00:00:00.000Z');
    expect(computeT0('2026-10-19', '2026-10-20T00:00:00.001Z', 'UTC')).toBe('2026-10-20T00:00:00.001Z');
  });

  it('a gap beyond the late-deploy window means the post was already live before install: T0 = its date', () => {
    expect(LATE_DEPLOY_WINDOW_DAYS).toBe(30);
    expect(computeT0('2026-09-19', '2026-10-19T00:00:00.000Z', 'UTC')).toBe('2026-10-19T00:00:00.000Z'); // exactly 30 days
    expect(computeT0('2026-09-19', '2026-10-19T00:00:00.001Z', 'UTC')).toBe('2026-09-19T00:00:00.000Z');
  });

  it('a post seen live before its own date uses canonical_live_at, the earlier time (min)', () => {
    expect(computeT0('2026-10-19', '2026-10-18T20:00:00.000Z', 'UTC')).toBe('2026-10-18T20:00:00.000Z');
  });

  it('reads the frontmatter date as midnight in the site time zone', () => {
    // Karachi is UTC+5 all year: local 00:00 on 2026-07-19 is 19:00 UTC the day before
    expect(computeT0('2026-07-19', '2026-10-19T10:00:00.000Z', 'Asia/Karachi')).toBe('2026-07-18T19:00:00.000Z');
    // New York in July is UTC-4 (summer time), in January UTC-5
    expect(computeT0('2026-07-19', '2026-10-19T10:00:00.000Z', 'America/New_York')).toBe('2026-07-19T04:00:00.000Z');
    expect(computeT0('2026-01-19', '2026-10-19T10:00:00.000Z', 'America/New_York')).toBe('2026-01-19T05:00:00.000Z');
  });

  it('finds local midnight on a day when the clocks change', () => {
    // US spring forward is 2026-03-08 at 02:00 local: midnight is still UTC-5
    expect(computeT0('2026-03-08', '2026-10-19T10:00:00.000Z', 'America/New_York')).toBe('2026-03-08T05:00:00.000Z');
    // US fall back is 2026-11-01 at 02:00 local: midnight is still UTC-4
    expect(computeT0('2026-11-01', '2026-12-19T10:00:00.000Z', 'America/New_York')).toBe('2026-11-01T04:00:00.000Z');
  });

  it('rejects malformed input instead of guessing', () => {
    expect(() => computeT0('19/07/2026', '2026-10-19T10:00:00.000Z', 'UTC')).toThrow(RangeError);
    expect(() => computeT0('2026-02-30', '2026-10-19T10:00:00.000Z', 'UTC')).toThrow(RangeError);
    expect(() => computeT0('2026-07-19', 'yesterday', 'UTC')).toThrow(RangeError);
    expect(() => computeT0('2026-07-19', '2026-10-19T10:00:00.000Z', 'Not/AZone')).toThrow(RangeError);
  });
});
