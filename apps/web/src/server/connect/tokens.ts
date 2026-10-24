import type { ConnectorDefinition } from '../../lib/connectors';
import type { OwnerContext } from '../actions/owner';
import type { PlatformConnection } from '../db/schema';
import { decodeBundle, encodeBundle, open, seal, type Bundle, type TokenSet } from './bundle';
import { nowOf, sleepOf, type ConnectEnv } from './env';
import { appCredentials, needsRenewal, renewTokens } from './oauth';
import { ConnectFailure } from './request';

/**
 * A usable access token for a sign-in, renewing it first when it is about to expire. Renewal runs under a lease on
 * the connection row, taken with one atomic UPDATE, so two requests that both see an expiring token cannot both spend
 * a single-use refresh token: one renews, the other waits and then reads the new token. A renewal only wins if the
 * connection still has the generation it started from, so a reconnect in the middle is never overwritten.
 */

const LEASE_MS = 30_000;
const WAIT_STEP_MS = 150;
const MAX_WAIT_MS = 10_000;

export interface FreshToken {
  accessToken: string;
  bundle: Bundle;
  row: PlatformConnection;
}

export function primaryFieldOf(def: ConnectorDefinition): string {
  return def.fields.find((f) => f.secret)?.id ?? def.fields[0]?.id ?? 'token';
}

export function readBundle(env: ConnectEnv, def: ConnectorDefinition, row: Pick<PlatformConnection, 'id' | 'ownerId' | 'encryptedKey'>): Bundle {
  return decodeBundle(open(env.config, row.encryptedKey, row.ownerId, row.id), primaryFieldOf(def));
}

/** Renewal is possible when a refresh token is held, or the platform renews the access token itself (Threads). */
export function canRenew(def: ConnectorDefinition, tokens: TokenSet): boolean {
  return def.tokens?.renewal === 'exchange' || (def.tokens?.renewal === 'refresh_token' && Boolean(tokens.refreshToken));
}

export async function freshAccessToken(owner: OwnerContext, env: ConnectEnv, def: ConnectorDefinition, connectionId: string): Promise<FreshToken> {
  const started = nowOf(env).getTime();
  const sleep = sleepOf(env);
  for (;;) {
    const row = await owner.data.connections.getWithKey(connectionId);
    if (!row) throw new ConnectFailure('not_found', `${def.name} is not connected.`);
    const bundle = readBundle(env, def, row);
    const tokens = bundle.tokens;
    if (!tokens) throw new ConnectFailure('rejected', `${def.name} has no sign-in stored. Connect again.`);
    const now = nowOf(env);
    if (!needsRenewal(def, tokens, now)) return { accessToken: tokens.accessToken, bundle, row };

    if (!canRenew(def, tokens)) {
      const expired = tokens.expiresAt ? new Date(tokens.expiresAt).getTime() <= now.getTime() : false;
      if (!expired) return { accessToken: tokens.accessToken, bundle, row };
      await owner.data.connectors.recordValidation(row.id, { status: 'needs_reconnect', errorCode: 'expired', message: `The ${def.name} sign-in has expired. Sign in again.`, now });
      throw new ConnectFailure('expired', `The ${def.name} sign-in has expired. Sign in again.`);
    }

    const generation = await owner.data.connectors.acquireRefreshLease(row.id, now, LEASE_MS);
    if (generation === null) {
      if (nowOf(env).getTime() - started > MAX_WAIT_MS) throw new ConnectFailure('unavailable', `Another renewal of the ${def.name} sign-in is taking too long. Try again in a moment.`);
      await sleep(WAIT_STEP_MS);
      continue;
    }
    try {
      // Read again inside the lease: another request may have finished between our read and our lease.
      const current = await owner.data.connections.getWithKey(connectionId);
      if (!current) throw new ConnectFailure('not_found', `${def.name} is not connected.`);
      const currentBundle = readBundle(env, def, current);
      const currentTokens = currentBundle.tokens;
      if (!currentTokens) throw new ConnectFailure('rejected', `${def.name} has no sign-in stored. Connect again.`);
      if (current.refreshGeneration !== generation || !needsRenewal(def, currentTokens, nowOf(env))) {
        await owner.data.connectors.releaseRefreshLease(row.id, generation);
        if (!needsRenewal(def, currentTokens, nowOf(env))) return { accessToken: currentTokens.accessToken, bundle: currentBundle, row: current };
        continue;
      }
      const creds = def.oauth?.perInstance ? null : await appCredentials(owner, env, def);
      const next = await renewTokens(env, def, currentTokens, creds, currentBundle.client?.instance ?? currentBundle.fields.instance, currentBundle.client);
      const nextBundle: Bundle = { ...currentBundle, tokens: next };
      const stored = await owner.data.connectors.completeRefresh(row.id, generation, {
        encryptedKey: seal(env.config, encodeBundle(nextBundle), owner.ownerId, row.id),
        tokenExpiresAt: next.expiresAt ? new Date(next.expiresAt) : null,
        renewable: canRenew(def, next),
        ...(next.scopes ? { scopesGranted: next.scopes } : {}),
        now: nowOf(env),
      });
      if (!stored) continue;
      return { accessToken: next.accessToken, bundle: nextBundle, row: current };
    } catch (err) {
      await owner.data.connectors.releaseRefreshLease(row.id, generation);
      if (err instanceof ConnectFailure && (err.code === 'expired' || err.code === 'rejected' || err.code === 'denied')) {
        await owner.data.connectors.recordValidation(row.id, { status: 'needs_reconnect', errorCode: err.code, message: err.message, now: nowOf(env) });
      }
      throw err;
    }
  }
}
