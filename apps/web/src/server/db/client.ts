import fs from 'node:fs';
import path from 'node:path';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { AppConfig, DbDriver } from '../config';
import * as schema from './schema';

/** The query surface shared by both drivers. All app code depends on this, never on a driver. */
export type AppDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: AppDb;
  driver: DbDriver;
  close(): Promise<void>;
}

/** In-memory PGlite, used by tests. */
export const MEMORY_DATA_DIR = 'memory://';

export class DataDirLockedError extends Error {
  constructor(lockPath: string, pid: number) {
    super(
      `The data directory is in use by another process (pid ${pid}). Stop it first. ` +
        `If that process is gone, delete ${lockPath}.`,
    );
    this.name = 'DataDirLockedError';
  }
}

/**
 * Open the database for the configured mode: embedded PGlite (local) or a Postgres server (hosted).
 * Driver modules are imported lazily so a hosted deployment never loads the WASM engine and a
 * local one never loads the pg driver.
 */
export async function createDb(config: AppConfig): Promise<DbHandle> {
  if (config.driver === 'pglite') return openPglite(config.dataDir);
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required for the postgres driver');
  return openPostgres(config.databaseUrl);
}

async function openPglite(dataDir: string): Promise<DbHandle> {
  const [{ PGlite }, { drizzle }] = await Promise.all([import('@electric-sql/pglite'), import('drizzle-orm/pglite')]);
  const inMemory = dataDir === MEMORY_DATA_DIR;
  const dir = inMemory ? dataDir : path.resolve(dataDir);
  let release = () => {};
  if (!inMemory) {
    fs.mkdirSync(dir, { recursive: true });
    release = acquireDataDirLock(dir);
  }
  try {
    const client = new PGlite(dir);
    await client.waitReady;
    return {
      db: drizzle({ client, schema }) as unknown as AppDb,
      driver: 'pglite',
      close: async () => {
        try {
          await client.close();
        } finally {
          release();
        }
      },
    };
  } catch (err) {
    release();
    throw err;
  }
}

async function openPostgres(connectionString: string): Promise<DbHandle> {
  const [{ default: pg }, { drizzle }] = await Promise.all([import('pg'), import('drizzle-orm/node-postgres')]);
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5_000 });
  // An idle client dropping must not crash the process; the next query reports the failure.
  pool.on('error', () => {});
  return {
    db: drizzle({ client: pool, schema }) as unknown as AppDb,
    driver: 'postgres',
    close: () => pool.end(),
  };
}

/**
 * PGlite allows exactly one process per data directory; a second writer corrupts it. A pid lock file
 * makes the failure loud (for example `pnpm db:migrate` while the dev server runs).
 */
function acquireDataDirLock(dir: string): () => void {
  const lockPath = path.join(dir, 'cph.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      const release = () => {
        try {
          if (fs.readFileSync(lockPath, 'utf8').trim() === String(process.pid)) fs.rmSync(lockPath, { force: true });
        } catch {
          /* already gone */
        }
        process.off('exit', release);
      };
      process.on('exit', release);
      return release;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = Number.parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
      if (Number.isInteger(holder) && isProcessAlive(holder)) throw new DataDirLockedError(lockPath, holder);
      fs.rmSync(lockPath, { force: true }); // stale lock from a crashed process
    }
  }
  throw new Error(`Could not acquire ${lockPath}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface PingResult {
  ok: boolean;
  latencyMs: number | null;
}

/** Round-trip `select 1`; never throws. */
export async function pingDb(handle: DbHandle): Promise<PingResult> {
  const started = performance.now();
  try {
    await handle.db.execute(sql`select 1`);
    return { ok: true, latencyMs: Math.max(0, Math.round((performance.now() - started) * 10) / 10) };
  } catch {
    return { ok: false, latencyMs: null };
  }
}
