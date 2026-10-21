import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DaemonClient } from '@cph/client';
import { loadConfig as loadDaemonConfig } from '@cph/daemon/config';
import { configureSiteGuard } from '@cph/daemon/guarded-fs';
import { WindowsKeyStore, type KeyStore } from '@cph/daemon/keystore';
import { stateDir as resolveStateDir } from '@cph/daemon/paths';
import { SiteReader } from '@cph/daemon/site-reader';
import { NotSetUpError, type CliContext } from './context.js';
import { createExecFile } from './exec.js';
import { createFileOps } from './files.js';
import { createTerminalPrompter } from './prompt.js';

export const CLI_TOKEN_ENTRY = 'api-token:cli';

/** `<repo>/packages/cli/dist/runtime.js` to `<repo>`. */
export function defaultRepoRoot(moduleUrl: string = import.meta.url): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), '..', '..', '..');
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once('error', () => resolvePort(false));
    server.once('listening', () => server.close(() => resolvePort(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function openInBrowser(url: string): Promise<void> {
  const { default: open } = await import('open');
  await open(url);
}

/** The real wiring: Windows keystore, real files, the real daemon. Never built by tests. */
export function createProductionContext(): CliContext {
  const env = process.env;
  const stateDir = resolveStateDir(env);
  let keys: KeyStore | undefined;
  const keystore = (): KeyStore => (keys ??= new WindowsKeyStore());
  const loadConfig = (): ReturnType<CliContext['loadConfig']> => {
    const config = loadDaemonConfig({ stateDir });
    configureSiteGuard(config.site.repoPath);
    return config;
  };

  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    env,
    isTty: process.stdin.isTTY === true && process.stdout.isTTY === true,
    now: () => new Date(),
    nodeVersion: process.version,
    nodePath: process.execPath,
    repoRoot: defaultRepoRoot(),
    homeDir: homedir(),
    appDataDir: env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'),
    stateDir,
    loadConfig,
    keystore,
    client() {
      const token = keystore().get(CLI_TOKEN_ENTRY);
      if (token === null || token === '') throw new NotSetUpError();
      return new DaemonClient({ baseUrl: `http://127.0.0.1:${loadConfig().daemon.port}`, token });
    },
    execFile: createExecFile(env),
    open: openInBrowser,
    prompt: createTerminalPrompter(),
    files: createFileOps(),
    fetchFn: (input, init) => globalThis.fetch(input, init),
    listPosts: (repoPath) => new SiteReader(repoPath).listPosts(),
    portIsFree,
    async runDaemon() {
      const { startDaemon } = await import('@cph/daemon/main');
      const running = await startDaemon();
      const stop = (): void => {
        void running.close().then(() => process.exit(0));
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    },
  };
}
