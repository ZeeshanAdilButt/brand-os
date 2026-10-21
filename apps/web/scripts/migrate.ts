import path from 'node:path';
import nextEnv from '@next/env';

// Same env loading as the web app: one .env at the repository root, none needed in local mode.
nextEnv.loadEnvConfig(path.resolve(process.cwd(), '../..'));

const { loadConfig } = await import('../src/server/config');
const { createDb } = await import('../src/server/db/client');
const { runMigrations, migrationStatus } = await import('../src/server/db/migrate');
const { ensureLocalOwner } = await import('../src/server/data/users');

const config = loadConfig();
const handle = await createDb(config);
try {
  await runMigrations(handle);
  if (config.mode === 'local') await ensureLocalOwner(handle.db);
  const status = await migrationStatus(handle);
  console.log(`Database ready: ${handle.driver} (${config.mode} mode), ${status.applied}/${status.expected} migrations applied.`);
} finally {
  await handle.close();
}
