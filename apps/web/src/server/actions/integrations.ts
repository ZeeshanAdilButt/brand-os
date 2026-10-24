import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { connectorFor } from '../../lib/connectors';
import { DIRECTORY, directoryEntry, setupKinds, type SecretKind } from '../../lib/directory';
import { encryptKey, masterKey, SecretUnavailableError } from '../ai/crypto';
import type { AppConfig } from '../config';
import { ActionError, parseInput, type OwnerContext } from './owner';

/*
 * The apps the owner registers on a platform's developer site, kept ahead of connecting. An OAuth app (client id and
 * secret) for the redirect sign-in and a device client for the code sign-in are encrypted at rest (bound to the owner
 * and the row, under the same master key as every other key), shown as a hint of the last four characters only, and
 * wiped by Remove. No route, view or tool returns them. A bare key is no longer accepted here: a platform that takes a
 * key is connected from its Connect drawer, where the key is checked before it is stored. A key saved by an earlier
 * version stays listed so it can be removed.
 */

export interface SavedCredentialDTO {
  kind: SecretKind;
  /** Last four characters of the key, or of the client id. Never the value. */
  hint: string;
  savedAt: string;
}

export interface IntegrationDTO {
  platform: string;
  saved: SavedCredentialDTO[];
}

/** Every directory entry with what the owner saved for it, or an empty list. Values are never included. */
export async function listIntegrations(owner: OwnerContext): Promise<IntegrationDTO[]> {
  const rows = await owner.data.integrationSecrets.list();
  return DIRECTORY.map((entry) => ({
    platform: entry.id,
    saved: rows
      .filter((row) => row.platform === entry.id)
      .map((row) => ({ kind: row.kind, hint: row.hint, savedAt: row.updatedAt.toISOString() })),
  }));
}

const clientId = z.string({ error: 'Paste the client ID.' }).trim().min(4, 'That looks too short.').max(300).refine((v) => !/\s/.test(v), 'Paste only the client ID.');
const clientSecret = z.string().trim().max(600, 'That looks too long.').refine((v) => !/\s/.test(v), 'Paste only the client secret, with no spaces.');

const saveSchema = z
  .object({
    platform: z.string().min(1).max(60),
    kind: z.enum(['oauth_client', 'device_client', 'api_key']),
    clientId: clientId.optional(),
    clientSecret: clientSecret.optional(),
    secret: z.string().optional(),
  })
  .strict();

function seal(config: Pick<AppConfig, 'mode' | 'appSecret' | 'dataDir'>, plain: string, ownerId: string, rowId: string): string {
  try {
    return encryptKey(plain, masterKey(config), ownerId, rowId);
  } catch (err) {
    if (err instanceof SecretUnavailableError) throw new ActionError('unavailable', err.message, { secret: err.message });
    throw err;
  }
}

/** Save (or replace) the app the owner registered for a platform. Only the signed-in owner. */
export async function saveIntegrationSecret(owner: OwnerContext, env: { config: Pick<AppConfig, 'mode' | 'appSecret' | 'dataDir'> }, input: unknown): Promise<SavedCredentialDTO & { platform: string }> {
  if (owner.actor !== 'owner') throw new ActionError('forbidden', 'Saving a credential can only be done by signing in. Agents and AI cannot do this.');
  const values = parseInput(saveSchema, input);
  const entry = directoryEntry(values.platform);
  if (!entry) throw new ActionError('not_found', 'That platform is not in the directory.');
  if (values.kind === 'api_key') {
    throw new ActionError('conflict', `${entry.name} is connected from its Connect drawer, where the key is checked before it is stored. A key saved here would never be used.`, {}, { code: 'USE_CONNECT' });
  }
  const kind = values.kind;
  const def = connectorFor(entry.id);
  if (!def || !setupKinds(entry).includes(kind)) {
    throw new ActionError('conflict', `${entry.name} does not take ${kind === 'oauth_client' ? 'an OAuth app' : 'a device client'}. ${def?.kind === 'manual_only' ? 'It has no API, so there is nothing to save.' : ''}`.trim(), {}, { code: 'NOT_ACCEPTED' });
  }
  if (!values.clientId) throw new ActionError('invalid', 'Some fields need attention.', { clientId: 'Paste the client ID.' });
  const secretNeeded = kind === 'device_client' ? Boolean(def.device?.sendClientSecret) : entry.id !== 'youtube' && def.oauth?.clientAuth !== 'none';
  if (secretNeeded && !values.clientSecret) throw new ActionError('invalid', 'Some fields need attention.', { clientSecret: 'Paste the client secret.' });
  const existing = await owner.data.integrationSecrets.get(entry.id, kind);
  const id = existing?.id ?? randomUUID();
  const plain = JSON.stringify({ clientId: values.clientId, ...(values.clientSecret ? { clientSecret: values.clientSecret } : {}) });
  const row = await owner.data.integrationSecrets.save({ id, platform: entry.id, kind, encrypted: seal(env.config, plain, owner.ownerId, id), hint: values.clientId.slice(-4) });
  await owner.data.audit.record({ actor: owner.actor, action: 'integration.saved', entityType: 'integration_secret', entityId: row.id, metadata: { platform: entry.id, kind, replaced: Boolean(existing) } });
  return { platform: entry.id, kind: row.kind, hint: row.hint, savedAt: row.updatedAt.toISOString() };
}

/** Wipe a saved credential: the ciphertext is deleted. */
export async function removeIntegrationSecret(owner: OwnerContext, platform: unknown, kind: unknown): Promise<void> {
  if (owner.actor !== 'owner') throw new ActionError('forbidden', 'Removing a credential can only be done by signing in.');
  const target = parseInput(z.object({ platform: z.string().min(1).max(60), kind: z.enum(['api_key', 'oauth_client', 'device_client']) }), { platform, kind });
  const removed = await owner.data.integrationSecrets.remove(target.platform, target.kind);
  if (!removed) throw new ActionError('not_found', 'Nothing is saved for that.');
  await owner.data.audit.record({ actor: owner.actor, action: 'integration.removed', entityType: 'integration_secret', entityId: target.platform, metadata: { platform: target.platform, kind: target.kind } });
}
