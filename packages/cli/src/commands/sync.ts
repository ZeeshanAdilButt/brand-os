import type { CliContext } from '../context.js';
import { EXIT_OK, EXIT_PROBLEM, runGuarded } from './shared.js';

export function runSync(ctx: CliContext): Promise<number> {
  return runGuarded(ctx, async () => {
    const result = await ctx.client().sync();
    ctx.out(`Synced ${result.upserted} post${result.upserted === 1 ? '' : 's'}.`);
    if (result.changed.length > 0) ctx.out(`Changed: ${result.changed.join(', ')}`);
    if (result.invalidatedApprovals > 0) {
      ctx.out(`Approvals invalidated because the source changed: ${result.invalidatedApprovals}`);
    }
    for (const e of result.errors) ctx.err(`${e.slug}: ${e.message}`);
    return result.errors.length > 0 ? EXIT_PROBLEM : EXIT_OK;
  });
}
