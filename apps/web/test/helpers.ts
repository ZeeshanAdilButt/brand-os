import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SQL } from 'drizzle-orm';
import type { AppConfig } from '../src/server/config';
import { createDb, MEMORY_DATA_DIR, type AppDb, type DbHandle } from '../src/server/db/client';
import { runMigrations } from '../src/server/db/migrate';

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '..', 'drizzle');

/** Fresh in-memory PGlite, optionally migrated. Callers close it. */
export async function memoryDb(options: { migrate?: boolean } = {}): Promise<DbHandle> {
  const handle = await createDb(testConfig());
  if (options.migrate !== false) await runMigrations(handle, MIGRATIONS_DIR);
  return handle;
}

/** Rows of a raw SQL query, typed by the caller. The two drivers type `execute` differently, so tests go through this. */
export async function sqlRows<T = Record<string, unknown>>(db: AppDb, query: SQL): Promise<T[]> {
  const result = (await db.execute(query)) as unknown as { rows: T[] };
  return result.rows;
}

/** A temp directory whose name contains a space, like the repo path on the owner's machine. */
export function tempDirWithSpace(prefix = 'cph test '): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A local-mode config for in-memory tests. Override fields (for example mode: 'hosted') per test. */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    mode: 'local',
    driver: 'pglite',
    dataDir: MEMORY_DATA_DIR,
    databaseUrl: undefined,
    appUrl: 'http://localhost:3100',
    authSecret: undefined,
    ownerUserId: undefined,
    appSecret: undefined,
    ...overrides,
  };
}
