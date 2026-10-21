/**
 * The only place the daemon spawns git, and only ever as
 * `git --no-optional-locks -C <repo> <allowlisted args>` with `GIT_OPTIONAL_LOCKS=0`.
 * Without `--no-optional-locks`, `git status` can refresh stat data and rewrite `.git/index`
 * (taking `index.lock`): a write to the site repo that can also collide with the owner's own git
 * commands. The `git-allowlist` source rule enforces both the location and the flag.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export class GitCommandBlocked extends Error {
  constructor(args: readonly string[]) {
    super(`git command not allowed: git ${JSON.stringify(args)}`);
    this.name = 'GitCommandBlocked';
  }
}

export const NO_OPTIONAL_LOCKS = '--no-optional-locks';

export interface GitRunOptions {
  env: NodeJS.ProcessEnv;
}

/** Runs git with these FULL args (they start with `--no-optional-locks`). Injected in tests. */
export type GitRunner = (args: string[], opts: GitRunOptions) => Promise<{ stdout: string }>;

const execFileAsync = promisify(execFile);

export const defaultGitRunner: GitRunner = async (args, opts) => {
  if (args[0] !== NO_OPTIONAL_LOCKS) throw new GitCommandBlocked(args);
  const { stdout } = await execFileAsync('git', ['--no-optional-locks', ...args.slice(1)], {
    env: opts.env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { stdout };
};

/** True for exactly the three allowed command shapes. */
function isAllowed(args: readonly string[]): boolean {
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) return false;
  const [a, b, c, d] = args;
  if (args.length === 2) return a === 'rev-parse' && b === 'HEAD';
  if (args.length === 3) return a === 'log' && b === '-1' && c === '--format=%H';
  if (args.length === 4) {
    return a === 'status' && b === '--porcelain' && c === '--' && d !== undefined && d !== '' && !d.includes('\0');
  }
  return false;
}

export type Git = (args: string[]) => Promise<string>;

/** `git(args)` for one repo: allowlisted commands only, anything else throws `GitCommandBlocked`. */
export function createGit(repoPath: string, run: GitRunner = defaultGitRunner): Git {
  return async (args) => {
    if (!isAllowed(args)) throw new GitCommandBlocked(args);
    const { stdout } = await run([NO_OPTIONAL_LOCKS, '-C', repoPath, ...args], {
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return stdout;
  };
}
