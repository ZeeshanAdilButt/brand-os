import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DaemonApi } from '@cph/client';
import { ConfigSchema, type Config } from '@cph/daemon/config';
import { MemoryKeyStore } from '@cph/daemon/keystore';
import { SiteReader } from '@cph/daemon/site-reader';
import { afterEach, vi } from 'vitest';
import type { CliContext, ExecFileFn, FileOps } from '../src/context.js';

export const FIXTURE_POSTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'core', 'test', 'fixtures');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temp folder whose name has a space in it, like the real checkout. */
export function tempDir(prefix = 'cph cli '): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Every file under `dir`, relative, sorted. */
export function tree(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(full.slice(dir.length + 1));
    }
  };
  walk(dir);
  return found.sort();
}

/** A site-repo-shaped folder holding the three fixture posts (sample-post, crlf-bom-post, unknown-jsx). */
export function fixtureSiteRepo(): string {
  const repo = tempDir('cph site ');
  mkdirSync(join(repo, 'content', 'posts'), { recursive: true });
  for (const slug of ['sample-post', 'crlf-bom-post', 'unknown-jsx']) {
    cpSync(join(FIXTURE_POSTS, `${slug}.mdx`), join(repo, 'content', 'posts', `${slug}.mdx`));
  }
  return repo;
}

export interface Recorded {
  writes: string[];
  removes: string[];
}

/** Real files in temp folders, recording every write so tests can assert there were none. */
export function recordingFiles(): { files: FileOps; recorded: Recorded } {
  const recorded: Recorded = { writes: [], removes: [] };
  const files: FileOps = {
    exists: (p) => existsSync(p),
    readText(p) {
      try {
        return readFileSync(p, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    writeFile(p, data) {
      recorded.writes.push(p);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, data);
    },
    remove(p) {
      recorded.removes.push(p);
      rmSync(p, { force: true });
    },
  };
  return { files, recorded };
}

export function fakeDaemon(overrides: Partial<Record<keyof DaemonApi, unknown>> = {}): DaemonApi {
  const notCalled = (name: string) => () => Promise.reject(new Error(`unexpected daemon call: ${name}`));
  return new Proxy({} as DaemonApi, {
    get: (_t, name: string) => overrides[name as keyof DaemonApi] ?? notCalled(name),
  });
}

export interface Rig {
  ctx: CliContext;
  out: string[];
  err: string[];
  execCalls: { file: string; args: readonly string[]; cwd?: string | undefined }[];
  questions: string[];
  opened: string[];
  closed: { count: number };
  recorded: Recorded;
  keys: MemoryKeyStore;
  dirs: { repoRoot: string; homeDir: string; appDataDir: string; stateDir: string; siteRepo: string };
  text(): string;
}

export interface RigOptions {
  daemon?: DaemonApi;
  answers?: (string | boolean)[] | 'all-yes' | 'all-no';
  exec?: ExecFileFn;
  config?: Partial<Config['claude']>;
  isTty?: boolean;
  nodeVersion?: string;
  secret?: string;
  portFree?: boolean;
  open?: (url: string) => Promise<void>;
  fetchFn?: typeof fetch;
  seedKeys?: Record<string, string>;
  siteRepo?: string;
  env?: Record<string, string>;
  listPosts?: CliContext['listPosts'];
}

export function makeRig(options: RigOptions = {}): Rig {
  const root = tempDir();
  const repoRoot = join(root, 'repo with space');
  const homeDir = join(root, 'home');
  const appDataDir = join(root, 'appdata');
  const stateDir = join(root, 'state dir');
  const siteRepo = options.siteRepo ?? join(root, 'site');
  mkdirSync(repoRoot, { recursive: true });
  const out: string[] = [];
  const err: string[] = [];
  const execCalls: Rig['execCalls'] = [];
  const questions: string[] = [];
  const opened: string[] = [];
  const closed = { count: 0 };
  const keys = new MemoryKeyStore();
  for (const [k, v] of Object.entries(options.seedKeys ?? {})) keys.set(k, v);
  const { files, recorded } = recordingFiles();
  const answers = options.answers ?? 'all-no';
  let next = 0;
  const config: Config = ConfigSchema.parse({ site: { repoPath: siteRepo }, claude: options.config ?? {} });
  const defaultExec: ExecFileFn = vi.fn(async () => ({ stdout: '', stderr: '' }));
  const exec = options.exec ?? defaultExec;

  const ctx: CliContext = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: { USERNAME: 'tester', USERDOMAIN: 'TESTBOX', ...(options.env ?? {}) },
    isTty: options.isTty ?? false,
    now: () => new Date('2026-10-20T10:11:12.345Z'),
    nodeVersion: options.nodeVersion ?? 'v22.22.2',
    nodePath: process.execPath,
    repoRoot,
    homeDir,
    appDataDir,
    stateDir,
    loadConfig: () => config,
    keystore: () => keys,
    client: () => options.daemon ?? fakeDaemon(),
    execFile: async (file, args, opts) => {
      execCalls.push({ file, args, cwd: opts?.cwd });
      return exec(file, args, opts);
    },
    open: options.open ?? (async (url) => void opened.push(url)),
    prompt: {
      async confirm(question) {
        questions.push(question);
        if (answers === 'all-yes') return true;
        if (answers === 'all-no') return false;
        const a = answers[next++];
        return a === true || a === 'y';
      },
      async secret() {
        return options.secret ?? '';
      },
      close() {
        closed.count++;
      },
    },
    files,
    fetchFn: options.fetchFn ?? ((async () => Promise.reject(new Error('unexpected fetch'))) as typeof fetch),
    listPosts: options.listPosts ?? ((repoPath) => new SiteReader(repoPath).listPosts()),
    portIsFree: async () => options.portFree ?? true,
    runDaemon: vi.fn(async () => undefined),
  };
  return { ctx, out, err, execCalls, questions, opened, closed, recorded, keys, dirs: { repoRoot, homeDir, appDataDir, stateDir, siteRepo }, text: () => [...out, ...err].join('\n') };
}
