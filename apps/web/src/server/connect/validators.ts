import { createHmac } from 'node:crypto';
import { connectorFor, type ConnectorDefinition } from '../../lib/connectors';
import type { ConnectorId } from '../../lib/connectors/ids';
import type { ConnectionConfig } from '../../lib/publishing';
import { checkTarget } from '../ai/target';
import { createSafeFetch } from '../ai/safe-fetch';
import { devtoAdapter } from '../publishing/adapters/devto';
import { githubSiteAdapter } from '../publishing/adapters/github-site';
import { hashnodeAdapter } from '../publishing/adapters/hashnode';
import type { AdapterContext, PlatformAdapter } from '../publishing/adapters/types';
import { baseUrlFor } from '../publishing/registry';
import { endpointUrl, nowOf, timeoutOf, type ConnectEnv } from './env';
import { call, ConnectFailure, fromPlatformError, jsonOf, refusal, unreadable } from './request';

/**
 * `validate()` for every connectable platform: one free, read-only request that answers "whose account is this?" or
 * fails with a plain sentence. Each takes an injected fetch (through `ConnectEnv`), so tests run against fakes and
 * never reach a real platform. The request each one makes is described in the definition (`validation`), and a test
 * compares the two. An unverified connector throws `unverified` and sends nothing.
 */

export interface ValidationInput {
  env: ConnectEnv;
  def: ConnectorDefinition;
  /** Every field the person entered, secret or not. In memory for this call only. */
  fields: Record<string, string>;
  /** The access token of a sign-in. */
  accessToken?: string | undefined;
  /** A per-instance platform's server (Mastodon), already normalized. */
  instance?: string | undefined;
  /** The personal site's repository, from the site settings. */
  site?: { repo: string; baseBranch: string } | undefined;
}

export interface ValidationOk {
  /** Who the platform says this is, for display. */
  account: string;
  config?: ConnectionConfig | undefined;
}

export type Validator = (input: ValidationInput) => Promise<ValidationOk>;

/** Strings that must never appear in a message from this call. */
export function secretsIn(input: Pick<ValidationInput, 'def' | 'fields' | 'accessToken'>): string[] {
  const out: string[] = [];
  for (const field of input.def.fields) if (field.secret && input.fields[field.id]) out.push(input.fields[field.id] as string);
  if (input.accessToken) out.push(input.accessToken);
  return out;
}

const JSON_HEADERS = { accept: 'application/json' };
const bearer = (token: string) => ({ ...JSON_HEADERS, authorization: `Bearer ${token}` });

/** The fetch for an address the person typed. A hosted server resolves the name and refuses private networks. */
export function userHostFetch(env: ConnectEnv): typeof fetch | undefined {
  if (env.fetchFn) return env.fetchFn;
  return env.config.mode === 'hosted' ? createSafeFetch() : undefined;
}

/** Check and normalize a site address the person typed. */
export function userUrl(env: ConnectEnv, raw: string | undefined, label: string): string {
  if (!raw || !raw.trim()) throw new ConnectFailure('bad_input', `${label} is empty.`);
  const target = checkTarget({ mode: env.config.mode, kind: 'api_key', protocol: null, baseUrl: raw });
  if (!target.ok || !target.baseUrl) throw new ConnectFailure('bad_input', `${label}: ${target.message ?? 'that address cannot be used.'}`);
  return target.baseUrl;
}

function required(input: ValidationInput, id: string): string {
  const value = input.fields[id]?.trim();
  if (!value) {
    const label = input.def.fields.find((f) => f.id === id)?.label ?? id;
    throw new ConnectFailure('bad_input', `${label} is empty.`);
  }
  return value;
}

// ---- the three connectors that publish: the adapters' own read-only probes ----------------------------------

function adapterValidator(adapter: PlatformAdapter, platform: 'devto' | 'hashnode' | 'site', secretField: string): Validator {
  return async (input) => {
    const secret = input.accessToken ?? required(input, secretField);
    const ctx: AdapterContext = {
      secret,
      config: {},
      fetch: input.env.fetchFn ?? fetch,
      now: () => nowOf(input.env),
      baseUrl: baseUrlFor(input.env, platform),
      timeoutMs: timeoutOf(input.env),
      ...(input.site ? { site: input.site } : {}),
    };
    try {
      const health = await adapter.health(ctx);
      return { account: health.who, ...(health.config ? { config: health.config } : {}) };
    } catch (err) {
      throw fromPlatformError(err);
    }
  };
}

// ---- GitHub token for one repository -------------------------------------------------------------------------

async function githubRepo(input: ValidationInput, repo: string, token: string): Promise<ValidationOk> {
  const url = endpointUrl(input.env, input.def, `https://api.github.com/repos/${repo}`);
  const secrets = [token];
  const res = await call(input.env, url, { method: 'GET', headers: { ...bearer(token), accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'brand-os' } }, { secrets });
  if (!res.ok) throw refusal('GitHub', 'token', res, input.env, secrets);
  const body = jsonOf(res);
  const fullName = typeof body?.full_name === 'string' ? body.full_name : null;
  if (!fullName) throw unreadable('GitHub');
  const permissions = body?.permissions as { push?: boolean } | undefined;
  if (permissions && permissions.push === false) throw new ConnectFailure('forbidden', `The token can read ${fullName} but not write to it. Give it Contents: read and write.`);
  return { account: fullName };
}

// ---- site credentials ----------------------------------------------------------------------------------------

function b64u(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** The short-lived token Ghost's Admin API wants, signed from the integration key. */
export function ghostToken(key: string, now: Date): string {
  const [id, secret] = key.split(':');
  if (!id || !secret || !/^[0-9a-fA-F]+$/.test(secret)) throw new ConnectFailure('bad_input', 'The Admin API key must look like id:secret, with a hexadecimal secret.');
  const iat = Math.floor(now.getTime() / 1000);
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: id }));
  const body = b64u(JSON.stringify({ iat, exp: iat + 300, aud: '/admin/' }));
  const signature = createHmac('sha256', Buffer.from(secret, 'hex')).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${signature}`;
}

const ghost: Validator = async (input) => {
  const site = userUrl(input.env, input.fields.siteUrl, 'The Ghost site address');
  const key = required(input, 'adminKey');
  const token = ghostToken(key, nowOf(input.env));
  const secrets = [key, token];
  const res = await call(input.env, `${site}/ghost/api/admin/posts/?limit=1`, { method: 'GET', headers: { ...JSON_HEADERS, authorization: `Ghost ${token}`, 'accept-version': 'v5.0' } }, { secrets, fetch: userHostFetch(input.env) });
  if (!res.ok) throw refusal('Ghost', 'Admin API key', res, input.env, secrets);
  if (!jsonOf(res)) throw unreadable('Ghost');
  return { account: new URL(site).host };
};

const wordpress: Validator = async (input) => {
  const site = userUrl(input.env, input.fields.siteUrl, 'The WordPress site address');
  const username = required(input, 'username');
  const password = required(input, 'appPassword').replace(/\s+/g, '');
  const basic = Buffer.from(`${username}:${password}`).toString('base64');
  const secrets = [password, basic, input.fields.appPassword ?? ''];
  const res = await call(input.env, `${site}/wp-json/wp/v2/users/me?context=edit`, { method: 'GET', headers: { ...JSON_HEADERS, authorization: `Basic ${basic}` } }, { secrets, fetch: userHostFetch(input.env) });
  if (!res.ok) throw refusal('WordPress', 'user name and application password', res, input.env, secrets);
  const body = jsonOf(res);
  const name = typeof body?.name === 'string' && body.name ? body.name : typeof body?.slug === 'string' ? body.slug : null;
  if (!name) throw unreadable('WordPress');
  return { account: `${name} on ${new URL(site).host}` };
};

// ---- keys ----------------------------------------------------------------------------------------------------

const beehiiv: Validator = async (input) => {
  const key = required(input, 'apiKey');
  const res = await call(input.env, endpointUrl(input.env, input.def, 'https://api.beehiiv.com/v2/publications'), { method: 'GET', headers: bearer(key) }, { secrets: [key] });
  if (!res.ok) throw refusal('Beehiiv', 'key', res, input.env, [key]);
  const body = jsonOf(res);
  const data = body?.data;
  if (!Array.isArray(data)) throw unreadable('Beehiiv');
  const first = data[0] as { name?: unknown } | undefined;
  return { account: typeof first?.name === 'string' ? first.name : 'Beehiiv account (no publication yet)' };
};

const BUFFER_QUERY = 'query GetOrganizations { account { organizations { id } } }';

const buffer: Validator = async (input) => {
  const key = required(input, 'apiKey');
  const res = await call(input.env, endpointUrl(input.env, input.def, 'https://api.buffer.com'), { method: 'POST', headers: { ...bearer(key), 'content-type': 'application/json' }, body: JSON.stringify({ query: BUFFER_QUERY }) }, { secrets: [key] });
  if (!res.ok) throw refusal('Buffer', 'key', res, input.env, [key]);
  const body = jsonOf(res);
  const orgs = (body?.data as { account?: { organizations?: unknown } } | undefined)?.account?.organizations;
  if (!Array.isArray(orgs)) {
    if (Array.isArray(body?.errors)) throw new ConnectFailure('rejected', 'Buffer did not accept the key.');
    throw unreadable('Buffer');
  }
  return { account: `Buffer account (${orgs.length} organization${orgs.length === 1 ? '' : 's'})` };
};

const POSTIZ_CLOUD = 'https://api.postiz.com/public/v1';

const postiz: Validator = async (input) => {
  const key = required(input, 'apiKey');
  const custom = input.fields.baseUrl?.trim();
  const base = custom ? userUrl(input.env, custom, 'The Postiz API address') : endpointUrl(input.env, input.def, POSTIZ_CLOUD);
  const res = await call(input.env, `${base}/integrations`, { method: 'GET', headers: { ...JSON_HEADERS, authorization: key } }, { secrets: [key], fetch: custom ? userHostFetch(input.env) : undefined });
  if (!res.ok) throw refusal('Postiz', 'key', res, input.env, [key]);
  let list: unknown;
  try {
    list = JSON.parse(res.text);
  } catch {
    throw unreadable('Postiz');
  }
  const n = Array.isArray(list) ? list.length : null;
  return { account: n === null ? `Postiz (${new URL(base).host})` : `Postiz, ${n} channel${n === 1 ? '' : 's'}` };
};

const bluesky: Validator = async (input) => {
  const handle = required(input, 'handle').replace(/^@/, '');
  const password = required(input, 'appPassword');
  const secrets = [password];
  const res = await call(
    input.env,
    endpointUrl(input.env, input.def, 'https://bsky.social/xrpc/com.atproto.server.createSession'),
    { method: 'POST', headers: { ...JSON_HEADERS, 'content-type': 'application/json' }, body: JSON.stringify({ identifier: handle, password }) },
    { secrets },
  );
  if (res.status === 400 || res.status === 401) throw new ConnectFailure('rejected', 'Bluesky did not accept that handle and app password. Check the handle, and use an app password, not your main password.', { httpStatus: res.status });
  if (!res.ok) throw refusal('Bluesky', 'app password', res, input.env, secrets);
  const body = jsonOf(res);
  if (!body || typeof body.handle !== 'string') throw unreadable('Bluesky');
  // The session is dropped on purpose: only the app password is kept.
  return { account: `@${body.handle}` };
};

const discord: Validator = async (input) => {
  const address = required(input, 'webhookUrl');
  const field = input.def.fields[0];
  if (field?.pattern && !new RegExp(field.pattern).test(address)) throw new ConnectFailure('bad_input', 'That does not look like a Discord webhook address. It starts with https://discord.com/api/webhooks/.');
  const res = await call(input.env, endpointUrl(input.env, input.def, address), { method: 'GET', headers: JSON_HEADERS }, { secrets: [address, address.split('/').pop() ?? ''] });
  if (!res.ok) throw refusal('Discord', 'webhook address', res, input.env, [address]);
  const body = jsonOf(res);
  if (!body) throw unreadable('Discord');
  const name = typeof body.name === 'string' && body.name ? body.name : 'Webhook';
  const channel = typeof body.channel_id === 'string' ? ` in channel ${body.channel_id}` : '';
  return { account: `${name}${channel}` };
};

// ---- sign-ins ------------------------------------------------------------------------------------------------

function token(input: ValidationInput): string {
  if (!input.accessToken) throw new ConnectFailure('rejected', 'There is no sign-in to check. Connect first.');
  return input.accessToken;
}

const linkedin: Validator = async (input) => {
  const t = token(input);
  const res = await call(input.env, endpointUrl(input.env, input.def, 'https://api.linkedin.com/v2/userinfo'), { method: 'GET', headers: bearer(t) }, { secrets: [t] });
  if (!res.ok) throw refusal('LinkedIn', 'sign-in', res, input.env, [t]);
  const body = jsonOf(res);
  const name = typeof body?.name === 'string' ? body.name : [body?.given_name, body?.family_name].filter((v) => typeof v === 'string').join(' ');
  if (!name && typeof body?.sub !== 'string') throw unreadable('LinkedIn');
  return { account: name || `LinkedIn member ${String(body?.sub).slice(0, 6)}` };
};

const x: Validator = async (input) => {
  const t = token(input);
  const res = await call(input.env, endpointUrl(input.env, input.def, 'https://api.x.com/2/users/me'), { method: 'GET', headers: bearer(t) }, { secrets: [t] });
  if (!res.ok) throw refusal('X', 'sign-in', res, input.env, [t]);
  const username = (jsonOf(res)?.data as { username?: unknown } | undefined)?.username;
  if (typeof username !== 'string') throw unreadable('X');
  return { account: `@${username}` };
};

const threads: Validator = async (input) => {
  const t = token(input);
  const url = endpointUrl(input.env, input.def, `https://graph.threads.com/me?fields=id,username&access_token=${encodeURIComponent(t)}`);
  const res = await call(input.env, url, { method: 'GET', headers: JSON_HEADERS }, { secrets: [t] });
  if (!res.ok) throw refusal('Threads', 'sign-in', res, input.env, [t]);
  const username = jsonOf(res)?.username;
  if (typeof username !== 'string') throw unreadable('Threads');
  return { account: `@${username}` };
};

const mastodon: Validator = async (input) => {
  const t = token(input);
  const instance = input.instance ?? userUrl(input.env, input.fields.instance, 'Your Mastodon instance');
  const res = await call(input.env, `${instance}/api/v1/accounts/verify_credentials`, { method: 'GET', headers: bearer(t) }, { secrets: [t], fetch: userHostFetch(input.env) });
  if (!res.ok) throw refusal('Mastodon', 'sign-in', res, input.env, [t]);
  const body = jsonOf(res);
  const acct = typeof body?.acct === 'string' ? body.acct : typeof body?.username === 'string' ? body.username : null;
  if (!acct) throw unreadable('Mastodon');
  return { account: acct.includes('@') ? `@${acct}` : `@${acct}@${new URL(instance).host}` };
};

const youtube: Validator = async (input) => {
  const t = token(input);
  const res = await call(input.env, endpointUrl(input.env, input.def, 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true'), { method: 'GET', headers: bearer(t) }, { secrets: [t] });
  if (!res.ok) throw refusal('YouTube', 'sign-in', res, input.env, [t]);
  const items = jsonOf(res)?.items;
  if (!Array.isArray(items)) throw unreadable('YouTube');
  const title = (items[0] as { snippet?: { title?: unknown } } | undefined)?.snippet?.title;
  return { account: typeof title === 'string' && title ? title : 'Google account (no YouTube channel yet)' };
};

// ---- not confirmed on an official page: nothing is sent -------------------------------------------------------

const unverified: Validator = async (input) => {
  const first = input.def.verification.unverified[0] ?? 'it was not confirmed on an official page';
  throw new ConnectFailure('unverified', `${input.def.name} is not connected by this app yet: ${first.charAt(0).toLowerCase()}${first.slice(1)}`);
};

export const VALIDATORS: Partial<Record<ConnectorId, Validator>> = {
  devto: adapterValidator(devtoAdapter, 'devto', 'apiKey'),
  hashnode: adapterValidator(hashnodeAdapter, 'hashnode', 'token'),
  site: adapterValidator(githubSiteAdapter, 'site', 'token'),
  github_releases: (input) => githubRepo(input, required(input, 'repo'), required(input, 'token')),
  ghost,
  wordpress,
  beehiiv,
  buffer,
  postiz,
  bluesky,
  discord,
  linkedin,
  x,
  threads,
  mastodon,
  youtube,
  buttondown: unverified,
  product_hunt: unverified,
  slack: unverified,
};

/** The validator for a connector, or null when there is nothing to validate (manual) or it shares another's. */
export function validatorFor(id: string): Validator | null {
  const def = connectorFor(id);
  if (!def || def.kind === 'manual_only') return null;
  if (def.sharesWith) return VALIDATORS[def.sharesWith] ?? null;
  return VALIDATORS[def.id] ?? null;
}
