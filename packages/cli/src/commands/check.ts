import type { CliContext } from '../context.js';
import { EXIT_OK, EXIT_PROBLEM, runGuarded } from './shared.js';

/** Asks the platform whether an `unknown` draft actually went out (read only; nothing is retried). */
export function runCheck(ctx: CliContext, draftId: string): Promise<number> {
  return runGuarded(ctx, async () => {
    const { outcome } = await ctx.client().checkDraft(draftId);
    if (outcome === 'published') ctx.out('The platform has it: the draft is now marked published.');
    else if (outcome === 'failed') ctx.out('The platform does not have it: the draft is marked failed. Nothing was posted.');
    else ctx.out('Still unknown: the platform could not confirm either way. Check the platform by hand, then record it in the dashboard.');
    return outcome === 'unknown' ? EXIT_PROBLEM : EXIT_OK;
  });
}
