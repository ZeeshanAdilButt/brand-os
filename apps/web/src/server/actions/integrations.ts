import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DIRECTORY, directoryEntry, setupKinds, type SecretKind } from '../../lib/directory';
import { encryptKey, masterKey, SecretUnavailableError } from '../ai/crypto';
import type { AppConfig } from '../config';
import { ActionError, parseInput, type OwnerContext } from './owner';

/*
 * Credentials for integrations that are not built yet. The owner may save an OAuth client id and secret, or a key,
 * now so everything is ready when the integration lands. They are encrypted at rest (bound to the owner and the
 * row, under the same master key as every other key), shown as "Saved. Not used yet." with the last four
 * characters only, and wiped by Remove. No route, view or tool returns them. Platforms that already work are
 * connected through Connect instead and are refused here, so a saved value is never mistaken for a live one.
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

const secret = z.string({ error: 'Paste the value.' }).trim().min(8, 'That looks too short.').max(600, 'That looks too long.').refine((v) => !/\s/.test(v), 'Paste only the value, with no spaces.');

const saveSchema = z.discriminatedUnion('kind', [
  z.object({ platform: z.string().min(1).max(60), kind: z.literal('api_key'), secret }).strict(),
  z
    .object({
      platform: z.string().min(1).max(60),
      kind: z.literal('oauth_client'),
      clientId: z.string({ error: 'Paste the client ID.' }).trim().min(4, 'That looks too short.').max(300).refine((v) => !/\s/.test(v), 'Paste only the client ID.'),
      clientSecret: secret,
    })
    .strict(),
]);

function seal(config: Pick<AppConfig, 'mode' | 'appSecret' | 'dataDir'>, plain: string, ownerId: string, rowId: string): string {
  try {
    return encryptKey(plain, masterKey(config), ownerId, rowId);
  } catch (err) {
    if (err instanceof SecretUnavailableError) throw new ActionError('unavailable', err.message, { secret: err.message });
    throw err;
  }
}

/** Save (or replace) a credential for a platform that is not built yet. Only the signed-in owner. */
export async function saveIntegrationSecret(owner: OwnerContext, env: { config: Pick<AppConfig, 'mode' | 'appSecret' | 'dataDir'> }, input: unknown): Promise<SavedCredentialDTO & { platform: string }> {
  if (owner.actor !== 'owner') throw new ActionError('forbidden', 'Saving a credential can only be done by signing in. Agents and AI cannot do this.');
  const values = parseInput(saveSchema, input);
  const entry = directoryEntry(values.platform);
  if (!entry) throw new ActionError('not_found', 'That platform is not in the directory.');
  if (entry.adapter) {
    throw new ActionError('conflict', `${entry.name} already works: connect it with the Connect button instead. A value saved here would never be used.`, {}, { code: 'USE_CONNECT' });
  }
  if (!setupKinds(entry).includes(values.kind)) {
    throw new ActionError('conflict', `${entry.name} does not take ${values.kind === 'oauth_client' ? 'an OAuth client' : 'a key'}. ${entry.method === 'manual_only' ? 'It has no API, so there is nothing to save.' : ''}`.trim(), {}, { code: 'NOT_ACCEPTED' });
  }
  const existing = await owner.data.integrationSecrets.get(entry.id, values.kind);
  const id = existing?.id ?? randomUUID();
  const plain = values.kind === 'api_key' ? values.secret : JSON.stringify({ clientId: values.clientId, clientSecret: values.clientSecret });
  const hint = (values.kind === 'api_key' ? values.secret : values.clientId).slice(-4);
  const row = await owner.data.integrationSecrets.save({ id, platform: entry.id, kind: values.kind, encrypted: seal(env.config, plain, owner.ownerId, id), hint });
  await owner.data.audit.record({ actor: owner.actor, action: 'integration.saved', entityType: 'integration_secret', entityId: row.id, metadata: { platform: entry.id, kind: values.kind, replaced: Boolean(existing) } });
  return { platform: entry.id, kind: row.kind, hint: row.hint, savedAt: row.updatedAt.toISOString() };
}

/** Wipe a saved credential: the ciphertext is deleted. */
export async function removeIntegrationSecret(owner: OwnerContext, platform: unknown, kind: unknown): Promise<void> {
  if (owner.actor !== 'owner') throw new ActionError('forbidden', 'Removing a credential can only be done by signing in.');
  const target = parseInput(z.object({ platform: z.string().min(1).max(60), kind: z.enum(['api_key', 'oauth_client']) }), { platform, kind });
  const removed = await owner.data.integrationSecrets.remove(target.platform, target.kind);
  if (!removed) throw new ActionError('not_found', 'Nothing is saved for that.');
  await owner.data.audit.record({ actor: owner.actor, action: 'integration.removed', entityType: 'integration_secret', entityId: target.platform, metadata: { platform: target.platform, kind: target.kind } });
}
