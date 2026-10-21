import { formatTable, type CliContext } from '../context.js';
import { runGuarded } from './shared.js';

export function runLog(ctx: CliContext, options: { limit?: number }): Promise<number> {
  return runGuarded(ctx, async () => {
    const { entries } = await ctx.client().getLog(options.limit === undefined ? {} : { limit: options.limit });
    if (entries.length === 0) {
      ctx.out('The publish log is empty.');
      return 0;
    }
    for (const line of formatTable(
      ['time', 'channel', 'action', 'platform', 'draft'],
      entries.map((e) => [e.ts, e.actorChannel, e.action, e.platform, e.draftId]),
    )) {
      ctx.out(line);
    }
    return 0;
  });
}
