import { formatTable, type CliContext } from '../context.js';
import { EXIT_OK, EXIT_PROBLEM, runGuarded } from './shared.js';

/**
 * Prints platform | route | state | who | next action. Exit 1 when a connection is red
 * (`needs_reconnect`) or the master key is missing, so scripts and `&&` chains notice.
 */
export function runStatus(ctx: CliContext): Promise<number> {
  return runGuarded(ctx, async () => {
    const { secretsReady, connections } = await ctx.client().listConnections();
    for (const line of formatTable(
      ['platform', 'route', 'state', 'who', 'next action'],
      connections.map((c) => [c.platform, c.route, c.state, c.who, c.nextAction]),
    )) {
      ctx.out(line);
    }
    if (connections.length === 0) ctx.out('(no connections yet: `cph connect devto`)');
    let code = EXIT_OK;
    if (!secretsReady) {
      ctx.err('The master key is missing: nothing can be connected, staged or published. Run `cph install`.');
      code = EXIT_PROBLEM;
    }
    const red = connections.filter((c) => c.state === 'needs_reconnect');
    if (red.length > 0) {
      ctx.err(`Needs reconnecting: ${red.map((c) => `${c.platform}/${c.route}`).join(', ')}`);
      code = EXIT_PROBLEM;
    }
    return code;
  });
}
