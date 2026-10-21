const DAY_MS = 86_400_000;

/**
 * Spec 2.3 says a post first seen live MORE than 1 day after its date is a late deploy (T0 = the time
 * seen live), but also that a 3-month-old post first seen live on install day keeps T0 = its date. Both
 * cannot hold for the same rule on the inputs (date, first-seen-live) alone, so a late deploy is a gap
 * of more than 1 day and at most this many days. A longer gap is a post that was already live before
 * this tool was installed. Wrongly treating an old post as a late deploy only costs a 48 h wait from
 * install; the opposite mistake would syndicate a copy before the original is indexed.
 */
export const LATE_DEPLOY_WINDOW_DAYS = 30;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Wall-clock parts of an instant in `timeZone`, read back as if they were UTC. */
function wallClockAsUtc(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(instantMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
}

/** The UTC instant at which the wall clock in `timeZone` reads `date` 00:00. */
function midnightIn(date: string, timeZone: string): number {
  const match = CALENDAR_DATE.exec(date);
  if (match === null) throw new RangeError(`frontmatter date must be YYYY-MM-DD, got ${JSON.stringify(date)}`);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const naive = Date.UTC(year, month - 1, day);
  const check = new Date(naive);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new RangeError(`not a calendar date: ${JSON.stringify(date)}`);
  }
  // offset = wall clock minus real instant. It can differ between the guess and the answer when a
  // clock change falls between them, so settle it with a second pass.
  let instant = naive - (wallClockAsUtc(naive, timeZone) - naive);
  instant = naive - (wallClockAsUtc(instant, timeZone) - instant);
  return instant;
}

/**
 * The launch reference time T0 (spec 2.3), as an ISO string, or `null` until the post has been seen live.
 *
 * `canonical_live_at` is the first time THIS TOOL saw the post live, which for a post that was live
 * before install is install day, not the day it went live. So `T0 = min(frontmatter date at 00:00 in
 * the site time zone, canonical_live_at)`, except for a late deploy: when `canonical_live_at` is more
 * than 1 day (and at most `LATE_DEPLOY_WINDOW_DAYS`) after that date, `T0 = canonical_live_at`. A
 * 3-month-old post therefore has a T0 three months ago, and its dev.to `notBefore` (T0 + 48 h) is
 * already in the past.
 *
 * Throws `RangeError` for a malformed date, timestamp or time zone rather than guessing.
 */
export function computeT0(frontmatterDate: string, canonicalLiveAt: string | null, timeZone: string): string | null {
  const dateStart = midnightIn(frontmatterDate, timeZone);
  if (canonicalLiveAt === null) return null;
  const live = Date.parse(canonicalLiveAt);
  if (Number.isNaN(live)) throw new RangeError(`canonical_live_at is not a timestamp: ${JSON.stringify(canonicalLiveAt)}`);
  const gap = live - dateStart;
  if (gap > DAY_MS && gap <= LATE_DEPLOY_WINDOW_DAYS * DAY_MS) return canonicalLiveAt;
  return live < dateStart ? canonicalLiveAt : new Date(dateStart).toISOString();
}
