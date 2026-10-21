import type { DaemonApi } from '@cph/client';
import type { Config } from '@cph/daemon/config';
import type { KeyStore } from '@cph/daemon/keystore';

/** Runs a program with an argument array (never a shell string). Rejects with the child's error. */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

/** `[y/N]` questions and hidden input. Tests answer from a queue. */
export interface Prompter {
  /** Asks `question` and returns true only for an explicit yes. Anything else, and end of input, is no. */
  confirm(question: string): Promise<boolean>;
  /** Reads a line without echoing it. Only called when `ctx.isTty` is true. */
  secret(question: string): Promise<string>;
  /** Releases stdin so the process can exit. Safe to call more than once. */
  close(): void;
}

/** Files the CLI reads and writes. Writes go through the daemon's guarded fs in production. */
export interface FileOps {
  exists(path: string): boolean;
  /** UTF-8 text, or null when the file does not exist. */
  readText(path: string): string | null;
  /** Creates missing parent folders. */
  writeFile(path: string, data: string | Uint8Array): void;
  remove(path: string): void;
}

export interface CliContext {
  out(line: string): void;
  err(line: string): void;
  env: Readonly<Record<string, string | undefined>>;
  isTty: boolean;
  now(): Date;
  nodeVersion: string;
  /** Absolute path of the node executable running the CLI. */
  nodePath: string;
  /** The content-powerhouse checkout (holds packages/daemon/dist/main.js and so on). */
  repoRoot: string;
  /** The user's home folder (its .claude folder holds the user-scope settings). */
  homeDir: string;
  /** %APPDATA% (Claude Desktop keeps its config under it). */
  appDataDir: string;
  stateDir: string;
  loadConfig(): Config;
  keystore(): KeyStore;
  /** The daemon client for the cli token; throws NotSetUpError when the token is missing. */
  client(): DaemonApi;
  execFile: ExecFileFn;
  /** Opens a URL in the default browser. Its error text may quote the URL, so callers never print it. */
  open(url: string): Promise<void>;
  prompt: Prompter;
  files: FileOps;
  fetchFn: typeof fetch;
  /** Slugs of the posts the site repo reader finds (rejects when the repo cannot be read). */
  listPosts(repoPath: string): Promise<string[]>;
  /** True when nothing listens on 127.0.0.1:<port>. */
  portIsFree(port: number): Promise<boolean>;
  /** Runs the daemon in this process until it is interrupted (development). */
  runDaemon(): Promise<void>;
}

/** The cli token is missing from the keystore: `cph install` has not run. */
export class NotSetUpError extends Error {
  constructor() {
    super("content-powerhouse isn't set up yet: run `cph install`");
    this.name = 'NotSetUpError';
  }
}

/** Left-aligned text table. Empty cells print as a hyphen. */
export function formatTable(header: readonly string[], rows: readonly (readonly (string | undefined)[])[]): string[] {
  const cells = rows.map((row) => header.map((_h, i) => (row[i] === undefined || row[i] === '' ? '-' : (row[i] as string))));
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((r) => (r[i] as string).length)));
  const line = (r: readonly string[]): string =>
    r
      .map((c, i) => c.padEnd(widths[i] as number))
      .join(' | ')
      .trimEnd();
  return [line(header), widths.map((w) => '-'.repeat(w)).join('-+-'), ...cells.map(line)];
}
