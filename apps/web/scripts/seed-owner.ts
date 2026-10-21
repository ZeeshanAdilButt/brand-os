import fs from 'node:fs';
import path from 'node:path';
import nextEnv from '@next/env';

// Same env loading as the web app: one .env at the repository root, none needed in local mode.
nextEnv.loadEnvConfig(path.resolve(process.cwd(), '../..'));

const { loadConfig } = await import('../src/server/config');
const { createDb } = await import('../src/server/db/client');
const { runMigrations, migrationStatus } = await import('../src/server/db/migrate');
const { ensureLocalOwner } = await import('../src/server/data/users');
const { applyOwnerSeed, ownerSeedSchema, resolveDesignatedOwnerId, SeedRefusedError } = await import('../src/server/data/seed');

/** The only place owner data is read from. Gitignored; never committed, copied or printed. */
const SEED_FILE = path.resolve(process.cwd(), 'seed', 'owner.private.json');

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!fs.existsSync(SEED_FILE)) {
  fail('No seed file found at apps/web/seed/owner.private.json. Nothing to do. (This file is gitignored and private.)');
}

let parsed: ReturnType<typeof ownerSeedSchema.safeParse>;
try {
  parsed = ownerSeedSchema.safeParse(JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')));
} catch {
  fail('The seed file is not valid JSON.');
}
if (!parsed.success) {
  // Paths and codes only: never echo values from the private file.
  const where = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} (${i.code})`).join(', ');
  fail(`The seed file does not match the expected shape at: ${where}`);
}

// Optional explicit target: --user <uuid>. It must equal the designated owner or the seed refuses.
const userFlag = process.argv.indexOf('--user');
const requestedUser = userFlag >= 0 ? process.argv[userFlag + 1] : undefined;

const config = loadConfig();
const handle = await createDb(config);
try {
  if (config.mode === 'local') {
    await runMigrations(handle);
    await ensureLocalOwner(handle.db);
  } else {
    const status = await migrationStatus(handle);
    if (!status.upToDate) fail('Migrations are pending. Run pnpm db:migrate first.');
  }
  const designated = await resolveDesignatedOwnerId(config, handle.db);
  const target = requestedUser ?? designated;
  if (!target) fail('Owner seed refused: no owner is designated (hosted mode needs OWNER_USER_ID).');
  const counts = await applyOwnerSeed(handle.db, { targetUserId: target, designatedOwnerId: designated, seed: parsed.data });
  console.log(
    `Owner seed applied (${config.mode} mode): profile ${counts.profile}, preferences ${counts.preferences}, ` +
      `sources ${counts.sources.created} created / ${counts.sources.kept} kept, ` +
      `items ${counts.items.created} created / ${counts.items.kept} kept.`,
  );
} catch (err) {
  if (err instanceof SeedRefusedError) fail(err.message);
  throw err;
} finally {
  await handle.close();
}
