import { isDashboardPage } from '@cph/daemon/api';
import type { CliContext } from '../context.js';
import { openDashboardPage } from './dashboard.js';
import { EXIT_ERROR, EXIT_PROBLEM, runGuarded } from './shared.js';

/** Dashboard form each platform's key is posted to. LinkedIn goes through Buffer. */
const PASTE_FORMS: Readonly<Record<string, string>> = { devto: '/connections/devto', buffer: '/connections/buffer', linkedin: '/connections/buffer' };

const SESSION_COOKIE = 'cph_session';

export interface ConnectOptions {
  paste?: boolean;
}

/** `cph connect <platform>`: opens the connect card; with `--paste` in a terminal, asks for the key here instead. */
export async function runConnect(ctx: CliContext, platform: string, options: ConnectOptions): Promise<number> {
  const page = `connections/${platform}`;
  if (!isDashboardPage(page)) {
    ctx.err(`Unknown platform "${platform}". Try devto, linkedin or buffer.`);
    return EXIT_ERROR;
  }
  if (options.paste !== true) return openDashboardPage(ctx, page, `the ${platform} connect card`);
  if (!ctx.isTty) {
    ctx.err('--paste needs an interactive terminal (the key is typed without echo). Run `cph connect ' + platform + '` to use the dashboard instead.');
    return EXIT_ERROR;
  }
  const form = PASTE_FORMS[platform];
  if (form === undefined) {
    ctx.err(`${platform} has no key to paste. Run \`cph connect ${platform}\` for its connect card.`);
    return EXIT_ERROR;
  }
  return runGuarded(ctx, async () => {
    const key = (await ctx.prompt.secret(`Paste the ${platform} API key (it will not be shown): `)).trim();
    if (key === '') {
      ctx.err('No key entered.');
      return EXIT_ERROR;
    }
    return pasteKey(ctx, page, form, key);
  });
}

/**
 * Signs in to the dashboard with a one-time nonce (the way a browser would), reads the CSRF token off
 * the connect card, and posts the key to the card's own form. The key and the nonce are never printed.
 */
async function pasteKey(ctx: CliContext, page: string, form: string, key: string): Promise<number> {
  const { url } = await ctx.client().loginNonce(page);
  const origin = new URL(url).origin;
  const login = await ctx.fetchFn(url, { redirect: 'manual' });
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(';')[0] ?? '')
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (cookie === undefined) {
    ctx.err('The dashboard did not sign in (the login link may have expired). Try again.');
    return EXIT_ERROR;
  }
  const card = await ctx.fetchFn(`${origin}${form}`, { headers: { cookie } });
  const csrf = /name="_csrf"\s+value="([^"]+)"/.exec(await card.text())?.[1];
  if (csrf === undefined) {
    ctx.err('Could not read the connect card. Use `cph connect` without --paste.');
    return EXIT_ERROR;
  }
  const result = await ctx.fetchFn(`${origin}${form}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ apiKey: key, _csrf: csrf }).toString(),
  });
  if (result.status === 200) {
    ctx.out('Connected. The key is stored encrypted and is never shown again. Check with `cph status`.');
    return 0;
  }
  ctx.err(`Not connected (the daemon answered ${result.status}). Run \`cph connect ${page.split('/')[1] ?? ''}\` to see the reason on the connect card.`);
  return EXIT_PROBLEM;
}
