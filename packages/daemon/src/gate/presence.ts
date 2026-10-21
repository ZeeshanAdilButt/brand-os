import { execFile as nodeExecFile } from 'node:child_process';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A human-presence check run by the daemon in its own process (spec 2.6 rule 2). The real one is
 * Windows Hello (`WindowsHelloPresence`). Only the exact result `'verified'` counts: every other
 * answer, and a throw, is treated as "not verified" (fail closed).
 */
export type PresenceResult = 'verified' | 'canceled' | 'unavailable' | 'error';

export interface PresenceVerifier {
  /** `prompt` names the action, e.g. `Approve LinkedIn via buffer · #3F9A12C0 · prometheus-cardinality-explained · "Prometheus cost follows…"`. */
  verify(prompt: string): Promise<PresenceResult>;
}

/**
 * Click mode (`approval.mode: 'click'`, for PCs without Windows Hello): there is no separate check,
 * the dashboard POST (session cookie + CSRF token) or the chat prompt IS the human action, so this
 * always answers 'verified'. Only the daemon's wiring may build one, never a request handler.
 */
export class ClickPresence implements PresenceVerifier {
  verify(): Promise<PresenceResult> {
    return Promise.resolve('verified');
  }
}

/**
 * Windows PowerShell 5.1 by absolute path: `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`.
 * Not `pwsh` (the WinRT projection `hello.ps1` uses is absent in PowerShell 7), and not a bare
 * `powershell.exe`, so no PATH or working-directory lookup can substitute another program for the
 * presence check.
 */
export function powershellExePath(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const root = env['SystemRoot'];
  return win32.join(root !== undefined && root !== '' ? root : 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** The Hello dialog can sit open while the owner finds the keyboard; 2 minutes, then fail closed. */
export const HELLO_TIMEOUT_MS = 120_000;
const MAX_PROMPT_LENGTH = 200;

export interface ExecFileOptions {
  timeout: number;
  windowsHide: boolean;
  encoding: 'utf8';
  maxBuffer: number;
}

/** The slice of `child_process.execFile` used here, so tests inject a fake and never start a process. */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => unknown;

/**
 * `hello.ps1` sits next to this module: in `src/gate/` under vitest and tsx, and in `dist/gate/`
 * after the build (tsc does not copy it; `scripts/copy-assets.mjs` does).
 */
export function defaultHelloScriptPath(): string {
  return fileURLToPath(new URL('./hello.ps1', import.meta.url));
}

export interface WindowsHelloOptions {
  /** Defaults to node's `execFile`. */
  execFile?: ExecFileFn;
  /** Defaults to `hello.ps1` beside this module. */
  scriptPath?: string;
  timeoutMs?: number;
}

/**
 * Windows Hello through WinRT `UserConsentVerifier`, by running `hello.ps1` in Windows PowerShell.
 *
 * Fails closed: the result is `'verified'` only when the script exited 0 and printed exactly one
 * JSON line with `availability` `Available` and `result` `Verified` (exact, case-sensitive). A
 * timeout, a spawn failure, a non-zero exit, extra output lines or anything unparseable is `'error'`.
 */
export class WindowsHelloPresence implements PresenceVerifier {
  private readonly execFile: ExecFileFn;
  private readonly scriptPath: string;
  private readonly timeoutMs: number;

  constructor(options: WindowsHelloOptions = {}) {
    this.execFile = options.execFile ?? (nodeExecFile as unknown as ExecFileFn);
    this.scriptPath = options.scriptPath ?? defaultHelloScriptPath();
    this.timeoutMs = options.timeoutMs ?? HELLO_TIMEOUT_MS;
  }

  async verify(prompt: string): Promise<PresenceResult> {
    try {
      const stdout = await this.run(prompt);
      return parseHelloOutput(stdout);
    } catch {
      return 'error';
    }
  }

  private run(prompt: string): Promise<string> {
    // An args array, never a shell string: the path has spaces and the prompt carries a slug.
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath, '-Prompt', cleanPrompt(prompt)];
    return new Promise<string>((resolve, reject) => {
      this.execFile(
        powershellExePath(),
        args,
        { timeout: this.timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          // Any error (non-zero exit, timeout kill, ENOENT) rejects, even if stdout looks fine.
          if (error !== null) reject(error);
          else resolve(stdout);
        },
      );
    });
  }
}

/** One line, no control characters, bounded: what the dialog and the argument list can safely carry. */
function cleanPrompt(prompt: string): string {
  // eslint-disable-next-line no-control-regex
  return prompt.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_PROMPT_LENGTH);
}

/** Maps the script's JSON line to a presence result. Anything unexpected is 'error'. */
export function parseHelloOutput(stdout: string): PresenceResult {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length !== 1) return 'error';
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines[0] as string);
  } catch {
    return 'error';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'error';
  const { availability, result } = parsed as Record<string, unknown>;
  if (typeof availability !== 'string' || typeof result !== 'string') return 'error';

  if (availability !== 'Available') {
    // Hello cannot be used on this machine right now; the script asked for nothing.
    return availability === 'DeviceNotPresent' || availability === 'NotConfiguredForUser' || availability === 'DisabledByPolicy'
      ? 'unavailable'
      : 'error';
  }
  switch (result) {
    case 'Verified':
      return 'verified';
    case 'Canceled':
      return 'canceled';
    case 'DeviceNotPresent':
    case 'NotConfiguredForUser':
    case 'DisabledByPolicy':
      return 'unavailable';
    default:
      // DeviceBusy, RetriesExhausted, Error, NotRequested, or a value this code has never seen.
      return 'error';
  }
}
