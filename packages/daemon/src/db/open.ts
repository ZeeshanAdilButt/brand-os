import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { guardedFs } from '../site/guarded-fs.js';
import { MIGRATIONS, type Migration } from './migrations/index.js';

export type Db = Database.Database;

/**
 * Opens (creating if needed) the state database: WAL with synchronous = FULL (a commit, such as a
 * consumed approval, is on disk before it returns), foreign keys on, then every pending
 * migration, each in its own transaction. The applied version lives in `PRAGMA user_version`,
 * so opening twice is a no-op and no clock is needed.
 */
export function openDb(file: string, migrations: readonly Migration[] = MIGRATIONS): Db {
  if (file !== ':memory:') guardedFs.mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    migrate(db, migrations);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

function migrate(db: Db, migrations: readonly Migration[]): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  const latest = migrations.reduce((max, m) => Math.max(max, m.version), 0);
  if (current > latest) {
    throw new Error(
      `database schema version ${current} is newer than this build (${latest}); upgrade content-powerhouse`,
    );
  }
  for (const m of migrations) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    })();
  }
}
