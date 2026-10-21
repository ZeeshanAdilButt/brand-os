import { and, eq } from 'drizzle-orm';
import type { AppDb } from '../db/client';
import { users, type User } from '../db/schema';
import { scopedAudit } from './audit';

/** Fixed id of the single implicit owner in local mode. Hosted accounts get random ids. */
export const LOCAL_OWNER_ID = '00000000-0000-4000-8000-000000000001';

/** Create the local owner row if missing and make sure it is marked as the owner. Idempotent. */
export async function ensureLocalOwner(db: AppDb): Promise<User> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(users)
      .values({ id: LOCAL_OWNER_ID, kind: 'local_owner', isOwner: true, displayName: 'Local owner' })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) {
      await scopedAudit(tx as unknown as AppDb, LOCAL_OWNER_ID).record({
        actor: 'system',
        action: 'local_owner.created',
        entityType: 'user',
        entityId: LOCAL_OWNER_ID,
      });
      return inserted[0];
    }
    // A row created before the owner flag existed (Day 1 databases) gains it here.
    await tx
      .update(users)
      .set({ isOwner: true })
      .where(and(eq(users.id, LOCAL_OWNER_ID), eq(users.isOwner, false)));
    const [existing] = await tx.select().from(users).where(eq(users.id, LOCAL_OWNER_ID));
    if (!existing) throw new Error('local owner row missing after insert conflict');
    return existing;
  });
}

/** The account row for an authenticated user id, or null. Users are not a tenant table: an id is an identity. */
export async function findUser(db: AppDb, userId: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.id, userId));
  return row ?? null;
}
