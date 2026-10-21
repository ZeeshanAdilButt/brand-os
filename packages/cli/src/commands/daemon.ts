import { DaemonApiError, DaemonUnavailableError } from '@cph/client';
import type { CliContext } from '../context.js';
import { TASK_NAME } from '../install/task-scheduler.js';
import { EXIT_OK, EXIT_PROBLEM, runGuarded } from './shared.js';

/** Foreground development run; Ctrl+C stops it. */
export function runDaemonStart(ctx: CliContext): Promise<number> {
  return runGuarded(ctx, async () => {
    ctx.out('Starting the daemon in this terminal. Press Ctrl+C to stop it.');
    await ctx.runDaemon();
    return EXIT_OK;
  });
}

export function runDaemonStop(ctx: CliContext): Promise<number> {
  ctx.out('The daemon runs in the foreground when started with `cph daemon start`: stop it with Ctrl+C in that terminal.');
  ctx.out(`If the scheduled task started it, end it with: schtasks /End /TN "${TASK_NAME}"`);
  return Promise.resolve(EXIT_OK);
}

export function runDaemonStatus(ctx: CliContext): Promise<number> {
  return runGuarded(ctx, async () => {
    try {
      await ctx.client().listConnections();
      ctx.out('The daemon is running.');
      return EXIT_OK;
    } catch (error) {
      if (error instanceof DaemonUnavailableError) {
        ctx.out('The daemon is not running.');
        return EXIT_PROBLEM;
      }
      if (error instanceof DaemonApiError) {
        ctx.out(`Something answers on the daemon port but refused this CLI (${error.code}). Run \`cph install\` and answer yes to rotating the API tokens.`);
        return EXIT_PROBLEM;
      }
      throw error;
    }
  });
}
