import type { AppConfig } from '../config';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostnameOf(hostHeader: string): string {
  // "[::1]:3100" -> "[::1]", "localhost:3100" -> "localhost"
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1).toLowerCase();
  return (hostHeader.split(':')[0] ?? '').toLowerCase();
}

export type GuardResult = { ok: true } | { ok: false; status: 403; reason: string };

/**
 * Browser-facing request checks for the JSON API, applied before any data is touched.
 *
 * 1. Local mode answers only to loopback host names (or the configured APP_URL host). A hostile
 *    page that rebinds its own domain to 127.0.0.1 would otherwise be able to read the single
 *    owner's data through the browser.
 * 2. Mutating requests (anything but GET/HEAD) must be same-origin. A browser always sends Origin
 *    on those; if it names another site the request is refused. Without Origin, Sec-Fetch-Site
 *    must not say cross-site. Non-browser clients send neither and are allowed: CSRF needs a
 *    browser, and the session cookie is SameSite=Lax on top of this.
 */
export function checkRequest(request: Request, config: Pick<AppConfig, 'mode' | 'appUrl'>): GuardResult {
  const host = request.headers.get('host') ?? new URL(request.url).host;
  const appHost = new URL(config.appUrl).host.toLowerCase();

  if (config.mode === 'local') {
    const name = hostnameOf(host);
    if (!LOOPBACK_HOSTS.has(name) && host.toLowerCase() !== appHost) {
      return { ok: false, status: 403, reason: 'This address is not allowed in local mode.' };
    }
  }

  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return { ok: true };

  const origin = request.headers.get('origin');
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return { ok: false, status: 403, reason: 'Cross-site request refused.' };
    }
    if (originHost !== host.toLowerCase() && originHost !== appHost) {
      return { ok: false, status: 403, reason: 'Cross-site request refused.' };
    }
    return { ok: true };
  }
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return { ok: false, status: 403, reason: 'Cross-site request refused.' };
  }
  return { ok: true };
}
