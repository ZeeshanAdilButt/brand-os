import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { ApiTokenScope, KeyStore } from '../secrets/keystore.js';

/**
 * Who may talk to the daemon, and how (spec 2.6 rule 9, T0.18):
 *
 * - every request: the `Host` must be this daemon's loopback name (blocks DNS rebinding), and a
 *   browser request from another origin or site is refused;
 * - `/api/*`: a bearer API token, `mcp` or `cli` scope, compared in constant time;
 * - the dashboard: a `cph_session` cookie only (T0.19); bearer tokens are never accepted there.
 *
 * The login nonces that turn into a dashboard session live here too: one-time, 60 seconds,
 * in memory only.
 */

export const DEFAULT_DAEMON_PORT = 4646;
export const API_SCOPES: readonly ApiTokenScope[] = ['mcp', 'cli'];
export const SESSION_COOKIE = 'cph_session';

/** `cph_<scope>_<43 base64url chars>`, as `issueApiToken` mints it. */
const TOKEN_SHAPE = /^cph_(mcp|cli)_[A-Za-z0-9_-]{43}$/;
const BEARER = /^Bearer[ \t]+(\S+)[ \t]*$/i;

/** The scope of a presented token, or `undefined` when it matches no stored token. */
export type TokenVerifier = (presented: string) => ApiTokenScope | undefined;

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/**
 * Compares a presented token with `api-token:mcp` and `api-token:cli` from the keystore (read on
 * every call, so `cph install` can rotate them while the daemon runs). The comparison is over
 * SHA-256 digests with `timingSafeEqual`, so it takes the same time whatever the length or the
 * first differing character, and both scopes are always compared. The scope is the keystore entry
 * that matched; a stored value that is not a well-formed token for its own scope never matches.
 */
export function createTokenVerifier(keystore: Pick<KeyStore, 'get'>): TokenVerifier {
  return (presented) => {
    const given = digest(presented);
    let match: ApiTokenScope | undefined;
    for (const scope of API_SCOPES) {
      let stored: string | null;
      try {
        stored = keystore.get(`api-token:${scope}`);
      } catch {
        stored = null;
      }
      const usable = stored !== null && TOKEN_SHAPE.exec(stored)?.[1] === scope;
      // Always run the comparison, so an absent entry costs the same as a present one.
      const equal = timingSafeEqual(given, digest(usable ? (stored as string) : `\0unusable:${scope}`));
      if (equal && usable && match === undefined) match = scope;
    }
    return match;
  };
}

// ---- host and origin ---------------------------------------------------------------------------

/** The `Host` values this daemon answers to. */
export function allowedHosts(port: number): ReadonlySet<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
}

/** The origins a browser page of this daemon has (the dashboard). */
export function allowedOrigins(port: number): ReadonlySet<string> {
  return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
}

/**
 * Refuses (403) a request whose `Host` is not this daemon's loopback name, whose `Origin` is any
 * other origin (including `null`), or whose fetch metadata says it came from another site.
 */
export function hostAndOriginGuard(port: number): MiddlewareHandler {
  const hosts = allowedHosts(port);
  const origins = allowedOrigins(port);
  return async (c, next) => {
    const host = c.req.header('host')?.toLowerCase();
    if (host === undefined || !hosts.has(host)) {
      return c.json({ code: 'FORBIDDEN_HOST', message: `this daemon answers only to 127.0.0.1:${port} and localhost:${port}` }, 403);
    }
    const origin = c.req.header('origin');
    if (origin !== undefined && !origins.has(origin.toLowerCase())) {
      return c.json({ code: 'FORBIDDEN_ORIGIN', message: 'cross-origin requests are refused' }, 403);
    }
    const site = c.req.header('sec-fetch-site')?.toLowerCase();
    if (site === 'cross-site' || site === 'same-site') {
      return c.json({ code: 'FORBIDDEN_ORIGIN', message: 'cross-site requests are refused' }, 403);
    }
    await next();
  };
}

// ---- bearer tokens -----------------------------------------------------------------------------

export type ScopeVariables = { scope: ApiTokenScope };

/** 401 without a valid bearer token; 403 when the token's scope is not one of `scopes`. */
export function requireScope(tokens: TokenVerifier, scopes: readonly ApiTokenScope[]): MiddlewareHandler<{ Variables: ScopeVariables }> {
  return async (c, next) => {
    const header = c.req.header('authorization');
    const presented = header === undefined ? undefined : BEARER.exec(header)?.[1];
    const scope = presented === undefined ? undefined : tokens(presented);
    if (scope === undefined) {
      c.header('WWW-Authenticate', 'Bearer');
      return c.json({ code: 'UNAUTHORIZED', message: 'a valid API token is required' }, 401);
    }
    if (!scopes.includes(scope)) {
      return c.json({ code: 'FORBIDDEN_SCOPE', message: `the ${scope} token cannot call this route` }, 403);
    }
    c.set('scope', scope);
    await next();
  };
}

// ---- dashboard login nonces ----------------------------------------------------------------------

export const LOGIN_NONCE_TTL_MS = 60_000;
/** Outstanding nonces are few (one per open-dashboard call); the cap bounds memory if something loops. */
const MAX_OUTSTANDING = 64;

export interface LoginNonceStoreOptions {
  now?: () => Date;
  ttlMs?: number;
}

/**
 * One-time login nonces for the dashboard: minted by `POST /api/dashboard-login-nonce` (cli) and,
 * inside the daemon, by `POST /api/open-dashboard`; consumed once by `GET /login` (T0.19), which
 * turns a nonce into a session cookie. In memory only, so a restart drops them. Stored by digest:
 * the raw nonce is never kept or logged.
 */
export class LoginNonceStore {
  readonly #now: () => Date;
  readonly #ttlMs: number;
  /** sha256(nonce) hex -> expiry (epoch ms). Insertion order is age order. */
  readonly #live = new Map<string, number>();

  constructor(options: LoginNonceStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#ttlMs = options.ttlMs ?? LOGIN_NONCE_TTL_MS;
  }

  mint(): { nonce: string; expiresAt: string } {
    const at = this.#now().getTime();
    this.#purge(at);
    while (this.#live.size >= MAX_OUTSTANDING) {
      const oldest = this.#live.keys().next().value as string;
      this.#live.delete(oldest);
    }
    const nonce = randomBytes(32).toString('base64url');
    const expires = at + this.#ttlMs;
    this.#live.set(digest(nonce).toString('hex'), expires);
    return { nonce, expiresAt: new Date(expires).toISOString() };
  }

  /** True exactly once, and only before the nonce expires. */
  consume(nonce: string): boolean {
    if (typeof nonce !== 'string' || nonce === '') return false;
    const key = digest(nonce).toString('hex');
    const expires = this.#live.get(key);
    if (expires === undefined) return false;
    this.#live.delete(key);
    return this.#now().getTime() < expires;
  }

  /** Drops a nonce that will not be used (the browser could not be opened). */
  revoke(nonce: string): void {
    this.#live.delete(digest(nonce).toString('hex'));
  }

  /** Outstanding, unexpired nonces. */
  size(): number {
    this.#purge(this.#now().getTime());
    return this.#live.size;
  }

  #purge(at: number): void {
    for (const [key, expires] of this.#live) if (expires <= at) this.#live.delete(key);
  }
}

/** `http://127.0.0.1:<port>/login?nonce=…&next=/<page>`: what the daemon opens in the browser. */
export function dashboardLoginUrl(nonce: string, page: string, port: number = DEFAULT_DAEMON_PORT): string {
  const url = new URL(`http://127.0.0.1:${port}/login`);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('next', `/${page}`);
  return url.href;
}

// ---- dashboard sessions ------------------------------------------------------------------------------

/** Checks a `cph_session` cookie value. */
export interface SessionVerifier {
  verify(cookieValue: string): boolean;
}

/** Without a session store (the API-only app in tests): every dashboard request is refused. */
export const NO_SESSIONS: SessionVerifier = { verify: () => false };

/** A dashboard session ends after this long without a request. */
export const SESSION_IDLE_MS = 8 * 60 * 60_000;
/** Sessions are few (one per sign-in); the cap bounds memory if something loops. */
const MAX_SESSIONS = 32;

export interface SessionStoreOptions {
  now?: () => Date;
  idleMs?: number;
}

interface SessionEntry {
  csrf: string;
  lastSeen: number;
}

const equalDigests = (a: string, b: string): boolean => timingSafeEqual(digest(a), digest(b));

/**
 * Dashboard sessions, minted only by `GET /login` with a fresh one-time nonce. In memory only (a
 * restart signs everyone out). Each session has its own CSRF token, which every POST must carry
 * (form field `_csrf` or header `HX-CSRF`), compared in constant time. Stored by digest: the cookie
 * value itself is never kept or logged. A session ends after 8 hours without a request.
 */
export class SessionStore implements SessionVerifier {
  readonly #now: () => Date;
  readonly #idleMs: number;
  /** sha256(cookie) hex -> entry. Insertion order is age order. */
  readonly #live = new Map<string, SessionEntry>();

  constructor(options: SessionStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#idleMs = options.idleMs ?? SESSION_IDLE_MS;
  }

  /** A new session: the cookie value and its CSRF token. */
  create(): { cookie: string; csrf: string } {
    const at = this.#now().getTime();
    this.#purge(at);
    while (this.#live.size >= MAX_SESSIONS) this.#live.delete(this.#live.keys().next().value as string);
    const cookie = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    this.#live.set(digest(cookie).toString('hex'), { csrf, lastSeen: at });
    return { cookie, csrf };
  }

  /** True for a live session; each successful check counts as activity. */
  verify(cookieValue: string): boolean {
    return this.#touch(cookieValue) !== undefined;
  }

  /** The session's CSRF token (for the page it renders), or undefined. */
  csrfFor(cookieValue: string): string | undefined {
    return this.#touch(cookieValue)?.csrf;
  }

  /** Constant-time check of a presented CSRF token against the session's own. */
  checkCsrf(cookieValue: string, presented: string | undefined): boolean {
    const entry = this.#touch(cookieValue);
    if (entry === undefined || presented === undefined || presented === '') return false;
    return equalDigests(entry.csrf, presented);
  }

  revoke(cookieValue: string): void {
    this.#live.delete(digest(cookieValue).toString('hex'));
  }

  size(): number {
    this.#purge(this.#now().getTime());
    return this.#live.size;
  }

  #touch(cookieValue: string): SessionEntry | undefined {
    if (typeof cookieValue !== 'string' || cookieValue === '') return undefined;
    const key = digest(cookieValue).toString('hex');
    const entry = this.#live.get(key);
    if (entry === undefined) return undefined;
    const at = this.#now().getTime();
    if (at - entry.lastSeen >= this.#idleMs) {
      this.#live.delete(key);
      return undefined;
    }
    entry.lastSeen = at;
    return entry;
  }

  #purge(at: number): void {
    for (const [key, entry] of this.#live) if (at - entry.lastSeen >= this.#idleMs) this.#live.delete(key);
  }
}
