import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isPlatformId, isPublishable } from '../../lib/catalog';
import { CONNECTOR_LIST, connectorFor, hasDeviceFlow, isOAuthConnector, takesFields, type ConnectorDefinition } from '../../lib/connectors';
import type { ConnectResult, ConnectorViewDTO, DeviceFlowDTO, DevicePollResult, DisconnectResult, StartOAuthResult } from '../../lib/connectors/dto';
import { connectionState, type ConnectionFacts } from '../../lib/connectors/state';
import type { ConnectionConfig } from '../../lib/publishing';
import { requireOwnerActor, toSiteSettingsDTO } from './publishing';
import type { ConnectFlow, PlatformConnection } from '../db/schema';
import type { PublicConnection } from '../data/publishing';
import type { PublicIntegrationSecret } from '../data/integrations';
import { encodeBundle, hintOf, open, seal, secretsOf, type Bundle, type TokenSet } from '../connect/bundle';
import { pollDevice, requestDeviceCode } from '../connect/device';
import { limitsFor, nowOf, endpointUrl, type ConnectEnv } from '../connect/env';
import { appCredentials, authorizeUrl, exchangeCode, FLOW_TTL_MS, hostAppVariables, pkcePair, randomToken, redirectUriFor, sha256Hex, toTokenSet, type AppCredentials } from '../connect/oauth';
import { call, ConnectFailure, jsonOf, safeMessage, type FailureCode } from '../connect/request';
import { canRenew, freshAccessToken, primaryFieldOf, readBundle } from '../connect/tokens';
import { secretsIn, userHostFetch, userUrl, validatorFor, type ValidationOk } from '../connect/validators';
import { toConnectionDTO } from '../publishing/views';
import { SecretUnavailableError } from '../ai/crypto';
import { ActionError, parseInput, type OwnerContext } from './owner';

/*
 * The connection actions. The browser is the only caller that can use them: every one requires the signed-in owner
 * (agents and AI are refused here, and no agent route, MCP tool or scope reaches this file). Secrets are checked
 * before they are stored, sealed with the owner and row bound in, and never returned: the views carry no token, no
 * ciphertext and no client secret. Every failure message is cleaned of the secrets involved.
 */

const idSchema = z.string().min(1).max(40);

function defOf(id: unknown): ConnectorDefinition {
  const parsed = idSchema.safeParse(id);
  const def = parsed.success ? connectorFor(parsed.data) : null;
  if (!def) throw new ActionError('not_found', 'That platform is not in the directory.');
  return def;
}

const isPublisher = (def: ConnectorDefinition): boolean => isPlatformId(def.id) && isPublishable(def.id);

function failureToAction(failure: ConnectFailure, fieldId?: string): ActionError {
  const fields = fieldId ? { [fieldId]: failure.message } : {};
  switch (failure.code) {
    case 'rejected':
    case 'expired':
    case 'denied':
    case 'bad_input':
      return new ActionError('invalid', failure.message, fields);
    case 'rate_limited':
      return new ActionError('limit', failure.message);
    case 'not_found':
      return new ActionError('invalid', failure.message, fields);
    case 'forbidden':
      return new ActionError('invalid', failure.message, fields);
    case 'unverified':
      return new ActionError('conflict', failure.message, {}, { code: 'UNVERIFIED' });
    default:
      return new ActionError('unavailable', failure.message);
  }
}

function sealed(env: ConnectEnv, plain: string, ownerId: string, rowId: string): string {
  try {
    return seal(env.config, plain, ownerId, rowId);
  } catch (err) {
    if (err instanceof SecretUnavailableError) throw new ActionError('unavailable', err.message, { secret: err.message });
    throw err;
  }
}

function take(env: ConnectEnv, which: 'attempt' | 'validate', owner: OwnerContext, def: ConnectorDefinition): void {
  const result = limitsFor(env)[which].take(`${owner.ownerId}:${def.id}`);
  if (!result.ok) throw new ActionError('limit', `Too many attempts. Wait ${result.retryAfterSec} seconds and try again.`);
}

// ---- views ---------------------------------------------------------------------------------------------------

interface Parts {
  row: PublicConnection | null;
  sharedRow: PublicConnection | null;
  secrets: PublicIntegrationSecret[];
  pendingDevice: ConnectFlow | null;
  host: { web: boolean; device: boolean };
}

function hostHas(env: ConnectEnv, def: ConnectorDefinition, purpose: 'web' | 'device'): boolean {
  if (env.config.mode !== 'hosted') return false;
  const vars = env.processEnv ?? process.env;
  return Boolean(vars[hostAppVariables(def.id, purpose).id]?.trim());
}

function factsOf(row: PublicConnection | null, hasApp: boolean, now: Date): ConnectionFacts {
  return {
    connection: row
      ? {
          status: row.status,
          tokenExpiresAt: row.tokenExpiresAt ? row.tokenExpiresAt.toISOString() : null,
          renewable: row.renewable,
          lastErrorCode: row.lastErrorCode,
          scopesGranted: row.scopesGranted,
        }
      : null,
    hasApp,
    now,
  };
}

function toView(env: ConnectEnv, def: ConnectorDefinition, parts: Parts, now: Date): ConnectorViewDTO {
  const saved = (kind: PublicIntegrationSecret['kind']) => parts.secrets.find((s) => s.platform === def.id && s.kind === kind);
  const web = saved('oauth_client');
  const device = saved('device_client');
  const webApp = Boolean(web) || parts.host.web;
  const deviceApp = Boolean(device) || parts.host.device;
  const shared = def.sharesWith ? connectorFor(def.sharesWith) : null;
  const sharedWebApp = shared ? parts.secrets.some((s) => s.platform === shared.id && s.kind === 'oauth_client') || hostHas(env, shared, 'web') : false;
  const view = connectionState(def, factsOf(parts.row, webApp || deviceApp, now), shared ? factsOf(parts.sharedRow, sharedWebApp, now) : undefined);
  const legacy = saved('api_key');
  const flow = parts.pendingDevice;
  const deviceDto: DeviceFlowDTO | null =
    flow && flow.status === 'pending' && flow.expiresAt > now && flow.userCode && flow.verificationUri
      ? { flowId: flow.id, userCode: flow.userCode, verificationUri: flow.verificationUri, expiresAt: flow.expiresAt.toISOString(), intervalSec: flow.intervalSec ?? 5 }
      : null;
  return {
    id: def.id,
    state: view.state,
    label: view.label,
    detail: view.detail,
    expiresInDays: view.expiresInDays,
    reconnect: view.reconnect,
    connection: parts.row ? toConnectionDTO(parts.row) : null,
    app: { saved: webApp, hint: web?.hint ?? '', source: web ? 'saved' : parts.host.web ? 'host' : null },
    deviceApp: { saved: deviceApp, hint: device?.hint ?? '', source: device ? 'saved' : parts.host.device ? 'host' : null },
    redirectUri: isOAuthConnector(def) ? redirectUriFor(env.config, def.id) : null,
    device: deviceDto,
    legacyKeyHint: legacy ? legacy.hint : null,
    publishes: isPublisher(def),
  };
}

/** One view per directory entry, in directory order. No secret is read: only the public columns. */
export async function listConnectors(owner: OwnerContext, env: ConnectEnv): Promise<ConnectorViewDTO[]> {
  requireOwnerActor(owner, 'Listing connections');
  const [rows, secrets] = await Promise.all([owner.data.connections.list(), owner.data.integrationSecrets.list()]);
  const now = nowOf(env);
  const out: ConnectorViewDTO[] = [];
  for (const def of CONNECTOR_LIST) {
    const pending = hasDeviceFlow(def) ? await owner.data.connectors.pendingFlow(def.id, 'device') : null;
    out.push(
      toView(
        env,
        def,
        {
          row: rows.find((r) => r.platform === def.id) ?? null,
          sharedRow: def.sharesWith ? (rows.find((r) => r.platform === def.sharesWith) ?? null) : null,
          secrets,
          pendingDevice: pending,
          host: { web: hostHas(env, def, 'web'), device: hostHas(env, def, 'device') },
        },
        now,
      ),
    );
  }
  return out;
}

export async function viewOf(owner: OwnerContext, env: ConnectEnv, def: ConnectorDefinition): Promise<ConnectorViewDTO> {
  const [row, sharedRow, secrets, pending] = await Promise.all([
    owner.data.connections.getByPlatform(def.id),
    def.sharesWith ? owner.data.connections.getByPlatform(def.sharesWith) : Promise.resolve(null),
    owner.data.integrationSecrets.list(),
    hasDeviceFlow(def) ? owner.data.connectors.pendingFlow(def.id, 'device') : Promise.resolve(null),
  ]);
  return toView(env, def, { row, sharedRow, secrets, pendingDevice: pending, host: { web: hostHas(env, def, 'web'), device: hostHas(env, def, 'device') } }, nowOf(env));
}

// ---- pasted values -------------------------------------------------------------------------------------------

function fieldSchemaFor(def: ConnectorDefinition) {
  const shape: Record<string, z.ZodType<string | undefined>> = {};
  for (const field of def.fields) {
    let value = z.string().trim().max(600, 'That looks too long.');
    if (field.secret || field.kind === 'url') value = value.refine((v) => !/\s/.test(v) || def.id === 'wordpress', 'Paste only the value, with no spaces.');
    if (field.pattern) {
      const pattern = new RegExp(field.pattern);
      value = value.refine((v) => v === '' || pattern.test(v), `That does not look right. ${field.formatHint}`);
    }
    shape[field.id] = field.required ? value.min(1, `${field.label} is needed.`) : value.optional();
  }
  return z.object(shape).strip();
}

/** Check pasted values and, if the platform accepts them, store them. A refused value is never stored. */
export async function connectWithFields(owner: OwnerContext, env: ConnectEnv, platform: unknown, input: unknown): Promise<ConnectResult> {
  requireOwnerActor(owner, 'Connecting a platform');
  const def = defOf(platform);
  if (!takesFields(def)) throw new ActionError('conflict', `${def.name} is not connected by pasting a value.`, {}, { code: 'NOT_PASTED' });
  if (def.verification.level === 'unverified') throw new ActionError('conflict', `${def.name} cannot be connected yet: ${def.verification.unverified[0] ?? 'it is not confirmed on an official page.'}`, {}, { code: 'UNVERIFIED' });
  take(env, 'attempt', owner, def);
  const values = parseInput(fieldSchemaFor(def), (input as { fields?: unknown } | null)?.fields ?? input) as Record<string, string | undefined>;
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) if (v) fields[k] = v;

  let site: { repo: string; baseBranch: string } | undefined;
  if (def.id === 'site') {
    const settings = toSiteSettingsDTO(await owner.data.siteSettings.get());
    if (!settings.repo) throw new ActionError('conflict', 'Save the repository (owner/name) first, then connect the GitHub token.', { token: 'Save the repository first.' }, { code: 'NO_REPO' });
    site = { repo: settings.repo, baseBranch: settings.baseBranch };
  }
  const validator = validatorFor(def.id);
  if (!validator) throw new ActionError('conflict', `${def.name} has nothing to check.`);
  const secrets = secretsIn({ def, fields });
  const primary = primaryFieldOf(def);
  let ok: ValidationOk;
  try {
    ok = await validator({ env, def, fields, site });
  } catch (err) {
    const failure = err instanceof ConnectFailure ? err : new ConnectFailure('unexpected', 'The check failed for a reason this app does not know.');
    await owner.data.audit.record({ actor: owner.actor, action: 'connect.failed', entityType: 'platform_connection', entityId: def.id, metadata: { platform: def.id, code: failure.code } });
    const clean = new ConnectFailure(failure.code, safeMessage(failure.message, secrets), failure.options);
    throw failureToAction(clean, def.fields.find((f) => f.secret)?.id ?? primary);
  }

  const existing = await owner.data.connections.getByPlatform(def.id);
  const id = existing?.id ?? randomUUID();
  const nonSecret = Object.fromEntries(def.fields.filter((f) => !f.secret && fields[f.id]).map((f) => [f.id, fields[f.id] as string]));
  const config: ConnectionConfig = { ...(ok.config ?? {}), ...(Object.keys(nonSecret).length > 0 ? { fields: nonSecret } : {}) };
  const plain = isPublisher(def) ? (fields[primary] as string) : encodeBundle({ fields });
  const saved = await owner.data.connectors.save({
    id,
    platform: def.id,
    encryptedKey: sealed(env, plain, owner.ownerId, id),
    keyLast4: hintOf(fields[primary]),
    status: 'connected',
    who: ok.account,
    config,
    authKind: def.kind,
    scopesGranted: [],
    tokenExpiresAt: null,
    renewable: false,
    message: null,
    now: nowOf(env),
  });
  await owner.data.integrationSecrets.remove(def.id, 'api_key');
  await owner.data.audit.record({ actor: owner.actor, action: 'connect.connected', entityType: 'platform_connection', entityId: saved.id, metadata: { platform: def.id, kind: def.kind, replaced: Boolean(existing) } });
  return { ok: true, message: `Connected as ${ok.account}.`, account: ok.account, view: await viewOf(owner, env, def) };
}

// ---- test ----------------------------------------------------------------------------------------------------

const LOST: ReadonlySet<FailureCode> = new Set(['rejected', 'expired', 'denied']);

/** Re-run the one read-only check and record the result. A refused sign-in or key becomes "Needs reconnect". */
export async function testConnector(owner: OwnerContext, env: ConnectEnv, platform: unknown): Promise<ConnectResult> {
  requireOwnerActor(owner, 'Testing a connection');
  const def = defOf(platform);
  if (def.kind === 'manual_only') throw new ActionError('conflict', `${def.name} has nothing to test.`, {}, { code: 'MANUAL' });
  const owning = def.sharesWith ? (connectorFor(def.sharesWith) as ConnectorDefinition) : def;
  const summary = await owner.data.connections.getByPlatform(owning.id);
  if (!summary) throw new ActionError('not_found', `${def.name} is not connected yet.`);
  take(env, 'validate', owner, def);
  const row = await owner.data.connections.getWithKey(summary.id);
  if (!row) throw new ActionError('not_found', `${def.name} is not connected yet.`);

  const validator = validatorFor(def.id);
  if (!validator) throw new ActionError('conflict', `${def.name} has nothing to test.`);
  let bundle: Bundle;
  try {
    bundle = readBundle(env, owning, row);
  } catch (err) {
    const message = err instanceof SecretUnavailableError ? err.message : 'The saved connection could not be read.';
    await owner.data.connectors.recordValidation(row.id, { status: 'needs_reconnect', errorCode: 'unavailable', message, now: nowOf(env) });
    return { ok: false, message, view: await viewOf(owner, env, def) };
  }
  let secrets = secretsOf(bundle, owning.fields.filter((f) => f.secret).map((f) => f.id));
  try {
    let accessToken: string | undefined;
    if (bundle.tokens) {
      const fresh = await freshAccessToken(owner, env, owning, row.id);
      accessToken = fresh.accessToken;
      secrets = secretsOf(fresh.bundle, owning.fields.filter((f) => f.secret).map((f) => f.id));
      bundle = fresh.bundle;
    }
    let site: { repo: string; baseBranch: string } | undefined;
    if (owning.id === 'site') {
      const settings = toSiteSettingsDTO(await owner.data.siteSettings.get());
      if (!settings.repo) throw new ConnectFailure('bad_input', 'Save the repository (owner/name) first.');
      site = { repo: settings.repo, baseBranch: settings.baseBranch };
    }
    const ok = await validator({ env, def: owning, fields: bundle.fields, accessToken, instance: bundle.client?.instance, site });
    const keepPublication = row.config.publicationId && ok.config?.publications?.some((p) => p.id === row.config.publicationId);
    const config: ConnectionConfig = {
      ...(ok.config ?? row.config),
      ...(keepPublication ? { publicationId: row.config.publicationId as string, ...(row.config.publicationTitle ? { publicationTitle: row.config.publicationTitle } : {}) } : {}),
      ...(row.config.fields ? { fields: row.config.fields } : {}),
    };
    await owner.data.connectors.recordValidation(row.id, { status: 'connected', who: ok.account, config, errorCode: null, message: null, now: nowOf(env) });
    await owner.data.audit.record({ actor: owner.actor, action: 'connect.tested', entityType: 'platform_connection', entityId: row.id, metadata: { platform: def.id, ok: true } });
    return { ok: true, message: `Connected as ${ok.account}.`, account: ok.account, view: await viewOf(owner, env, def) };
  } catch (err) {
    const failure = err instanceof ConnectFailure ? err : new ConnectFailure('unexpected', 'The check failed for a reason this app does not know.');
    const message = safeMessage(failure.message, secrets);
    await owner.data.connectors.recordValidation(row.id, { status: LOST.has(failure.code) ? 'needs_reconnect' : 'error', errorCode: failure.code, message, now: nowOf(env) });
    await owner.data.audit.record({ actor: owner.actor, action: 'connect.tested', entityType: 'platform_connection', entityId: row.id, metadata: { platform: def.id, ok: false, code: failure.code } });
    return { ok: false, message, view: await viewOf(owner, env, def) };
  }
}

// ---- sign in with the platform -------------------------------------------------------------------------------

const startSchema = z
  .object({
    /** Optional scopes the person ticked. Required scopes are always included. */
    scopes: z.array(z.string().min(1).max(200)).max(12).optional(),
    /** The person's own server, for a platform with one client per server (Mastodon). */
    instance: z.string().max(300).optional(),
  })
  .strip();

function chooseScopes(def: ConnectorDefinition, wanted: string[] | undefined, pool: ConnectorDefinition['scopes']): string[] {
  const names = new Set(pool.map((s) => s.name));
  for (const name of wanted ?? []) if (!names.has(name)) throw new ActionError('invalid', `${name} is not a scope ${def.name} offers here.`, { scopes: 'Choose from the list.' });
  return pool.filter((s) => s.required || (wanted ?? []).includes(s.name)).map((s) => s.name);
}

/** Register the app on the person's own Mastodon server (a public call) unless a matching one is already saved. */
async function mastodonClient(owner: OwnerContext, env: ConnectEnv, def: ConnectorDefinition, instance: string, scopes: string[], redirectUri: string): Promise<AppCredentials> {
  const existing = await appCredentials(owner, env, def, 'web');
  if (existing && existing.instance === instance && existing.redirectUri === redirectUri && scopes.every((s) => existing.scopes?.includes(s))) return existing;
  const body = new URLSearchParams({ client_name: 'Brand OS', redirect_uris: redirectUri, scopes: scopes.join(' '), website: env.config.appUrl });
  const res = await call(env, `${instance}/api/v1/apps`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() }, { secrets: [], fetch: userHostFetch(env) });
  if (!res.ok) throw new ConnectFailure(res.status === 422 ? 'bad_input' : 'unreachable', `Your instance did not accept the app registration (HTTP ${res.status}). Check the address.`);
  const parsed = jsonOf(res);
  const clientId = typeof parsed?.client_id === 'string' ? parsed.client_id : null;
  const clientSecret = typeof parsed?.client_secret === 'string' ? parsed.client_secret : null;
  if (!clientId || !clientSecret) throw new ConnectFailure('unexpected', 'Your instance answered the app registration with something this app could not read.');
  const current = await owner.data.integrationSecrets.get(def.id, 'oauth_client');
  const id = current?.id ?? randomUUID();
  await owner.data.integrationSecrets.save({ id, platform: def.id, kind: 'oauth_client', encrypted: sealed(env, JSON.stringify({ clientId, clientSecret, instance, scopes, redirectUri }), owner.ownerId, id), hint: clientId.slice(-4) });
  return { clientId, clientSecret, source: 'saved', instance, scopes, redirectUri };
}

/** Begin the redirect sign-in: store a single-use state bound to this session and return the platform's address. */
export async function startOAuth(owner: OwnerContext, env: ConnectEnv, platform: unknown, input: unknown = {}): Promise<StartOAuthResult> {
  requireOwnerActor(owner, 'Connecting a platform');
  const def = defOf(platform);
  if (!isOAuthConnector(def) || !def.oauth) throw new ActionError('conflict', `${def.name} does not sign in with a redirect.`, {}, { code: 'NOT_OAUTH' });
  if (def.verification.level === 'unverified') throw new ActionError('conflict', `${def.name} cannot be connected yet.`, {}, { code: 'UNVERIFIED' });
  const options = parseInput(startSchema, input);
  take(env, 'attempt', owner, def);
  const scopes = chooseScopes(def, options.scopes, def.scopes);
  const redirectUri = redirectUriFor(env.config, def.id);
  const now = nowOf(env);
  try {
    let creds: AppCredentials | null;
    let instance: string | undefined;
    if (def.oauth.perInstance) {
      instance = userUrl(env, options.instance ?? '', 'Your Mastodon instance');
      creds = await mastodonClient(owner, env, def, instance, scopes, redirectUri);
    } else {
      creds = await appCredentials(owner, env, def, 'web');
      if (!creds) throw new ConnectFailure('bad_input', `Save your ${def.name} app first (its client ID and secret), then sign in.`);
      if (!creds.clientSecret && def.oauth.clientAuth !== 'none' && def.id !== 'youtube') throw new ConnectFailure('bad_input', `The saved ${def.name} app has no client secret. Save it again with the secret.`);
    }
    const pkce = def.oauth.pkce === 'always' ? pkcePair(env) : null;
    const state = randomToken(env, 32);
    await owner.data.connectors.purgeFlows(now);
    await owner.data.connectors.cancelPendingFlows(def.id);
    const flowId = randomUUID();
    const expiresAt = new Date(now.getTime() + FLOW_TTL_MS);
    await owner.data.connectors.createFlow({
      id: flowId,
      platform: def.id,
      kind: 'oauth',
      stateHash: sha256Hex(state),
      sessionHash: sha256Hex(owner.sessionId),
      redirectUri,
      codeVerifierEnc: pkce ? sealed(env, pkce.verifier, owner.ownerId, flowId) : null,
      deviceCodeEnc: null,
      userCode: null,
      verificationUri: null,
      intervalSec: null,
      nextPollAt: null,
      scopes,
      instance: instance ?? null,
      expiresAt,
    });
    await owner.data.audit.record({ actor: owner.actor, action: 'connect.started', entityType: 'connect_flow', entityId: flowId, metadata: { platform: def.id, kind: 'oauth' } });
    return { flowId, authorizeUrl: authorizeUrl(env, def, { clientId: creds.clientId, redirectUri, scopes, state, challenge: pkce?.challenge ?? null, instance }), redirectUri, expiresAt: expiresAt.toISOString() };
  } catch (err) {
    if (err instanceof ConnectFailure) throw failureToAction(err);
    throw err;
  }
}

export type CallbackCode = 'connected' | 'denied' | 'state' | 'session' | 'exchange' | 'check' | 'expired' | 'error';

export interface CallbackResult {
  platform: string | null;
  code: CallbackCode;
}

const STATE_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Finish the redirect sign-in. Never throws for an expected problem: the route turns the code into a redirect. */
export async function completeOAuth(owner: OwnerContext, env: ConnectEnv, platform: unknown, query: { code?: string | null; state?: string | null; error?: string | null }): Promise<CallbackResult> {
  requireOwnerActor(owner, 'Connecting a platform');
  const def = connectorFor(typeof platform === 'string' ? platform : '');
  if (!def || !isOAuthConnector(def) || !def.oauth) return { platform: null, code: 'state' };
  const result = (code: CallbackCode): CallbackResult => ({ platform: def.id, code });
  const callbackLimit = limitsFor(env).callback.take(owner.ownerId);
  if (!callbackLimit.ok) return result('error');
  const state = query.state ?? '';
  if (!STATE_SHAPE.test(state)) return result('state');
  const flow = await owner.data.connectors.findFlowByState(sha256Hex(state));
  // A state this session did not start, for another platform, or that is already used is the same answer: not valid.
  if (!flow || flow.kind !== 'oauth' || flow.platform !== def.id) return result('state');
  if (flow.sessionHash !== sha256Hex(owner.sessionId)) {
    await owner.data.audit.record({ actor: owner.actor, action: 'connect.callback_refused', entityType: 'connect_flow', entityId: flow.id, metadata: { platform: def.id, reason: 'session' } });
    return result('session');
  }
  const now = nowOf(env);
  const spent = await owner.data.connectors.consumeFlow(flow.id, now);
  if (!spent) return result(flow.status === 'pending' ? 'expired' : 'state');
  if (query.error) {
    await owner.data.audit.record({ actor: owner.actor, action: 'connect.denied', entityType: 'connect_flow', entityId: flow.id, metadata: { platform: def.id } });
    return result(query.error === 'access_denied' || /cancel|denied/.test(query.error) ? 'denied' : 'exchange');
  }
  const code = query.code ?? '';
  if (!code || code.length > 2000) return result('exchange');

  const secrets: string[] = [code];
  let step: CallbackCode = 'exchange';
  try {
    const creds = await appCredentials(owner, env, def, 'web');
    if (!creds) throw new ConnectFailure('bad_input', `The ${def.name} app is no longer saved.`);
    const instance = spent.instance ?? creds.instance ?? undefined;
    const verifier = spent.codeVerifierEnc ? open(env.config, spent.codeVerifierEnc, owner.ownerId, spent.id) : null;
    secrets.push(creds.clientSecret ?? '', verifier ?? '');
    const tokens = await exchangeCode(env, def, { code, verifier, redirectUri: spent.redirectUri ?? redirectUriFor(env.config, def.id), creds, instance, fetch: def.oauth.perInstance ? userHostFetch(env) : undefined });
    secrets.push(tokens.accessToken, tokens.refreshToken ?? '');
    const granted = tokens.scopes && tokens.scopes.length > 0 ? tokens.scopes : spent.scopes;
    step = 'check';
    await saveSignIn(owner, env, def, tokens, granted, instance, creds, 'oauth2_code_pkce');
    return result('connected');
  } catch (err) {
    const failure = err instanceof ConnectFailure ? err : new ConnectFailure('unexpected', 'The sign-in failed for a reason this app does not know.');
    await owner.data.audit.record({ actor: owner.actor, action: 'connect.failed', entityType: 'connect_flow', entityId: flow.id, metadata: { platform: def.id, code: failure.code } });
    await remember(owner, def, failure, secrets);
    return result(failure.code === 'denied' ? 'denied' : failure.code === 'expired' && step === 'exchange' ? 'expired' : step);
  }
}

/** Keep a short, clean explanation of the last sign-in failure on an existing connection, so the drawer can show it. */
async function remember(owner: OwnerContext, def: ConnectorDefinition, failure: ConnectFailure, secrets: readonly string[]): Promise<void> {
  const row = await owner.data.connections.getByPlatform(def.id);
  if (row) await owner.data.connectors.recordValidation(row.id, { status: row.status, errorCode: failure.code, message: safeMessage(failure.message, secrets) });
}

/** Validate a fresh sign-in with its own token, then store it. A failed check throws and nothing is stored. */
async function saveSignIn(
  owner: OwnerContext,
  env: ConnectEnv,
  def: ConnectorDefinition,
  tokens: TokenSet,
  granted: string[],
  instance: string | undefined,
  creds: AppCredentials | null,
  authKind: 'oauth2_code_pkce' | 'device_flow',
): Promise<void> {
  const validator = validatorFor(def.id);
  if (!validator) throw new ConnectFailure('unexpected', `${def.name} has nothing to check.`);
  const site = def.id === 'site' ? toSiteSettingsDTO(await owner.data.siteSettings.get()) : null;
  const ok = await validator({ env, def, fields: instance ? { instance } : {}, accessToken: tokens.accessToken, instance, ...(site?.repo ? { site: { repo: site.repo, baseBranch: site.baseBranch } } : {}) });
  const existing = await owner.data.connections.getByPlatform(def.id);
  const id = existing?.id ?? randomUUID();
  const bundle: Omit<Bundle, 'cphBundle'> = {
    fields: instance ? { instance } : {},
    tokens,
    ...(instance && creds?.clientSecret ? { client: { clientId: creds.clientId, clientSecret: creds.clientSecret, instance } } : {}),
  };
  const saved = await owner.data.connectors.save({
    id,
    platform: def.id,
    encryptedKey: sealed(env, encodeBundle(bundle), owner.ownerId, id),
    keyLast4: '',
    status: 'connected',
    who: ok.account,
    config: { ...(ok.config ?? {}), ...(instance ? { fields: { instance } } : {}) },
    authKind,
    scopesGranted: granted,
    tokenExpiresAt: tokens.expiresAt ? new Date(tokens.expiresAt) : null,
    renewable: canRenew(def, tokens),
    message: null,
    now: nowOf(env),
  });
  await owner.data.audit.record({ actor: owner.actor, action: 'connect.connected', entityType: 'platform_connection', entityId: saved.id, metadata: { platform: def.id, kind: authKind, replaced: Boolean(existing) } });
}

// ---- sign in with a code (device flow) -----------------------------------------------------------------------

/** Begin the code sign-in: ask the platform for a code and keep the device code encrypted. */
export async function startDevice(owner: OwnerContext, env: ConnectEnv, platform: unknown, input: unknown = {}): Promise<DeviceFlowDTO> {
  requireOwnerActor(owner, 'Connecting a platform');
  const def = defOf(platform);
  if (!hasDeviceFlow(def) || !def.device) throw new ActionError('conflict', `${def.name} does not offer a sign-in with a code.`, {}, { code: 'NOT_DEVICE' });
  const options = parseInput(startSchema, input);
  take(env, 'attempt', owner, def);
  const scopes = chooseScopes(def, options.scopes, def.device.scopes);
  const now = nowOf(env);
  try {
    const creds = await appCredentials(owner, env, def, 'device');
    if (!creds) throw new ConnectFailure('bad_input', `Save your ${def.name} device client ID first, then ask for a code.`);
    const code = await requestDeviceCode(env, def, creds, scopes);
    await owner.data.connectors.purgeFlows(now);
    await owner.data.connectors.cancelPendingFlows(def.id);
    const flowId = randomUUID();
    const expiresAt = new Date(now.getTime() + Math.min(code.expiresInSec * 1000, FLOW_TTL_MS + 5 * 60_000));
    await owner.data.connectors.createFlow({
      id: flowId,
      platform: def.id,
      kind: 'device',
      stateHash: null,
      sessionHash: sha256Hex(owner.sessionId),
      redirectUri: null,
      codeVerifierEnc: null,
      deviceCodeEnc: sealed(env, code.deviceCode, owner.ownerId, flowId),
      userCode: code.userCode,
      verificationUri: code.verificationUri,
      intervalSec: code.intervalSec,
      nextPollAt: new Date(now.getTime() + code.intervalSec * 1000),
      scopes,
      instance: null,
      expiresAt,
    });
    await owner.data.audit.record({ actor: owner.actor, action: 'connect.started', entityType: 'connect_flow', entityId: flowId, metadata: { platform: def.id, kind: 'device' } });
    return { flowId, userCode: code.userCode, verificationUri: code.verificationUri, expiresAt: expiresAt.toISOString(), intervalSec: code.intervalSec };
  } catch (err) {
    if (err instanceof ConnectFailure) throw failureToAction(err);
    throw err;
  }
}

/** Ask once whether the code was entered. It never asks sooner than the platform's interval. */
export async function pollDeviceFlow(owner: OwnerContext, env: ConnectEnv, platform: unknown, flowId: unknown): Promise<DevicePollResult> {
  requireOwnerActor(owner, 'Connecting a platform');
  const def = defOf(platform);
  const id = z.uuid().safeParse(flowId);
  if (!id.success) throw new ActionError('not_found', 'That sign-in is not waiting any more.');
  const flow = await owner.data.connectors.getFlow(id.data);
  if (!flow || flow.platform !== def.id || flow.kind !== 'device' || flow.sessionHash !== sha256Hex(owner.sessionId)) throw new ActionError('not_found', 'That sign-in is not waiting any more.');
  const now = nowOf(env);
  if (flow.status !== 'pending') return { state: 'expired', message: 'That code is no longer waiting. Ask for a new one.' };
  if (flow.expiresAt <= now) {
    await owner.data.connectors.setFlowStatus(flow.id, 'expired');
    return { state: 'expired', message: 'The code expired. Ask for a new one.' };
  }
  const interval = flow.intervalSec ?? 5;
  if (flow.nextPollAt && flow.nextPollAt > now) return { state: 'pending', intervalSec: interval, retryAfterSec: Math.max(1, Math.ceil((flow.nextPollAt.getTime() - now.getTime()) / 1000)) };
  let secrets: string[] = [];
  try {
    const creds = await appCredentials(owner, env, def, 'device');
    if (!creds || !flow.deviceCodeEnc) throw new ConnectFailure('bad_input', `The ${def.name} device client is no longer saved.`);
    const deviceCode = open(env.config, flow.deviceCodeEnc, owner.ownerId, flow.id);
    secrets = [deviceCode, creds.clientSecret ?? ''];
    const polled = await pollDevice(env, def, creds, deviceCode, interval);
    if (polled.state === 'pending' || polled.state === 'slow_down') {
      await owner.data.connectors.setFlowPoll(flow.id, { intervalSec: polled.intervalSec, nextPollAt: new Date(now.getTime() + polled.intervalSec * 1000) });
      return { state: 'pending', intervalSec: polled.intervalSec, retryAfterSec: polled.intervalSec };
    }
    if (polled.state === 'expired') {
      await owner.data.connectors.setFlowStatus(flow.id, 'expired');
      return { state: 'expired', message: 'The code expired. Ask for a new one.' };
    }
    if (polled.state === 'denied') {
      await owner.data.connectors.setFlowStatus(flow.id, 'cancelled');
      return { state: 'denied', message: `You declined access on ${def.name}.` };
    }
    const spent = await owner.data.connectors.consumeFlow(flow.id, now);
    if (!spent) return { state: 'expired', message: 'That code was already used.' };
    secrets.push(polled.tokens.accessToken, polled.tokens.refreshToken ?? '');
    const tokens = toTokenSet(polled.tokens, now);
    const granted = polled.tokens.scopes && polled.tokens.scopes.length > 0 ? polled.tokens.scopes : spent.scopes;
    await saveSignIn(owner, env, def, tokens, granted, undefined, creds, 'device_flow');
    const view = await viewOf(owner, env, def);
    return { state: 'connected', view, account: view.connection?.who ?? def.name };
  } catch (err) {
    const failure = err instanceof ConnectFailure ? err : new ConnectFailure('unexpected', 'The sign-in failed for a reason this app does not know.');
    await owner.data.connectors.setFlowStatus(flow.id, 'failed');
    await owner.data.audit.record({ actor: owner.actor, action: 'connect.failed', entityType: 'connect_flow', entityId: flow.id, metadata: { platform: def.id, code: failure.code } });
    throw failureToAction(new ConnectFailure(failure.code, safeMessage(failure.message, secrets), failure.options));
  }
}

/** Stop waiting for a code. */
export async function cancelDevice(owner: OwnerContext, env: ConnectEnv, platform: unknown): Promise<ConnectorViewDTO> {
  requireOwnerActor(owner, 'Connecting a platform');
  const def = defOf(platform);
  await owner.data.connectors.cancelPendingFlows(def.id);
  await owner.data.audit.record({ actor: owner.actor, action: 'connect.cancelled', entityType: 'platform_connection', entityId: def.id, metadata: { platform: def.id } });
  return viewOf(owner, env, def);
}

// ---- disconnect ----------------------------------------------------------------------------------------------

async function revokeAtProvider(env: ConnectEnv, def: ConnectorDefinition, bundle: Bundle): Promise<boolean> {
  const token = bundle.tokens?.refreshToken ?? bundle.tokens?.accessToken;
  if (!def.revoke?.provider || !token) return false;
  const secrets = [token, bundle.client?.clientSecret ?? ''];
  try {
    if (def.id === 'youtube') {
      const res = await call(env, endpointUrl(env, def, def.endpoints.revoke as string), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString() }, { secrets });
      return res.ok;
    }
    if (def.id === 'mastodon' && bundle.client) {
      const res = await call(env, `${bundle.client.instance}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: bundle.client.clientId, client_secret: bundle.client.clientSecret, token }).toString() }, { secrets, fetch: userHostFetch(env) });
      return res.ok;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Delete the stored secret, and revoke the grant at the platform where it has an official revoke. If the revoke fails
 * or does not exist the secret is deleted anyway and the person is told what to do on the platform.
 */
export async function disconnectConnector(owner: OwnerContext, env: ConnectEnv, platform: unknown): Promise<DisconnectResult> {
  requireOwnerActor(owner, 'Disconnecting a platform');
  const def = defOf(platform);
  if (def.sharesWith) throw new ActionError('conflict', `${def.name} uses the ${connectorFor(def.sharesWith)?.name ?? 'other'} sign-in. Disconnect that one.`, {}, { code: 'SHARED' });
  const summary = await owner.data.connections.getByPlatform(def.id);
  if (!summary) throw new ActionError('not_found', `${def.name} is not connected.`);
  const row = await owner.data.connections.getWithKey(summary.id);
  let revoked = false;
  if (row && def.revoke?.provider) {
    try {
      revoked = await revokeAtProvider(env, def, readBundle(env, def, row));
    } catch {
      revoked = false;
    }
  }
  await owner.data.connectors.cancelPendingFlows(def.id);
  await owner.data.connections.remove(summary.id);
  await owner.data.audit.record({ actor: owner.actor, action: 'connect.disconnected', entityType: 'platform_connection', entityId: summary.id, metadata: { platform: def.id, revoked } });
  const steps = def.revoke?.manualSteps ?? [];
  return {
    revoked: revoked ? 'provider' : 'manual',
    message: revoked ? `Disconnected. ${def.name} revoked the access and the stored secret was deleted.` : `Disconnected. The stored secret was deleted from this app. To end the access completely, finish on ${def.name}.`,
    steps: revoked ? [] : steps,
    view: await viewOf(owner, env, def),
  };
}

export type { PlatformConnection };
