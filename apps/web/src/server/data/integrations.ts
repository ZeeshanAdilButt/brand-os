import { and, asc, eq } from 'drizzle-orm';
import { integrationSecrets, type IntegrationSecret } from '../db/schema';
import type { Scope } from './scope';

/** A saved credential as listings see it: never the ciphertext. */
export type PublicIntegrationSecret = Omit<IntegrationSecret, 'encrypted'>;

const publicColumns = {
  id: integrationSecrets.id,
  ownerId: integrationSecrets.ownerId,
  platform: integrationSecrets.platform,
  kind: integrationSecrets.kind,
  hint: integrationSecrets.hint,
  createdAt: integrationSecrets.createdAt,
  updatedAt: integrationSecrets.updatedAt,
};

export interface IntegrationSecretSave {
  id: string;
  platform: string;
  kind: IntegrationSecret['kind'];
  encrypted: string;
  hint: string;
}

/**
 * Tenant-scoped access to the owner's saved integration credentials. `list` and `get` never return the
 * ciphertext; only `getWithSecret` does, for the code that will one day use it.
 */
export function scopedIntegrationSecrets(scope: Scope) {
  const owned = (platform: string, kind: IntegrationSecret['kind']) =>
    and(eq(integrationSecrets.ownerId, scope.ownerId), eq(integrationSecrets.platform, platform), eq(integrationSecrets.kind, kind));
  return {
    async list(): Promise<PublicIntegrationSecret[]> {
      const db = await scope.db();
      return db.select(publicColumns).from(integrationSecrets).where(eq(integrationSecrets.ownerId, scope.ownerId)).orderBy(asc(integrationSecrets.platform), asc(integrationSecrets.kind));
    },

    async get(platform: string, kind: IntegrationSecret['kind']): Promise<PublicIntegrationSecret | null> {
      const db = await scope.db();
      const [row] = await db.select(publicColumns).from(integrationSecrets).where(owned(platform, kind));
      return row ?? null;
    },

    /** The row including its ciphertext. */
    async getWithSecret(platform: string, kind: IntegrationSecret['kind']): Promise<IntegrationSecret | null> {
      const db = await scope.db();
      const [row] = await db.select().from(integrationSecrets).where(owned(platform, kind));
      return row ?? null;
    },

    /** One credential per platform and kind: saving again replaces it. */
    async save(input: IntegrationSecretSave): Promise<PublicIntegrationSecret> {
      const db = await scope.db();
      const now = new Date();
      const [row] = await db
        .insert(integrationSecrets)
        .values({ ...input, ownerId: scope.ownerId })
        .onConflictDoUpdate({
          target: [integrationSecrets.ownerId, integrationSecrets.platform, integrationSecrets.kind],
          set: { encrypted: input.encrypted, hint: input.hint, updatedAt: now },
        })
        .returning(publicColumns);
      if (!row) throw new Error('integration secret save returned no row');
      return row;
    },

    /** Wipe it. The ciphertext is deleted, not hidden. */
    async remove(platform: string, kind: IntegrationSecret['kind']): Promise<boolean> {
      const db = await scope.db();
      const gone = await db.delete(integrationSecrets).where(owned(platform, kind)).returning({ id: integrationSecrets.id });
      return gone.length > 0;
    },
  };
}
