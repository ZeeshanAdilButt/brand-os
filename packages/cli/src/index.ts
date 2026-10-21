#!/usr/bin/env node
/**
 * `cph`: the command line for content-powerhouse. `runCli` is the testable core (a fake context in,
 * an exit code out); the code at the bottom runs only when this file is the process entry point.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { redact } from '@cph/daemon/redact';
import { runCli } from './program.js';
import { createProductionContext } from './runtime.js';

export { buildProgram, runCli } from './program.js';
export type { CliContext, ExecFileFn, FileOps, Prompter } from './context.js';

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** True when `moduleUrl` is the script node was started with (resolves pnpm's links first). */
export function isEntryPoint(moduleUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined || argv1 === '') return false;
  const a = realPath(fileURLToPath(moduleUrl));
  const b = realPath(argv1);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export async function main(argv: readonly string[]): Promise<number> {
  return runCli(argv, createProductionContext());
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`cph failed: ${redact(error instanceof Error ? error.message : String(error))}\n`);
      process.exitCode = 2;
    },
  );
}
