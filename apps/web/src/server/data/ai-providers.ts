import { and, asc, count, eq, ne } from 'drizzle-orm';
import type { Protocol, ProviderKind, Trust } from '../../lib/ai';
import { aiProviders, type AiProvider } from '../db/schema';
import { definedOnly, NotFoundError, type Scope } from './scope';

/** A provider as listings and the UI see it: everything but the encrypted key. */
export type PublicProvider = Omit<AiProvider, 'encryptedKey'>;

const { encryptedKey: _encrypted, ...publicColumns } = columns();
void _encrypted;

function columns() {
  return {
    id: aiProviders.id,
    ownerId: aiProviders.ownerId,
    name: aiProviders.name,
    kind: aiProviders.kind,
    protocol: aiProviders.protocol,
    baseUrl: aiProviders.baseUrl,
    model: aiProviders.model,
    trust: aiProviders.trust,
    encryptedKey: aiProviders.encryptedKey,
    keyLast4: aiProviders.keyLast4,
    workspaceId: aiProviders.workspaceId,
    monthlyTokenCap: aiProviders.monthlyTokenCap,
    isDefault: aiProviders.isDefault,
    enabled: aiProviders.enabled,
    lastTestAt: aiProviders.lastTestAt,
    lastTestOk: aiProviders.lastTestOk,
    lastTestMessage: aiProviders.lastTestMessage,
    createdAt: aiProviders.createdAt,
    updatedAt: aiProviders.updatedAt,
  };
}

export interface ProviderInsert {
  id: string;
  name: string;
  kind: ProviderKind;
  protocol: Protocol | null;
  baseUrl: string | null;
  model: string | null;
  trust: Trust;
  encryptedKey: string | null;
  keyLast4: string | null;
  workspaceId: string | null;
  monthlyTokenCap: number | null;
}

export type ProviderPatch = Partial<
  Pick<ProviderInsert, 'name' | 'baseUrl' | 'model' | 'trust' | 'encryptedKey' | 'keyLast4' | 'workspaceId' | 'monthlyTokenCap'> & { enabled: boolean }
>;

/** Tenant-scoped access to one owner's AI providers. Only `getWithKey` returns the encrypted key, and only the runner calls it. */
export function scopedProviders(scope: Scope) {
  const owned = (id: string) => and(eq(aiProviders.ownerId, scope.ownerId), eq(aiProviders.id, id));

  return {
    async list(): Promise<PublicProvider[]> {
      const db = await scope.db();
      return db.select(publicColumns).from(aiProviders).where(eq(aiProviders.ownerId, scope.ownerId)).orderBy(asc(aiProviders.createdAt));
    },

    async get(id: string): Promise<PublicProvider | null> {
      const db = await scope.db();
      const [row] = await db.select(publicColumns).from(aiProviders).where(owned(id));
      return row ?? null;
    },

    /** The provider including its encrypted key, for the code that is about to call it. */
    async getWithKey(id: string): Promise<AiProvider | null> {
      const db = await scope.db();
      const [row] = await db.select(columns()).from(aiProviders).where(owned(id));
      return row ?? null;
    },

    async count(): Promise<number> {
      const db = await scope.db();
      const [row] = await db.select({ n: count() }).from(aiProviders).where(eq(aiProviders.ownerId, scope.ownerId));
      return Number(row?.n ?? 0);
    },

    /** The first provider an owner adds becomes the default. */
    async create(input: ProviderInsert): Promise<PublicProvider> {
      const db = await scope.db();
      return db.transaction(async (tx) => {
        const [existing] = await tx.select({ n: count() }).from(aiProviders).where(eq(aiProviders.ownerId, scope.ownerId));
        const [row] = await tx
          .insert(aiProviders)
          .values({ ...input, isDefault: Number(existing?.n ?? 0) === 0, ownerId: scope.ownerId })
          .returning(publicColumns);
        if (!row) throw new Error('provider insert returned no row');
        return row;
      });
    },

    async update(id: string, patch: ProviderPatch): Promise<PublicProvider> {
      const db = await scope.db();
      const [row] = await db
        .update(aiProviders)
        .set({ ...definedOnly(patch), updatedAt: new Date() })
        .where(owned(id))
        .returning(publicColumns);
      if (!row) throw new NotFoundError('provider');
      return row;
    },

    async setDefault(id: string): Promise<PublicProvider> {
      const db = await scope.db();
      return db.transaction(async (tx) => {
        const [target] = await tx.select({ id: aiProviders.id }).from(aiProviders).where(owned(id));
        if (!target) throw new NotFoundError('provider');
        await tx.update(aiProviders).set({ isDefault: false }).where(and(eq(aiProviders.ownerId, scope.ownerId), ne(aiProviders.id, id)));
        const [row] = await tx.update(aiProviders).set({ isDefault: true, updatedAt: new Date() }).where(owned(id)).returning(publicColumns);
        if (!row) throw new NotFoundError('provider');
        return row;
      });
    },

    /** Delete a provider. If it was the default, another one (the oldest) takes over. */
    async remove(id: string): Promise<boolean> {
      const db = await scope.db();
      return db.transaction(async (tx) => {
        const [gone] = await tx.delete(aiProviders).where(owned(id)).returning({ id: aiProviders.id, wasDefault: aiProviders.isDefault });
        if (!gone) return false;
        if (gone.wasDefault) {
          const [next] = await tx
            .select({ id: aiProviders.id })
            .from(aiProviders)
            .where(eq(aiProviders.ownerId, scope.ownerId))
            .orderBy(asc(aiProviders.createdAt))
            .limit(1);
          if (next) await tx.update(aiProviders).set({ isDefault: true }).where(owned(next.id));
        }
        return true;
      });
    },

    async recordTest(id: string, ok: boolean, message: string): Promise<void> {
      const db = await scope.db();
      await db
        .update(aiProviders)
        .set({ lastTestAt: new Date(), lastTestOk: ok, lastTestMessage: message.slice(0, 500) })
        .where(owned(id));
    },
  };
}
