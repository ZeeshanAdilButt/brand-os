import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { DbHandle } from './client';

export function migrationsFolder(): string {
  return process.env.CPH_MIGRATIONS_DIR ?? path.join(process.cwd(), 'drizzle');
}

/** Apply pending SQL migrations. Idempotent; safe to call on every start in local mode. */
export async function runMigrations(handle: DbHandle, folder: string = migrationsFolder()): Promise<void> {
  if (handle.driver === 'pglite') {
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    await migrate(handle.db as unknown as Parameters<typeof migrate>[0], { migrationsFolder: folder });
  } else {
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await migrate(handle.db as unknown as Parameters<typeof migrate>[0], { migrationsFolder: folder });
  }
}

export interface MigrationStatus {
  expected: number;
  applied: number;
  upToDate: boolean;
}

/** Compare the migrations on disk with those recorded in the database. Never throws on a missing table. */
export async function migrationStatus(handle: DbHandle, folder: string = migrationsFolder()): Promise<MigrationStatus> {
  const journal = JSON.parse(fs.readFileSync(path.join(folder, 'meta', '_journal.json'), 'utf8')) as {
    entries: unknown[];
  };
  const expected = journal.entries.length;
  let applied = 0;
  try {
    const result = (await handle.db.execute(
      sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
    )) as unknown as { rows: { n: number }[] };
    applied = Number(result.rows[0]?.n ?? 0);
  } catch {
    applied = 0;
  }
  return { expected, applied, upToDate: applied >= expected };
}
