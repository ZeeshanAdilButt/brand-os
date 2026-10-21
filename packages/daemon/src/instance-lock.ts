import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { guardedFs, type GuardedFs } from './site/guarded-fs.js';

/** The lock file in the state dir. It holds the pid of the daemon that owns the state dir. */
export function instanceLockPath(stateDir: string): string {
  return join(stateDir, 'daemon.lock');
}

/** Thrown when another daemon already owns the state dir. Nothing has been opened or changed. */
export class DaemonAlreadyRunningError extends Error {
  override readonly name = 'DaemonAlreadyRunningError';

  constructor(
    readonly pid: number | undefined,
    readonly lockFile: string,
  ) {
    super(
      `another content-powerhouse daemon (${pid === undefined ? 'pid unknown' : `pid ${pid}`}) already owns this state folder, so this one will not start. ` +
        `If no daemon is running, delete ${lockFile} and start again.`,
    );
  }
}

export interface InstanceLock {
  readonly file: string;
  /** Removes the lock file if it is still ours. Safe to call more than once. */
  release(): void;
}

export interface InstanceLockOptions {
  pid?: number;
  /** True when a process with this pid exists (default: `process.kill(pid, 0)`). */
  isAlive?: (pid: number) => boolean;
  fs?: Pick<GuardedFs, 'writeFileSync' | 'rmSync' | 'mkdirSync'>;
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else. Only ESRCH means it is gone.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readPid(file: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Takes the single-instance lock for a state dir: creates `daemon.lock` exclusively (`wx`) with our
 * pid. A lock left by a process that no longer exists is stale and is replaced; a lock held by a live
 * process throws `DaemonAlreadyRunningError`. It must be taken before the recovery sweep, so a second
 * `cph daemon start` can never flip the 'publishing' drafts of the daemon that is mid-publish.
 */
export function acquireInstanceLock(stateDir: string, options: InstanceLockOptions = {}): InstanceLock {
  const files = options.fs ?? guardedFs;
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processIsAlive;
  const file = instanceLockPath(stateDir);
  files.mkdirSync(stateDir, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      files.writeFileSync(file, `${pid}\n`, { encoding: 'utf8', flag: 'wx' });
      let released = false;
      return {
        file,
        release() {
          if (released) return;
          released = true;
          if (readPid(file) === pid) files.rmSync(file, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const owner = readPid(file);
    // An unreadable lock may be one another daemon is writing right now: refuse rather than guess.
    if (owner === undefined || (owner !== pid && isAlive(owner))) throw new DaemonAlreadyRunningError(owner, file);
    // Stale: the process that wrote it is gone. Replace it once.
    files.rmSync(file, { force: true });
  }
  throw new DaemonAlreadyRunningError(readPid(file), file);
}
