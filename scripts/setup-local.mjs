// One-step local setup: install dependencies, create the embedded database, print how to start.
// Local mode needs no account, no AI key and no Docker. Safe to re-run.
import { spawnSync } from 'node:child_process';

const isWindows = process.platform === 'win32';

function run(label, args) {
  console.log(`\n> ${label}`);
  const result = spawnSync('pnpm', args, { stdio: 'inherit', shell: isWindows });
  if (result.status !== 0) {
    console.error(`\nSetup stopped: "${label}" failed.`);
    process.exit(result.status ?? 1);
  }
}

run('pnpm install', ['install']);
run('pnpm db:migrate', ['db:migrate']);

console.log(`
Local setup complete.

  Start the app:   pnpm web:dev
  Then open:       http://localhost:3100
  Health check:    http://localhost:3100/api/health

Your data lives in apps/web/.data (ignored by git). Stop the app before running
pnpm db:migrate again: the embedded database allows one process at a time.
`);
