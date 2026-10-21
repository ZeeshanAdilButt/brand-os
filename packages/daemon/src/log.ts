import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import { redact } from './secrets/redact.js';
import { guardedFs, type GuardedFs } from './site/guarded-fs.js';

export type LogLevel = 'info' | 'warn' | 'error';
/** One line to the daemon log. Every message goes through `redact` before it is written. */
export type Logger = (level: LogLevel, message: string) => void;

export const silentLogger: Logger = () => {};

/** Past this size the log is moved to `daemon.log.1` (one generation is kept). */
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_LINE = 4000;

export interface FileLoggerOptions {
  now?: () => Date;
  /** Writes go through the site guard; tests may pass another guarded fs. */
  fs?: Pick<GuardedFs, 'appendFileSync' | 'mkdirSync' | 'renameSync'>;
  /** Also print to stderr (when the daemon runs in a terminal). */
  echo?: boolean;
  maxBytes?: number;
}

/**
 * `<stateDir>\logs\daemon.log`: one `<ISO time> <level> <message>` line per call, redacted, one
 * line each (newlines are folded). A logging failure never throws into the caller.
 */
export function createFileLogger(file: string, options: FileLoggerOptions = {}): Logger {
  const files = options.fs ?? guardedFs;
  const now = options.now ?? (() => new Date());
  const maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
  let ready = false;
  return (level, message) => {
    const line = `${now().toISOString()} ${level} ${redact(message).replace(/\r?\n/g, ' | ').slice(0, MAX_LINE)}\n`;
    try {
      if (!ready) {
        files.mkdirSync(dirname(file), { recursive: true });
        ready = true;
      }
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        size = 0;
      }
      if (size > maxBytes) files.renameSync(file, `${file}.1`);
      files.appendFileSync(file, line, 'utf8');
    } catch {
      // The log is a diagnostic; losing a line must not break a request or a timer.
    }
    if (options.echo === true) process.stderr.write(line);
  };
}
