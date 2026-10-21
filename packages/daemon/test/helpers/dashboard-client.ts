import type { Hono } from 'hono';

export interface DashboardResponse {
  status: number;
  text: string;
  headers: Headers;
}

/** The dashboard's loopback host; the daemon's Host guard refuses anything else. */
export const DASHBOARD_HOST = '127.0.0.1:4646';

const UNESCAPES: [RegExp, string][] = [
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
  [/&#96;/g, '`'],
  [/&amp;/g, '&'],
];

/** Undoes the dashboard's own HTML escaping (`escapeHtml`). */
export function unescapeHtml(text: string): string {
  return UNESCAPES.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

/** What an approval card shows: the tag Hello will name and the checklist boxes the user must tick. */
export function readCard(page: string): { tag: string | undefined; checklist: string[] } {
  return {
    tag: /data-approval-tag>(#[0-9A-F]{8})</.exec(page)?.[1],
    checklist: [...page.matchAll(/<input type="checkbox" name="checked" value="([^"]*)">/g)].map((m) => unescapeHtml(m[1] as string)),
  };
}

/**
 * A browser-like client for the cookie-authenticated dashboard: it signs in with a one-time login
 * URL, keeps the session cookie, reads the CSRF token and sends it with every form post.
 */
export class DashboardClient {
  readonly #jar = new Map<string, string>();
  #csrf: string | undefined;

  constructor(private readonly app: Pick<Hono, 'request'>) {}

  /** Follows a login URL (from `/api/open-dashboard` or `/api/dashboard-login-nonce`). */
  async signIn(loginUrl: string): Promise<void> {
    const url = new URL(loginUrl);
    const login = await this.request('GET', `${url.pathname}${url.search}`);
    if (login.status !== 303) throw new Error(`sign-in was refused with ${login.status}`);
    const page = await this.request('GET', '/approvals');
    this.#csrf = /<meta name="csrf-token" content="([^"]+)">/.exec(page.text)?.[1];
    if (this.#csrf === undefined) throw new Error('the dashboard page carries no CSRF token');
  }

  get(path: string): Promise<DashboardResponse> {
    return this.request('GET', path);
  }

  /** A form post with this session's CSRF token. */
  post(path: string, form: Record<string, string | string[]> = {}): Promise<DashboardResponse> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
    if (this.#csrf !== undefined) params.append('_csrf', this.#csrf);
    return this.request('POST', path, params.toString());
  }

  async request(method: string, path: string, body?: string): Promise<DashboardResponse> {
    const headers: Record<string, string> = { host: DASHBOARD_HOST };
    if (this.#jar.size > 0) headers['cookie'] = [...this.#jar].map(([name, value]) => `${name}=${value}`).join('; ');
    if (body !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
    const res = await this.app.request(path, { method, headers, ...(body === undefined ? {} : { body }) });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie !== null) {
      const [pair] = setCookie.split(';');
      const eq = (pair as string).indexOf('=');
      this.#jar.set((pair as string).slice(0, eq).trim(), (pair as string).slice(eq + 1).trim());
    }
    return { status: res.status, text: await res.text(), headers: res.headers };
  }
}
