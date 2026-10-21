import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { errorText } from './audit.js';
import { loadConfig } from './config.js';
import { createDaemon, type Daemon } from './daemon.js';
import { openDb } from './db/open.js';
import { WindowsHelloPresence } from './gate/presence.js';
import { acquireInstanceLock, type InstanceLock } from './instance-lock.js';
import { createFileLogger, type Logger } from './log.js';
import { createNodeNotifier } from './notify.js';
import { dbPath, stateDir, type Env } from './paths.js';
import { WindowsKeyStore } from './secrets/keystore.js';
import { redact } from './secrets/redact.js';
import { assertNotUnderSite, configureSiteGuard } from './site/guarded-fs.js';

/** The daemon listens on loopback only. */
export const BIND_HOST = '127.0.0.1';

export interface StartOptions {
  env?: Env;
  /** The single-instance lock (tests inject one; production takes `<stateDir>\daemon.lock`). */
  acquireLock?: (stateDir: string) => InstanceLock;
}

export interface RunningDaemon {
  daemon: Daemon;
  close(): Promise<void>;
}

/** Opens the default browser through the `open` package (loaded on first use). */
async function openInBrowser(url: string): Promise<void> {
  const { default: open } = await import('open');
  await open(url);
}

function listen(server: ServerType): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once('listening', () => resolveListen());
    server.once('error', reject);
  });
}

/**
 * Production start, in the order the T0.18 rulings fix:
 * 0. take the single-instance lock for the state dir, so a second daemon never runs the recovery
 *    sweep (it would flip the 'publishing' drafts of the daemon that is mid-publish);
 * 1. load config.json, guard the configured site repo against writes before anything is written,
 *    and refuse a database path under the site;
 * 2. open the database, the Windows keystore, the notifier, Windows Hello;
 * 3. build the daemon (routes, gate, services, HTTP app);
 * 4. run the recovery sweep BEFORE the server accepts a request;
 * 5. listen on 127.0.0.1:<port> only, then start the 15-minute timers.
 */
export async function startDaemon(options: StartOptions = {}): Promise<RunningDaemon> {
  const env = options.env ?? process.env;
  const dir = stateDir(env);
  const lock = (options.acquireLock ?? acquireInstanceLock)(dir);
  try {
    return await startLocked(dir, lock);
  } catch (error) {
    lock.release();
    throw error;
  }
}

async function startLocked(dir: string, lock: InstanceLock): Promise<RunningDaemon> {
  const config = loadConfig({ stateDir: dir });
  configureSiteGuard(config.site.repoPath);
  const file = dbPath(dir);
  assertNotUnderSite(file, config.site.repoPath);

  const log: Logger = createFileLogger(join(dir, 'logs', 'daemon.log'), { echo: process.stderr.isTTY === true });
  log('info', `starting: state ${dir}, site ${config.site.repoPath}, port ${config.daemon.port}`);

  const db = openDb(file);
  const daemon = createDaemon({
    config,
    stateDir: dir,
    db,
    keystore: new WindowsKeyStore(),
    fetchFn: globalThis.fetch,
    presence: new WindowsHelloPresence(),
    notifier: createNodeNotifier({ onError: (error) => log('warn', `toast failed: ${errorText(error)}`) }),
    opener: openInBrowser,
    log,
  });

  const report = await daemon.startup();
  if (report.recovered.length > 0 || Object.keys(report.checked).length > 0) {
    log('warn', `recovery sweep: recovered [${report.recovered.join(', ')}], checked ${JSON.stringify(report.checked)}`);
  }

  const server = serve({ fetch: daemon.app.fetch, hostname: BIND_HOST, port: config.daemon.port });
  try {
    await listen(server);
  } catch (error) {
    log('error', `cannot listen on ${BIND_HOST}:${config.daemon.port}: ${errorText(error)}`);
    db.close();
    throw error;
  }
  log('info', `listening on http://${BIND_HOST}:${config.daemon.port}`);
  daemon.startTimers();

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    daemon.stop();
    await new Promise<void>((done) => server.close(() => done()));
    db.close();
    lock.release();
    log('info', 'stopped');
  };
  return { daemon, close };
}

/** Two absolute paths name the same file (Windows paths compare case-insensitively). */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** The real path (junctions and symlinks resolved), or the plain resolved path when it does not exist. */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * True when `moduleUrl` is the script node was started with. Both sides are resolved through
 * junctions and symlinks first, so a launch through a pnpm link still starts the daemon.
 */
export function isEntryPoint(moduleUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined || argv1 === '') return false;
  return samePath(realPath(fileURLToPath(moduleUrl)), realPath(argv1));
}

/** The parts of `process` the entry point uses, so tests can drive it with fakes. */
export interface MainProcess {
  on(event: 'uncaughtException' | 'unhandledRejection', listener: (error: unknown) => void): unknown;
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  exit(code: number): void;
  stderr: { write(text: string): unknown };
}

export interface MainDeps {
  env?: Env;
  proc?: MainProcess;
  start?: (options: StartOptions) => Promise<RunningDaemon>;
  /** The logger used before (and outside) the daemon's own; by default `<stateDir>\logs\daemon.log`. */
  logger?: (stateDir: string) => Logger;
}

const describeFailure = (error: unknown): string => (error instanceof Error ? (error.stack ?? error.message) : String(error));
const shortFailure = (error: unknown): string => redact(error instanceof Error ? error.message : String(error));

/**
 * Logs an uncaught exception or unhandled rejection to the daemon log, then exits 1, so a crash is
 * never silent: the scheduled task restarts the daemon and the log says why it died.
 */
export function installCrashHandlers(proc: MainProcess, log: Logger): void {
  const crash = (kind: string) => (error: unknown) => {
    log('error', `${kind}, exiting: ${describeFailure(error)}`);
    proc.stderr.write(`content-powerhouse daemon crashed (${kind}): ${shortFailure(error)}\n`);
    proc.exit(1);
  };
  proc.on('uncaughtException', crash('uncaught exception'));
  proc.on('unhandledRejection', crash('unhandled rejection'));
}

/**
 * The entry point: crash handlers first, then start. A start failure goes to the daemon log as well
 * as stderr, because nobody sees stderr when Task Scheduler starts the daemon.
 */
export async function runMain(deps: MainDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const proc: MainProcess = deps.proc ?? process;
  const dir = stateDir(env);
  const log = (deps.logger ?? ((d: string) => createFileLogger(join(d, 'logs', 'daemon.log'))))(dir);
  installCrashHandlers(proc, log);
  try {
    const running = await (deps.start ?? startDaemon)({ env });
    const shutdown = (): void => {
      void running.close().then(() => proc.exit(0));
    };
    proc.once('SIGINT', shutdown);
    proc.once('SIGTERM', shutdown);
  } catch (error) {
    log('error', `failed to start: ${describeFailure(error)}`);
    proc.stderr.write(`content-powerhouse daemon failed to start: ${shortFailure(error)}\n`);
    proc.exit(1);
  }
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  void runMain();
}
