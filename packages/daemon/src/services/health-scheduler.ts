import type { Repos } from '../db/repos.js';

/** A metered provider (Buffer) is probed at most this often by the daemon's timer. */
export const DAILY_PROBE_MS = 24 * 60 * 60 * 1000;

/** Remembers when the last probe ran, so a daemon restart does not probe again at once. */
export interface HealthSchedulerMemory {
  load(): Date | undefined;
  save(at: Date): void;
}

export interface HealthSchedulerOptions {
  /** The route to probe. Only `health` is used; for Buffer that is one `channels()` call. */
  route: { health(account: string): Promise<unknown> };
  account: string;
  now: () => Date;
  /** Minimum time between probes. Default one day. */
  intervalMs?: number;
  memory?: HealthSchedulerMemory;
  /** Called with the error when a probe throws (for example BUDGET_LOW). The scheduler never throws. */
  onError?: (error: unknown) => void;
}

export type TickResult = 'probed' | 'skipped' | 'failed';

export interface HealthScheduler {
  /**
   * Called by the daemon's frequent timer (every 15 minutes). It probes only when the interval has
   * passed since the last probe, so a metered route is never probed at the timer's own pace. A failed
   * probe still counts as an attempt: the next try is one interval later, not at the next tick.
   */
  tick(): Promise<TickResult>;
  lastProbeAt(): Date | undefined;
}

export function createHealthScheduler(options: HealthSchedulerOptions): HealthScheduler {
  const interval = options.intervalMs ?? DAILY_PROBE_MS;
  let last = options.memory?.load();
  let running = false;

  return {
    async tick(): Promise<TickResult> {
      if (running) return 'skipped';
      const at = options.now();
      if (last !== undefined && at.getTime() - last.getTime() < interval) return 'skipped';
      running = true;
      last = at;
      options.memory?.save(at);
      try {
        await options.route.health(options.account);
        return 'probed';
      } catch (error) {
        options.onError?.(error);
        return 'failed';
      } finally {
        running = false;
      }
    },
    lastProbeAt: () => last,
  };
}

/** Keeps the last probe time in the `settings` table under `key`. */
export function settingsMemory(repos: Repos, key: string): HealthSchedulerMemory {
  return {
    load() {
      const raw = repos.settings.get(key);
      if (raw === undefined) return undefined;
      const at = new Date(raw);
      return Number.isNaN(at.getTime()) ? undefined : at;
    },
    save(at) {
      repos.settings.set(key, at.toISOString());
    },
  };
}
