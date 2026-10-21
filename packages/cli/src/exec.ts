import { execFile as nodeExecFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { ExecFileFn } from './context.js';

const WINDOWS_EXTENSIONS = ['.exe', '.com', '.cmd', '.bat'];
// Characters cmd.exe would interpret inside a quoted argument, or that cannot be quoted at all.
const UNSAFE_FOR_CMD = /["%^&|<>!\r\n]/;

/** Finds `name` on PATH with a Windows executable extension; undefined when it is not there. */
export function findOnPath(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const dirs = (env['PATH'] ?? env['Path'] ?? '').split(delimiter).filter((d) => d !== '');
  for (const ext of WINDOWS_EXTENSIONS) {
    for (const dir of dirs) {
      const candidate = join(dir, `${name}${ext}`);
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/** The one command line cmd.exe gets for a `.cmd` shim: every argument double-quoted. */
export function cmdLineFor(shim: string, args: readonly string[]): string {
  for (const part of [shim, ...args]) {
    if (UNSAFE_FOR_CMD.test(part)) throw new Error(`refusing to pass an argument with shell metacharacters to ${shim}`);
  }
  // A backslash right before a closing quote would escape it, so trailing backslashes are doubled.
  const quote = (a: string): string => `"${a.replace(/\\+$/, (run) => run + run)}"`;
  return `"${[shim, ...args].map(quote).join(' ')}"`;
}

export interface PlannedSpawn {
  file: string;
  args: string[];
  verbatim: boolean;
}

/**
 * Node cannot start a `.cmd` shim (pnpm and an npm-installed claude are shims) without a shell, so
 * a bare command name is resolved on PATH and a shim is run through `cmd.exe /d /s /c` with each
 * argument quoted. A real `.exe`, or any name that is not found, goes straight to execFile.
 */
export function planSpawn(
  file: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): PlannedSpawn {
  if (platform !== 'win32' || /[\\/]/.test(file) || /\.[A-Za-z]{2,4}$/.test(file)) {
    return { file, args: [...args], verbatim: false };
  }
  const found = findOnPath(file, env, exists);
  if (found === undefined) return { file, args: [...args], verbatim: false };
  if (/\.(cmd|bat)$/i.test(found)) {
    return { file: env['ComSpec'] ?? 'cmd.exe', args: ['/d', '/s', '/c', cmdLineFor(found, args)], verbatim: true };
  }
  return { file: found, args: [...args], verbatim: false };
}

/** The production runner: no shell string is ever built from user input. */
export function createExecFile(env: Readonly<Record<string, string | undefined>> = process.env): ExecFileFn {
  return (file, args, options) => {
    const plan = planSpawn(file, args, env);
    return new Promise((resolve, reject) => {
      nodeExecFile(
        plan.file,
        plan.args,
        {
          windowsHide: true,
          windowsVerbatimArguments: plan.verbatim,
          timeout: 120_000,
          maxBuffer: 8 * 1024 * 1024,
          encoding: 'utf8',
          ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
        },
        (error, stdout, stderr) => {
          if (error) reject(Object.assign(error, { stdout, stderr }));
          else resolve({ stdout, stderr });
        },
      );
    });
  };
}
