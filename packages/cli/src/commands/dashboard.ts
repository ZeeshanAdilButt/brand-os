import type { CliContext } from '../context.js';
import { EXIT_ERROR, runGuarded } from './shared.js';

/**
 * Asks the daemon for a one-time login link and opens it in the default browser. The link carries a
 * nonce that signs the browser in, so it is never printed, logged or put in an error message
 * (the opener's own error can quote it, so that error is replaced).
 */
export function openDashboardPage(ctx: CliContext, page: string | undefined, what: string): Promise<number> {
  return runGuarded(ctx, async () => {
    const { url } = await ctx.client().loginNonce(page);
    try {
      await ctx.open(url);
    } catch {
      ctx.err('Could not open the default browser. Run the command again, or open a browser yourself and try once more.');
      return EXIT_ERROR;
    }
    ctx.out(`Opened ${what} in your browser.`);
    return 0;
  });
}

export function runDashboard(ctx: CliContext, page?: string): Promise<number> {
  return openDashboardPage(ctx, page, page === undefined ? 'the dashboard' : `the dashboard (${page})`);
}
