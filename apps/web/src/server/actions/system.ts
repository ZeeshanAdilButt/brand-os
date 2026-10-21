import { ConfigError, loadConfig, type DbDriver, type Mode } from '../config';
import { DataDirLockedError, pingDb, type DbHandle } from '../db/client';
import { migrationStatus } from '../db/migrate';
import { getDb } from '../db';

export interface Health {
  status: 'ok' | 'degraded' | 'error';
  mode: Mode | 'unknown';
  db: {
    ok: boolean;
    driver: DbDriver | null;
    latencyMs: number | null;
    /** 'pending' means the database answers but migrations have not all been applied. */
    schema: 'ready' | 'pending' | 'unknown';
    error?: string;
  };
}

interface Deps {
  env?: Record<string, string | undefined>;
  openDb?: () => Promise<DbHandle>;
}

/**
 * System health, shared by GET /api/health and the Settings page. This is the first member of the
 * action layer: UI, MCP and AI all call functions like this one rather than reaching into storage.
 */
export async function getHealth(deps: Deps = {}): Promise<Health> {
  let config;
  try {
    config = loadConfig(deps.env);
  } catch (err) {
    return unavailable('unknown', null, err instanceof ConfigError ? err.message : 'invalid configuration');
  }
  let handle: DbHandle;
  try {
    handle = await (deps.openDb ?? getDb)();
  } catch (err) {
    const known = err instanceof DataDirLockedError || err instanceof ConfigError;
    return unavailable(config.mode, config.driver, known ? err.message : 'database could not be opened');
  }
  const ping = await pingDb(handle);
  if (!ping.ok) return unavailable(config.mode, handle.driver, 'database did not answer');
  let schema: Health['db']['schema'] = 'unknown';
  try {
    schema = (await migrationStatus(handle)).upToDate ? 'ready' : 'pending';
  } catch {
    schema = 'unknown';
  }
  return {
    status: schema === 'ready' ? 'ok' : 'degraded',
    mode: config.mode,
    db: { ok: true, driver: handle.driver, latencyMs: ping.latencyMs, schema },
  };
}

function unavailable(mode: Health['mode'], driver: DbDriver | null, error: string): Health {
  return { status: 'error', mode, db: { ok: false, driver, latencyMs: null, schema: 'unknown', error } };
}
