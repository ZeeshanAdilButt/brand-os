import { DaemonApiError, DaemonProtocolError, DaemonUnavailableError } from '@cph/client';
import { redact } from '@cph/daemon/redact';
import { NotSetUpError, type CliContext } from '../context.js';

/** Exit codes: 0 fine, 1 the command found a problem to report, 2 it could not run. */
export const EXIT_OK = 0;
export const EXIT_PROBLEM = 1;
export const EXIT_ERROR = 2;

export const DAEMON_DOWN_TEXT =
  'The content-powerhouse daemon is not running. Start it with `schtasks /Run /TN "content-powerhouse daemon"` (after `cph install`), or run `cph daemon start` in a spare terminal.';

/** One line for an error, with anything secret-shaped masked. */
export function describeError(error: unknown): string {
  if (error instanceof NotSetUpError) return error.message;
  if (error instanceof DaemonUnavailableError) return error.timedOut ? `${error.message}. Is the daemon stuck?` : DAEMON_DOWN_TEXT;
  if (error instanceof DaemonApiError) return redact(`${error.code}: ${error.message}`);
  if (error instanceof DaemonProtocolError) return redact(error.message);
  return redact(error instanceof Error ? error.message : String(error));
}

/** Runs a command body; any error becomes one line on stderr and exit code 2. */
export async function runGuarded(ctx: CliContext, body: () => Promise<number | void>): Promise<number> {
  try {
    return (await body()) ?? EXIT_OK;
  } catch (error) {
    ctx.err(describeError(error));
    return EXIT_ERROR;
  }
}
