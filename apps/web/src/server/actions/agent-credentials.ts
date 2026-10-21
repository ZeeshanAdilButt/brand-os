import { z } from 'zod';
import { AGENT_SCOPES, CREDENTIAL_LIMITS, type AgentScope, type CredentialDTO } from '../../lib/agent';
import { generateSecret } from '../agent/secret';
import { NotFoundError } from '../data/scope';
import type { PublicCredential } from '../data/agent-credentials';
import { ActionError, parseId, parseInput, type OwnerContext } from './owner';

export const credentialCreateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Give the credential a name so you can tell it apart later.')
    .max(CREDENTIAL_LIMITS.name, `At most ${CREDENTIAL_LIMITS.name} characters.`),
  scopes: z
    .array(z.enum(AGENT_SCOPES))
    .min(1, 'Choose at least one thing this credential may do.')
    .transform((scopes) => [...new Set(scopes)]),
});

export function toCredentialDTO(row: PublicCredential): CredentialDTO {
  return {
    id: row.id,
    name: row.name,
    scopes: row.scopes as AgentScope[],
    prefix: row.prefix,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  };
}

export async function listCredentials(owner: OwnerContext): Promise<CredentialDTO[]> {
  return (await owner.data.credentials.list()).map(toCredentialDTO);
}

/**
 * Create a credential. The secret is in the result exactly once: only its hash is stored, so it can
 * never be shown again. Credentials are created by the signed-in person only; an agent credential
 * cannot mint another.
 */
export async function createCredential(owner: OwnerContext, input: unknown): Promise<{ credential: CredentialDTO; secret: string }> {
  if (owner.actor !== 'owner') throw new ActionError('forbidden', 'Credentials can only be created by signing in.');
  const values = parseInput(credentialCreateSchema, input);
  if ((await owner.data.credentials.countActive()) >= CREDENTIAL_LIMITS.active) {
    throw new ActionError('limit', `You already have ${CREDENTIAL_LIMITS.active} active credentials. Revoke one you no longer use first.`);
  }
  const fresh = generateSecret();
  const row = await owner.data.credentials.create({ name: values.name, scopes: values.scopes, prefix: fresh.prefix, secretHash: fresh.hash });
  await owner.data.audit.record({
    actor: owner.actor,
    action: 'agent_credential.created',
    entityType: 'agent_credential',
    entityId: row.id,
    metadata: { scopes: values.scopes },
  });
  return { credential: toCredentialDTO(row), secret: fresh.secret };
}

/** Revoke a credential at once. Requests that present it afterwards are refused. */
export async function revokeCredential(owner: OwnerContext, id: unknown): Promise<CredentialDTO> {
  if (owner.actor !== 'owner') throw new ActionError('forbidden', 'Credentials can only be revoked by signing in.');
  const credentialId = parseId(id, 'Credential');
  try {
    const row = await owner.data.credentials.revoke(credentialId);
    await owner.data.audit.record({ actor: owner.actor, action: 'agent_credential.revoked', entityType: 'agent_credential', entityId: row.id });
    return toCredentialDTO(row);
  } catch (err) {
    if (err instanceof NotFoundError) throw new ActionError('not_found', 'Credential not found');
    throw err;
  }
}
