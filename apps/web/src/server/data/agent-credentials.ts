import { and, count, desc, eq, isNull } from 'drizzle-orm';
import type { AppDb } from '../db/client';
import { agentCredentials, users, type AgentCredential } from '../db/schema';
import type { AgentScope } from '../../lib/agent';
import { NotFoundError, type Scope } from './scope';

export interface CredentialInsert {
  name: string;
  prefix: string;
  secretHash: string;
  scopes: AgentScope[];
}

/** Tenant-scoped access to one owner's agent credentials. The hash is never part of a listing. */
export function scopedCredentials(scope: Scope) {
  const owned = (id: string) => and(eq(agentCredentials.ownerId, scope.ownerId), eq(agentCredentials.id, id));
  const { secretHash: _hash, ...visible } = agentCredentialColumns();
  void _hash;

  return {
    async list(): Promise<PublicCredential[]> {
      const db = await scope.db();
      return db
        .select(visible)
        .from(agentCredentials)
        .where(eq(agentCredentials.ownerId, scope.ownerId))
        .orderBy(desc(agentCredentials.createdAt));
    },

    async get(id: string): Promise<PublicCredential | null> {
      const db = await scope.db();
      const [row] = await db.select(visible).from(agentCredentials).where(owned(id));
      return row ?? null;
    },

    async countActive(): Promise<number> {
      const db = await scope.db();
      const [row] = await db
        .select({ n: count() })
        .from(agentCredentials)
        .where(and(eq(agentCredentials.ownerId, scope.ownerId), isNull(agentCredentials.revokedAt)));
      return Number(row?.n ?? 0);
    },

    async create(input: CredentialInsert): Promise<PublicCredential> {
      const db = await scope.db();
      const [row] = await db
        .insert(agentCredentials)
        .values({ ...input, ownerId: scope.ownerId })
        .returning(visible);
      if (!row) throw new Error('credential insert returned no row');
      return row;
    },

    /** Revoke is permanent and idempotent. Returns the credential, or throws NotFoundError for someone else's. */
    async revoke(id: string): Promise<PublicCredential> {
      const db = await scope.db();
      const [row] = await db
        .update(agentCredentials)
        .set({ revokedAt: new Date() })
        .where(and(owned(id), isNull(agentCredentials.revokedAt)))
        .returning(visible);
      if (row) return row;
      const existing = await this.get(id);
      if (!existing) throw new NotFoundError('credential');
      return existing;
    },

    /** Record that the credential was used just now. */
    async touch(id: string): Promise<void> {
      const db = await scope.db();
      await db.update(agentCredentials).set({ lastUsedAt: new Date() }).where(owned(id));
    },
  };
}

export type PublicCredential = Omit<AgentCredential, 'secretHash'>;

function agentCredentialColumns() {
  return {
    id: agentCredentials.id,
    ownerId: agentCredentials.ownerId,
    name: agentCredentials.name,
    prefix: agentCredentials.prefix,
    secretHash: agentCredentials.secretHash,
    scopes: agentCredentials.scopes,
    createdAt: agentCredentials.createdAt,
    lastUsedAt: agentCredentials.lastUsedAt,
    revokedAt: agentCredentials.revokedAt,
  };
}

/**
 * The one lookup that is not scoped to an owner, because it is how the owner is found: a presented
 * secret's hash identifies the credential and therefore whose data the request may touch. It returns
 * only identity facts, and only for an account that still exists.
 */
export async function findCredentialBySecretHash(
  db: AppDb,
  secretHash: string,
): Promise<{ id: string; ownerId: string; name: string; scopes: AgentScope[]; revokedAt: Date | null } | null> {
  const [row] = await db
    .select({
      id: agentCredentials.id,
      ownerId: agentCredentials.ownerId,
      name: agentCredentials.name,
      scopes: agentCredentials.scopes,
      revokedAt: agentCredentials.revokedAt,
    })
    .from(agentCredentials)
    .innerJoin(users, eq(users.id, agentCredentials.ownerId))
    .where(eq(agentCredentials.secretHash, secretHash));
  return row ?? null;
}
