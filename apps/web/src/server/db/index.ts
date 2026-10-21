import { loadConfig } from '../config';
import { ensureLocalOwner } from '../data/users';
import { createDb, type DbHandle } from './client';
import { runMigrations } from './migrate';

const globalForDb = globalThis as typeof globalThis & { __cphDb?: Promise<DbHandle> };

/**
 * Process-wide database handle (one PGlite instance per data directory, one pool per process).
 * Local mode migrates and seeds the local owner on first use so there is nothing to set up.
 * Hosted mode never migrates implicitly: run `pnpm db:migrate` as a deploy step.
 */
export function getDb(): Promise<DbHandle> {
  if (!globalForDb.__cphDb) {
    const opening = open();
    globalForDb.__cphDb = opening;
    opening.catch(() => {
      if (globalForDb.__cphDb === opening) delete globalForDb.__cphDb;
    });
  }
  return globalForDb.__cphDb;
}

async function open(): Promise<DbHandle> {
  const config = loadConfig();
  const handle = await createDb(config);
  if (config.mode === 'local') {
    try {
      await runMigrations(handle);
      await ensureLocalOwner(handle.db);
    } catch (err) {
      await handle.close();
      throw err;
    }
  }
  return handle;
}

export async function closeDb(): Promise<void> {
  const opening = globalForDb.__cphDb;
  delete globalForDb.__cphDb;
  if (opening) await (await opening).close();
}
