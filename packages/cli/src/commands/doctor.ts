import { join } from 'node:path';
import { MASTER_KEY_NAME } from '@cph/daemon/keystore';
import type { CliContext } from '../context.js';
import { runGuarded, describeError, EXIT_OK, EXIT_PROBLEM } from './shared.js';

type Status = 'OK' | 'WARN' | 'FAIL';
interface Check {
  name: string;
  status: Status;
  detail?: string;
}

const MIN_NODE_MAJOR = 22;
/** The program names are constants so the site-read-only git rule keeps meaning "no git against the site". */
const GIT = 'git';
const PNPM = 'pnpm';

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0] ?? '';
}

async function toolVersion(ctx: CliContext, name: string, program: string): Promise<Check> {
  try {
    const { stdout } = await ctx.execFile(program, ['--version']);
    return { name, status: 'OK', detail: firstLine(stdout) };
  } catch {
    return { name, status: 'FAIL', detail: `${program} was not found on PATH` };
  }
}

async function checks(ctx: CliContext): Promise<Check[]> {
  const result: Check[] = [];

  const major = Number(/^v?(\d+)/.exec(ctx.nodeVersion)?.[1] ?? '0');
  result.push({
    name: 'node',
    status: major >= MIN_NODE_MAJOR ? 'OK' : 'FAIL',
    detail: major >= MIN_NODE_MAJOR ? ctx.nodeVersion : `${ctx.nodeVersion}, need ${MIN_NODE_MAJOR} or newer`,
  });
  result.push(await toolVersion(ctx, 'pnpm', PNPM));
  result.push(await toolVersion(ctx, 'git', GIT));

  let port = 4646;
  try {
    const config = ctx.loadConfig();
    port = config.daemon.port;
    try {
      const posts = await ctx.listPosts(config.site.repoPath);
      result.push(
        posts.length > 0
          ? { name: 'site repo', status: 'OK', detail: `${posts.length} posts` }
          : { name: 'site repo', status: 'FAIL', detail: `no posts found in ${config.site.repoPath}` },
      );
    } catch (error) {
      result.push({ name: 'site repo', status: 'FAIL', detail: `cannot read ${config.site.repoPath}: ${describeError(error)}` });
    }
  } catch (error) {
    result.push({ name: 'site repo', status: 'FAIL', detail: describeError(error) });
  }

  if (await ctx.portIsFree(port)) {
    result.push({ name: `port ${port}`, status: 'OK', detail: 'free (the daemon is not running yet)' });
  } else {
    try {
      await ctx.client().listConnections();
      result.push({ name: `port ${port}`, status: 'OK', detail: 'the daemon is up' });
    } catch {
      result.push({ name: `port ${port}`, status: 'FAIL', detail: 'in use, and it is not the daemon (or it refused this CLI)' });
    }
  }

  try {
    const present = ctx.keystore().get(MASTER_KEY_NAME) !== null;
    result.push(present ? { name: 'master key', status: 'OK', detail: 'present' } : { name: 'master key', status: 'FAIL', detail: 'missing: run `cph install`' });
  } catch (error) {
    result.push({ name: 'master key', status: 'FAIL', detail: `keystore unavailable: ${describeError(error)}` });
  }

  const probe = join(ctx.stateDir, `.doctor-${process.pid}.tmp`);
  try {
    ctx.files.writeFile(probe, 'ok');
    ctx.files.remove(probe);
    result.push({ name: 'state dir', status: 'OK', detail: 'writable' });
  } catch (error) {
    result.push({ name: 'state dir', status: 'FAIL', detail: `${ctx.stateDir} is not writable: ${describeError(error)}` });
  }

  const spaced = join(ctx.repoRoot, 'a folder with spaces');
  try {
    const { stdout } = await ctx.execFile(ctx.nodePath, ['-e', 'process.stdout.write(process.argv[1])', spaced]);
    result.push(
      stdout === spaced
        ? { name: 'paths with spaces', status: 'OK', detail: 'round-trip through execFile' }
        : { name: 'paths with spaces', status: 'FAIL', detail: 'the path changed on the way through execFile' },
    );
  } catch (error) {
    result.push({ name: 'paths with spaces', status: 'FAIL', detail: describeError(error) });
  }

  return result;
}

/** Prints `name: STATUS (detail)` per check; exit 1 if any FAIL. */
export function runDoctor(ctx: CliContext): Promise<number> {
  return runGuarded(ctx, async () => {
    const all = await checks(ctx);
    for (const c of all) ctx.out(`${c.name}: ${c.status}${c.detail === undefined ? '' : ` (${c.detail})`}`);
    return all.some((c) => c.status === 'FAIL') ? EXIT_PROBLEM : EXIT_OK;
  });
}
