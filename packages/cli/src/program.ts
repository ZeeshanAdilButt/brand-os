import { Command, CommanderError, InvalidArgumentError } from 'commander';
import type { CliContext } from './context.js';
import { runCheck } from './commands/check.js';
import { runConnect } from './commands/connect.js';
import { runDaemonStart, runDaemonStatus, runDaemonStop } from './commands/daemon.js';
import { runDashboard } from './commands/dashboard.js';
import { runDoctor } from './commands/doctor.js';
import { runDraftsList, runDraftsShow, runDraftsStage } from './commands/drafts.js';
import { runInstall } from './commands/install.js';
import { runLog } from './commands/log.js';
import { runStatus } from './commands/status.js';
import { runSync } from './commands/sync.js';
import { describeError, EXIT_ERROR } from './commands/shared.js';

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 500) throw new InvalidArgumentError('must be a whole number from 1 to 500');
  return n;
}

/**
 * Builds the command tree. Each action stores its exit code in `result.code`; nothing here calls
 * `process.exit`, so tests drive it with a fake context.
 */
export function buildProgram(ctx: CliContext, result: { code: number }): Command {
  const program = new Command();
  program
    .name('cph')
    .description('content-powerhouse: drafts for your platforms, approved by you with Windows Hello')
    .exitOverride()
    .configureOutput({ writeOut: (s) => ctx.out(s.replace(/\r?\n$/, '')), writeErr: (s) => ctx.err(s.replace(/\r?\n$/, '')) });

  const act = (fn: () => Promise<number>) => async (): Promise<void> => {
    result.code = await fn();
  };

  program.command('status').description('connections: platform, route, state, who, next action (exit 1 if one needs reconnecting)').action(act(() => runStatus(ctx)));

  program
    .command('connect')
    .argument('<platform>', 'devto, linkedin or buffer')
    .option('--paste', 'type the API key here (hidden) instead of in the dashboard; needs a terminal')
    .description('open the dashboard connect card for a platform')
    .action(async (platform: string, options: { paste?: boolean }) => {
      result.code = await runConnect(ctx, platform, options);
    });

  program.command('sync').description('re-read the site repo and update the content list').action(act(() => runSync(ctx)));

  const drafts = program.command('drafts').description('list, show or stage drafts');
  drafts
    .command('list', { isDefault: true })
    .option('--slug <slug>')
    .option('--platform <platform>')
    .option('--status <status>')
    .description('list drafts')
    .action(async (options: { slug?: string; platform?: string; status?: string }) => {
      result.code = await runDraftsList(ctx, options);
    });
  drafts
    .command('show')
    .argument('<id>')
    .description('show one draft, its lint results and payload')
    .action(async (id: string) => {
      result.code = await runDraftsShow(ctx, id);
    });
  drafts
    .command('stage')
    .argument('<id>')
    .description('send a draft to the platform as a PRIVATE draft (never public)')
    .action(async (id: string) => {
      result.code = await runDraftsStage(ctx, id);
    });

  program
    .command('log')
    .option('--limit <n>', 'how many entries (1 to 500)', positiveInt)
    .description('the audit log of approvals and publishes')
    .action(async (options: { limit?: number }) => {
      result.code = await runLog(ctx, options);
    });

  program
    .command('dashboard')
    .argument('[page]', 'for example approvals, content, log')
    .description('open the dashboard, signed in (the login link is never printed)')
    .action(async (page: string | undefined) => {
      result.code = await runDashboard(ctx, page);
    });

  const daemon = program.command('daemon').description('run the daemon in the foreground (development)');
  daemon.command('start').description('start the daemon in this terminal').action(act(() => runDaemonStart(ctx)));
  daemon.command('stop').description('how to stop the daemon').action(act(() => runDaemonStop(ctx)));
  daemon.command('status').description('is the daemon answering?').action(act(() => runDaemonStatus(ctx)));

  program.command('doctor').description('check Node, pnpm, git, the site repo, the port, the master key and the state folder').action(act(() => runDoctor(ctx)));

  program
    .command('check')
    .argument('<draft>', 'id of a draft whose publish status is unknown')
    .description('ask the platform whether an unknown draft went out')
    .action(async (draft: string) => {
      result.code = await runCheck(ctx, draft);
    });

  program
    .command('install')
    .description('one-time setup: keys, daemon task, Claude Code and Claude Desktop registration (asks before every step)')
    .action(async () => {
      try {
        result.code = await runInstall(ctx);
      } catch (error) {
        ctx.err(describeError(error));
        result.code = EXIT_ERROR;
      }
    });

  return program;
}

/** Runs `argv` (without the node and script entries) and returns the exit code. */
export async function runCli(argv: readonly string[], ctx: CliContext): Promise<number> {
  const result = { code: 0 };
  const program = buildProgram(ctx, result);
  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    ctx.err(describeError(error));
    return EXIT_ERROR;
  } finally {
    // An open readline on stdin would keep `cph install` from exiting.
    ctx.prompt.close();
  }
  return result.code;
}
