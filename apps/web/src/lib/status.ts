import type { Health } from '@/server/actions/system';

export type ChipState = 'loading' | 'ok' | 'degraded' | 'error';

const MODE_LABEL = { local: 'Local', hosted: 'Hosted', unknown: 'Unknown' } as const;
const DRIVER_SHORT = { pglite: 'PGlite', postgres: 'Postgres' } as const;
const DRIVER_LONG = { pglite: 'Embedded Postgres (PGlite)', postgres: 'PostgreSQL server' } as const;

export function modeLabel(mode: Health['mode']): string {
  return MODE_LABEL[mode];
}

export function driverLabel(driver: Health['db']['driver'], long = false): string {
  if (!driver) return 'Not connected';
  return (long ? DRIVER_LONG : DRIVER_SHORT)[driver];
}

export function formatLatency(ms: number | null): string {
  return ms === null ? 'n/a' : `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
}

/** Short text for the top-bar chip. */
export function chipText(health: Health): string {
  if (health.status === 'error') return 'Database offline';
  if (health.status === 'degraded') return 'Migration pending';
  // The engine and the latency live in Settings. The bar only speaks up when something is wrong.
  return modeLabel(health.mode);
}

/** Full sentence for assistive tech and tooltips. */
export function chipDescription(health: Health): string {
  if (health.status === 'error') return `Database unavailable. ${health.db.error ?? ''}`.trim();
  if (health.status === 'degraded') {
    return `${modeLabel(health.mode)} mode, ${driverLabel(health.db.driver, true)} reachable, but migrations are pending. Run pnpm db:migrate.`;
  }
  return `${modeLabel(health.mode)} mode, ${driverLabel(health.db.driver, true)}, responding in ${formatLatency(health.db.latencyMs)}.`;
}
