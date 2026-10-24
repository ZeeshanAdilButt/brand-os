import { createHash, randomBytes } from 'node:crypto';
import type { ConnectorDefinition } from '../../lib/connectors';
import type { OwnerContext } from '../actions/owner';
import { decryptKey, masterKey, SecretUnavailableError } from '../ai/crypto';
import type { TokenSet } from './bundle';
import { endpointUrl, nowOf, type ConnectEnv } from './env';
import { call, ConnectFailure, jsonOf, safeMessage } from './request';

/**
 * Generic OAuth 2 authorization code with PKCE, as one code path for every platform that signs in this way. What
 * differs per platform (endpoints, scopes, whether PKCE is documented, how the app authenticates, a per-instance
 * client, a long-lived exchange) is data in the connector definition. This file never touches the database: callers
 * pass in what they have and store what comes back.
 */

export const FLOW_TTL_MS = 10 * 60_000;
const SKEW_MS = 120_000;
const DAY_MS = 86_400_000;

export const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

export function randomToken(env: Pick<ConnectEnv, 'random'>, bytes = 32): string {
  return (env.random ? env.random(bytes) : randomBytes(bytes)).toString('base64url');
}

/** An S256 PKCE pair: the verifier stays on the server, the challenge goes to the platform. */
export function pkcePair(env: Pick<ConnectEnv, 'random'>): { verifier: string; challenge: string } {
  const verifier = randomToken(env, 48);
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/**
 * The address the platform sends the person back to: the app's own origin, `/api/connect/<id>/callback`. A local app
 * uses 127.0.0.1 rather than localhost, as RFC 8252 recommends, whichever name the browser used.
 */
export function redirectUriFor(config: { mode: 'local' | 'hosted'; appUrl: string }, id: string): string {
  const url = new URL(config.appUrl);
  if (config.mode === 'local' && url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return `${url.origin}/api/connect/${id}/callback`;
}

// ---- the app (client id and secret) ---------------------------------------------------------------------------

export interface AppCredentials {
  clientId: string;
  clientSecret: string | null;
  source: 'saved' | 'host';
  /** A client registered on the person's own server (Mastodon): which server, for which scopes and redirect address. */
  instance?: string;
  scopes?: string[];
  redirectUri?: string;
}

/** Which of the two apps a platform can have: the redirect sign-in (`web`) or the code sign-in (`device`). */
export type AppPurpose = 'web' | 'device';

/** The names of the environment variables a hosted deployment sets for one platform's app. */
export function hostAppVariables(id: string, purpose: AppPurpose = 'web'): { id: string; secret: string } {
  const key = id.toUpperCase();
  const prefix = purpose === 'web' ? 'BRAND_OS_OAUTH' : 'BRAND_OS_DEVICE';
  return { id: `${prefix}_${key}_CLIENT_ID`, secret: `${prefix}_${key}_CLIENT_SECRET` };
}

const kindOf = (purpose: AppPurpose) => (purpose === 'web' ? ('oauth_client' as const) : ('device_client' as const));

/**
 * The OAuth app to use for a platform. A hosted deployment may provide Brand OS's own app in its environment; a local
 * install uses the app the owner registered and saved (encrypted). Same code path afterwards.
 */
export async function appCredentials(owner: OwnerContext, env: ConnectEnv, def: Pick<ConnectorDefinition, 'id'>, purpose: AppPurpose = 'web'): Promise<AppCredentials | null> {
  if (env.config.mode === 'hosted') {
    const vars = env.processEnv ?? process.env;
    const names = hostAppVariables(def.id, purpose);
    const clientId = vars[names.id]?.trim();
    if (clientId) return { clientId, clientSecret: vars[names.secret]?.trim() || null, source: 'host' };
  }
  const row = await owner.data.integrationSecrets.getWithSecret(def.id, kindOf(purpose));
  if (!row) return null;
  try {
    const parsed = JSON.parse(decryptKey(row.encrypted, masterKey(env.config), owner.ownerId, row.id)) as { clientId?: string; clientSecret?: string; instance?: string; scopes?: string[]; redirectUri?: string };
    if (!parsed.clientId) return null;
    return { clientId: parsed.clientId, clientSecret: parsed.clientSecret || null, source: 'saved', ...(parsed.instance ? { instance: parsed.instance } : {}), ...(parsed.scopes ? { scopes: parsed.scopes } : {}), ...(parsed.redirectUri ? { redirectUri: parsed.redirectUri } : {}) };
  } catch (err) {
    if (err instanceof SecretUnavailableError) throw new ConnectFailure('unavailable', err.message);
    throw err;
  }
}

/** Whether the platform's app is available, without decrypting it. */
export async function hasApp(owner: OwnerContext, env: ConnectEnv, def: Pick<ConnectorDefinition, 'id'>, purpose: AppPurpose = 'web'): Promise<boolean> {
  if (env.config.mode === 'hosted') {
    const vars = env.processEnv ?? process.env;
    if (vars[hostAppVariables(def.id, purpose).id]?.trim()) return true;
  }
  return Boolean(await owner.data.integrationSecrets.get(def.id, kindOf(purpose)));
}

// ---- the authorization request --------------------------------------------------------------------------------

export function authorizeUrl(
  env: ConnectEnv,
  def: ConnectorDefinition,
  input: { clientId: string; redirectUri: string; scopes: string[]; state: string; challenge: string | null; instance?: string | undefined },
): string {
  const oauth = def.oauth;
  if (!oauth) throw new ConnectFailure('unexpected', `${def.name} does not sign in with OAuth.`);
  const base = oauth.perInstance ? `${input.instance}/oauth/authorize` : endpointUrl(env, def, def.endpoints.authorize as string);
  const url = new URL(base);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', input.scopes.join(oauth.scopeSeparator));
  url.searchParams.set('state', input.state);
  if (oauth.pkce === 'always' && input.challenge) {
    url.searchParams.set('code_challenge', input.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  for (const [k, v] of Object.entries(oauth.extraAuthorizeParams ?? {})) url.searchParams.set(k, v);
  return url.toString();
}

// ---- the token endpoint ---------------------------------------------------------------------------------------

export interface TokenResponse {
  accessToken: string;
  refreshToken: string | null;
  tokenType: string | null;
  expiresIn: number | null;
  scopes: string[] | null;
}

/** Form-encoded or JSON, whichever the platform sends (GitHub answers form-encoded unless asked for JSON). */
function parseTokenBody(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(trimmed).entries());
}

const stringOf = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const numberOf = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

export interface TokenPost {
  url: string;
  params: Record<string, string>;
  client: { id: string; secret: string | null; auth: 'basic' | 'body' | 'none' };
  fetch?: typeof fetch | undefined;
  secrets: readonly string[];
}

/** One POST to a token endpoint. Returns the parsed body, even for an error status, so callers can read `error`. */
export async function tokenPost(env: ConnectEnv, name: string, post: TokenPost): Promise<{ status: number; body: Record<string, unknown> }> {
  const params = new URLSearchParams(post.params);
  const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' };
  if (post.client.auth === 'basic' && post.client.secret) {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(post.client.id)}:${encodeURIComponent(post.client.secret)}`).toString('base64')}`;
  } else {
    params.set('client_id', post.client.id);
    if (post.client.auth !== 'none' && post.client.secret) params.set('client_secret', post.client.secret);
  }
  const res = await call(env, post.url, { method: 'POST', headers, body: params.toString() }, { secrets: post.secrets, fetch: post.fetch });
  if (res.status >= 500) throw new ConnectFailure('provider_error', `${name} had a problem on its side (HTTP ${res.status}). Try again later.`, { httpStatus: res.status });
  if (res.status === 429) throw new ConnectFailure('rate_limited', `${name} is rate limiting sign-ins. Wait a minute and try again.`, { httpStatus: 429 });
  return { status: res.status, body: parseTokenBody(res.text) };
}

/** Turn a token endpoint answer into tokens, or the failure it describes. */
export function readTokens(name: string, answer: { status: number; body: Record<string, unknown> }, secrets: readonly string[]): TokenResponse {
  const error = stringOf(answer.body.error);
  if (error) {
    const detail = stringOf(answer.body.error_description);
    const text = safeMessage(detail ? `${error}: ${detail}` : error, secrets);
    if (error === 'access_denied') throw new ConnectFailure('denied', `You declined access on ${name}.`);
    if (error === 'invalid_client' || error === 'unauthorized_client' || error === 'incorrect_client_credentials') {
      throw new ConnectFailure('rejected', `${name} did not accept the app's client ID and secret (${text}). Check them in your app settings.`);
    }
    if (error === 'invalid_grant' || error === 'bad_verification_code' || error === 'expired_token') {
      throw new ConnectFailure('expired', `${name} no longer accepts this sign-in (${text}). Connect again.`);
    }
    throw new ConnectFailure('rejected', `${name} refused the sign-in (${text}).`);
  }
  const accessToken = stringOf(answer.body.access_token);
  if (answer.status >= 400 || !accessToken) throw new ConnectFailure('unexpected', `${name} answered the sign-in with something this app could not read.`, { httpStatus: answer.status });
  const scope = stringOf(answer.body.scope);
  return {
    accessToken,
    refreshToken: stringOf(answer.body.refresh_token),
    tokenType: stringOf(answer.body.token_type),
    expiresIn: numberOf(answer.body.expires_in),
    scopes: scope ? scope.split(/[\s,]+/).filter(Boolean) : null,
  };
}

export function toTokenSet(response: TokenResponse, now: Date, previous?: TokenSet | undefined): TokenSet {
  return {
    accessToken: response.accessToken,
    refreshToken: response.refreshToken ?? previous?.refreshToken,
    tokenType: response.tokenType ?? previous?.tokenType,
    expiresAt: response.expiresIn !== null ? new Date(now.getTime() + response.expiresIn * 1000).toISOString() : null,
    obtainedAt: now.toISOString(),
    scopes: response.scopes ?? previous?.scopes,
  };
}

/** The token endpoint of a connector: its fixed address, or the person's own server. */
export function tokenEndpoint(env: ConnectEnv, def: ConnectorDefinition, instance?: string): string {
  if (def.oauth?.perInstance) return `${instance}/oauth/token`;
  return endpointUrl(env, def, def.endpoints.token as string);
}

export interface ExchangeInput {
  code: string;
  verifier: string | null;
  redirectUri: string;
  creds: AppCredentials;
  instance?: string | undefined;
  fetch?: typeof fetch | undefined;
}

/** Trade the code for tokens. Threads then trades the first token for the long-lived one. */
export async function exchangeCode(env: ConnectEnv, def: ConnectorDefinition, input: ExchangeInput): Promise<TokenSet> {
  const oauth = def.oauth;
  if (!oauth) throw new ConnectFailure('unexpected', `${def.name} does not sign in with OAuth.`);
  const secrets = [input.code, input.creds.clientSecret ?? '', input.verifier ?? ''];
  const params: Record<string, string> = { grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri };
  if (oauth.pkce === 'always' && input.verifier) params.code_verifier = input.verifier;
  const answer = await tokenPost(env, def.name, {
    url: tokenEndpoint(env, def, input.instance),
    params,
    client: { id: input.creds.clientId, secret: input.creds.clientSecret, auth: oauth.clientAuth },
    fetch: input.fetch,
    secrets,
  });
  const first = readTokens(def.name, answer, secrets);
  const now = nowOf(env);
  if (!oauth.longLivedExchange) return toTokenSet(first, now);

  // Threads: the first token lasts one hour. The long-lived one lasts sixty days and can be renewed.
  const exchange = new URL(endpointUrl(env, def, 'https://graph.threads.com/access_token'));
  exchange.searchParams.set('grant_type', 'th_exchange_token');
  exchange.searchParams.set('client_secret', input.creds.clientSecret ?? '');
  exchange.searchParams.set('access_token', first.accessToken);
  const longSecrets = [...secrets, first.accessToken];
  const res = await call(env, exchange.toString(), { method: 'GET', headers: { accept: 'application/json' } }, { secrets: longSecrets, fetch: input.fetch });
  const body = jsonOf(res) ?? {};
  const long = readTokens(def.name, { status: res.status, body }, longSecrets);
  return toTokenSet({ ...long, scopes: long.scopes ?? first.scopes }, now, undefined);
}

/** The renewal the definition describes, run once. */
export async function renewTokens(env: ConnectEnv, def: ConnectorDefinition, tokens: TokenSet, creds: AppCredentials | null, instance?: string, client?: { clientId: string; clientSecret: string }): Promise<TokenSet> {
  const now = nowOf(env);
  const renewal = def.tokens?.renewal;
  if (renewal === 'exchange') {
    const url = new URL(endpointUrl(env, def, 'https://graph.threads.com/refresh_access_token'));
    url.searchParams.set('grant_type', 'th_refresh_token');
    url.searchParams.set('access_token', tokens.accessToken);
    const secrets = [tokens.accessToken];
    const res = await call(env, url.toString(), { method: 'GET', headers: { accept: 'application/json' } }, { secrets });
    const next = readTokens(def.name, { status: res.status, body: jsonOf(res) ?? {} }, secrets);
    return toTokenSet({ ...next, scopes: next.scopes ?? (tokens.scopes ?? null) }, now, tokens);
  }
  if (renewal !== 'refresh_token' || !tokens.refreshToken) throw new ConnectFailure('expired', `${def.name} sign-in has expired. Sign in again.`);
  const id = client?.clientId ?? creds?.clientId;
  const secret = client?.clientSecret ?? creds?.clientSecret ?? null;
  if (!id) throw new ConnectFailure('expired', `The ${def.name} app is no longer saved, so the sign-in cannot be renewed. Save the app and sign in again.`);
  const secrets = [tokens.accessToken, tokens.refreshToken, secret ?? ''];
  const answer = await tokenPost(env, def.name, {
    url: tokenEndpoint(env, def, instance),
    params: { grant_type: 'refresh_token', refresh_token: tokens.refreshToken },
    client: { id, secret, auth: def.oauth?.clientAuth ?? 'body' },
    secrets,
  });
  return toTokenSet(readTokens(def.name, answer, secrets), now, tokens);
}

/** Whether a token should be renewed before it is used. */
export function needsRenewal(def: Pick<ConnectorDefinition, 'tokens'>, tokens: TokenSet, now: Date): boolean {
  if (!tokens.expiresAt) return false;
  const remaining = new Date(tokens.expiresAt).getTime() - now.getTime();
  if (def.tokens?.renewal === 'exchange') {
    // Threads allows a renewal once the token is a day old. Renew in the last half of its life.
    const age = now.getTime() - new Date(tokens.obtainedAt).getTime();
    return age >= DAY_MS && remaining < 30 * DAY_MS;
  }
  return remaining < SKEW_MS;
}
