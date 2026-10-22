import type { PlatformId } from './catalog';

/**
 * The review queue behind "Approve and next". It walks the chosen destinations ONE AT A TIME, in the order the
 * owner set. At any moment at most one destination is under review or publishing; each approval is the owner's own
 * click on that destination's own exact payload. There is no function here, and no control built on it, that
 * approves more than one payload: `approveCurrent` names the single destination it applies to. After each
 * approval the outcome comes back; a failure or an unknown result stops the queue and leaves every other
 * destination untouched.
 */

export type ItemState = 'waiting' | 'review' | 'publishing' | 'published' | 'failed' | 'unknown' | 'skipped';

export interface QueueState {
  order: PlatformId[];
  items: Partial<Record<PlatformId, ItemState>>;
  /** Why the queue stopped, or null while it can go on. */
  stopped: { platform: PlatformId; reason: string } | null;
}

export function startQueue(order: readonly PlatformId[]): QueueState {
  const unique = [...new Set(order)];
  const items: QueueState['items'] = {};
  unique.forEach((platform, i) => {
    items[platform] = i === 0 ? 'review' : 'waiting';
  });
  return { order: unique, items, stopped: null };
}

/** The destination under review or publishing, if any. */
export function currentOf(state: QueueState): PlatformId | null {
  return state.order.find((p) => state.items[p] === 'review' || state.items[p] === 'publishing') ?? null;
}

/** The one destination the owner’s next approval click applies to. Null when the queue is stopped, finished or waiting on a result. */
export function approveCurrent(state: QueueState): PlatformId | null {
  if (state.stopped) return null;
  const current = currentOf(state);
  return current && state.items[current] === 'review' ? current : null;
}

/** The owner clicked approve for the current destination: it is now publishing. Nothing else changes. */
export function beginPublishing(state: QueueState, platform: PlatformId): QueueState {
  if (approveCurrent(state) !== platform) return state;
  return { ...state, items: { ...state.items, [platform]: 'publishing' } };
}

export type Outcome = 'published' | 'failed' | 'unknown';

const WHY: Record<'failed' | 'unknown', string> = {
  failed: 'The platform refused it, so nothing went out. The other destinations are untouched.',
  unknown: 'It may or may not have gone out. Check it on the platform before anything else. The other destinations are untouched.',
};

/** The result for the destination that was publishing. A success moves the queue to the next waiting destination; anything else stops it. */
export function settle(state: QueueState, platform: PlatformId, outcome: Outcome): QueueState {
  if (state.items[platform] !== 'publishing') return state;
  const items = { ...state.items, [platform]: outcome };
  if (outcome !== 'published') return { order: state.order, items, stopped: { platform, reason: WHY[outcome] } };
  const next = state.order.find((p) => items[p] === 'waiting');
  if (next) items[next] = 'review';
  return { order: state.order, items, stopped: null };
}

/** Leave the current destination for now and move on. It is not published and not marked as anything but skipped. */
export function skipCurrent(state: QueueState): QueueState {
  const current = approveCurrent(state);
  if (!current) return state;
  const items = { ...state.items, [current]: 'skipped' as ItemState };
  const next = state.order.find((p) => items[p] === 'waiting');
  if (next) items[next] = 'review';
  return { ...state, items };
}

/** After a stop the owner fixed the problem: try the stopped destination again as the current one. Others stay as they are. */
export function resume(state: QueueState): QueueState {
  if (!state.stopped) return state;
  const platform = state.stopped.platform;
  return { order: state.order, items: { ...state.items, [platform]: 'review' }, stopped: null };
}

export function isFinished(state: QueueState): boolean {
  return !state.stopped && !state.order.some((p) => state.items[p] === 'waiting' || state.items[p] === 'review' || state.items[p] === 'publishing');
}

export function summary(state: QueueState): { published: number; total: number } {
  return { published: state.order.filter((p) => state.items[p] === 'published').length, total: state.order.length };
}
