import { and, desc, eq, inArray, isNull, lte, or, lt, sql } from 'drizzle-orm';
import type { ConnectorId } from '../../lib/connectors/ids';
import type { ConnectionConfig, ConnectionStatus } from '../../lib/publishing';
import { connectFlows, platformConnections, type ConnectFlow } from '../db/schema';
import type { Scope } from './scope';

/*
 * The data layer for the connection framework. Connections themselves are rows of `platform_connections` (the same
 * encrypted store the publishing adapters use); this file adds what a sign-in needs: the health columns, the
 * renewal lease and the flows in progress. Everything is filtered by the owner id in the same WHERE.
 */

export interface ConnectorSave {
  id: string;
  platform: ConnectorId;
  encryptedKey: string;
  keyLast4: string;
  status: ConnectionStatus;
  who: string | null;
  config: ConnectionConfig;
  authKind: string;
  scopesGranted: string[];
  tokenExpiresAt: Date | null;
  renewable: boolean;
  message: string | null;
  /** The time to record. Production leaves it out. */
  now?: Date;
}

export interface ValidationRecord {
  status: ConnectionStatus;
  who?: string | null;
  config?: ConnectionConfig;
  scopesGranted?: string[];
  /** A short code such as rejected or unreachable, or null after a success. */
  errorCode: string | null;
  message: string | null;
  now?: Date;
}

export interface FlowCreate {
  id: string;
  platform: ConnectorId;
  kind: 'oauth' | 'device';
  stateHash: string | null;
  sessionHash: string;
  redirectUri: string | null;
  codeVerifierEnc: string | null;
  deviceCodeEnc: string | null;
  userCode: string | null;
  verificationUri: string | null;
  intervalSec: number | null;
  nextPollAt: Date | null;
  scopes: string[];
  instance: string | null;
  expiresAt: Date;
}

const publicColumns = {
  id: platformConnections.id,
  ownerId: platformConnections.ownerId,
  platform: platformConnections.platform,
  keyLast4: platformConnections.keyLast4,
  status: platformConnections.status,
  who: platformConnections.who,
  config: platformConnections.config,
  lastCheckedAt: platformConnections.lastCheckedAt,
  lastCheckMessage: platformConnections.lastCheckMessage,
  authKind: platformConnections.authKind,
  scopesGranted: platformConnections.scopesGranted,
  tokenExpiresAt: platformConnections.tokenExpiresAt,
  renewable: platformConnections.renewable,
  lastErrorCode: platformConnections.lastErrorCode,
  refreshGeneration: platformConnections.refreshGeneration,
  refreshLockUntil: platformConnections.refreshLockUntil,
  createdAt: platformConnections.createdAt,
  updatedAt: platformConnections.updatedAt,
};

export type ConnectorRow = {
  [K in keyof typeof publicColumns]: (typeof platformConnections.$inferSelect)[K];
};

/** Tenant-scoped access for the connection framework. */
export function scopedConnectors(scope: Scope) {
  const owned = (id: string) => and(eq(platformConnections.ownerId, scope.ownerId), eq(platformConnections.id, id));
  const ownedFlow = (id: string) => and(eq(connectFlows.ownerId, scope.ownerId), eq(connectFlows.id, id));
  return {
    /** Save (or replace) the connection of a platform after a check passed. One row per platform. */
    async save(input: ConnectorSave): Promise<ConnectorRow> {
      const db = await scope.db();
      const now = input.now ?? new Date();
      const values = {
        encryptedKey: input.encryptedKey,
        keyLast4: input.keyLast4,
        status: input.status,
        who: input.who,
        config: input.config,
        authKind: input.authKind,
        scopesGranted: input.scopesGranted,
        tokenExpiresAt: input.tokenExpiresAt,
        renewable: input.renewable,
        lastErrorCode: null,
        lastCheckedAt: now,
        lastCheckMessage: input.message,
        refreshLockUntil: null,
        updatedAt: now,
      };
      const [row] = await db
        .insert(platformConnections)
        .values({ id: input.id, platform: input.platform, ownerId: scope.ownerId, ...values })
        .onConflictDoUpdate({ target: [platformConnections.ownerId, platformConnections.platform], set: { ...values, refreshGeneration: sql`${platformConnections.refreshGeneration} + 1` } })
        .returning(publicColumns);
      if (!row) throw new Error('connector save returned no row');
      return row;
    },

    async recordValidation(id: string, record: ValidationRecord): Promise<ConnectorRow | null> {
      const db = await scope.db();
      const now = record.now ?? new Date();
      const [row] = await db
        .update(platformConnections)
        .set({
          status: record.status,
          ...(record.who === undefined ? {} : { who: record.who }),
          ...(record.config === undefined ? {} : { config: record.config }),
          ...(record.scopesGranted === undefined ? {} : { scopesGranted: record.scopesGranted }),
          lastErrorCode: record.errorCode,
          lastCheckedAt: now,
          lastCheckMessage: record.message ? record.message.slice(0, 500) : null,
          updatedAt: now,
        })
        .where(owned(id))
        .returning(publicColumns);
      return row ?? null;
    },

    /**
     * Take the renewal lease. Returns the generation the renewal started from, or null when another request holds a
     * live lease. A single atomic UPDATE, so two requests can never both win.
     */
    async acquireRefreshLease(id: string, now: Date, leaseMs: number): Promise<number | null> {
      const db = await scope.db();
      const until = new Date(now.getTime() + leaseMs);
      const [row] = await db
        .update(platformConnections)
        .set({ refreshLockUntil: until })
        .where(and(owned(id), or(isNull(platformConnections.refreshLockUntil), lte(platformConnections.refreshLockUntil, now))))
        .returning({ generation: platformConnections.refreshGeneration });
      return row ? row.generation : null;
    },

    /** Store the renewed bundle and free the lease, only if nobody replaced the connection meanwhile. */
    async completeRefresh(id: string, generation: number, next: { encryptedKey: string; tokenExpiresAt: Date | null; renewable: boolean; scopesGranted?: string[]; now: Date }): Promise<boolean> {
      const db = await scope.db();
      const rows = await db
        .update(platformConnections)
        .set({
          encryptedKey: next.encryptedKey,
          tokenExpiresAt: next.tokenExpiresAt,
          renewable: next.renewable,
          ...(next.scopesGranted ? { scopesGranted: next.scopesGranted } : {}),
          refreshGeneration: generation + 1,
          refreshLockUntil: null,
          lastErrorCode: null,
          updatedAt: next.now,
        })
        .where(and(owned(id), eq(platformConnections.refreshGeneration, generation)))
        .returning({ id: platformConnections.id });
      return rows.length > 0;
    },

    /** Free the lease after a failed renewal. */
    async releaseRefreshLease(id: string, generation: number): Promise<void> {
      const db = await scope.db();
      await db
        .update(platformConnections)
        .set({ refreshLockUntil: null })
        .where(and(owned(id), eq(platformConnections.refreshGeneration, generation)));
    },

    // ---- flows ---------------------------------------------------------------------------------------

    async createFlow(input: FlowCreate): Promise<ConnectFlow> {
      const db = await scope.db();
      const [row] = await db
        .insert(connectFlows)
        .values({ ...input, ownerId: scope.ownerId })
        .returning();
      if (!row) throw new Error('flow create returned no row');
      return row;
    },

    async getFlow(id: string): Promise<ConnectFlow | null> {
      const db = await scope.db();
      const [row] = await db.select().from(connectFlows).where(ownedFlow(id));
      return row ?? null;
    },

    async findFlowByState(stateHash: string): Promise<ConnectFlow | null> {
      const db = await scope.db();
      const [row] = await db.select().from(connectFlows).where(and(eq(connectFlows.ownerId, scope.ownerId), eq(connectFlows.stateHash, stateHash)));
      return row ?? null;
    },

    /** Spend a pending, unexpired flow exactly once. The first caller gets the row, every other caller gets null. */
    async consumeFlow(id: string, now: Date): Promise<ConnectFlow | null> {
      const db = await scope.db();
      const [row] = await db
        .update(connectFlows)
        .set({ status: 'used', usedAt: now })
        .where(and(ownedFlow(id), eq(connectFlows.status, 'pending'), sql`${connectFlows.expiresAt} > ${now}`))
        .returning();
      return row ?? null;
    },

    async setFlowStatus(id: string, status: ConnectFlow['status']): Promise<void> {
      const db = await scope.db();
      await db.update(connectFlows).set({ status }).where(and(ownedFlow(id), eq(connectFlows.status, 'pending')));
    },

    async setFlowPoll(id: string, poll: { intervalSec: number; nextPollAt: Date }): Promise<void> {
      const db = await scope.db();
      await db.update(connectFlows).set(poll).where(ownedFlow(id));
    },

    /** Cancel every pending flow of a platform (a new attempt replaces the old one). */
    async cancelPendingFlows(platform: ConnectorId): Promise<number> {
      const db = await scope.db();
      const rows = await db
        .update(connectFlows)
        .set({ status: 'cancelled' })
        .where(and(eq(connectFlows.ownerId, scope.ownerId), eq(connectFlows.platform, platform), eq(connectFlows.status, 'pending')))
        .returning({ id: connectFlows.id });
      return rows.length;
    },

    /** Delete flows that are over, so verifiers and device codes do not linger. */
    async purgeFlows(now: Date): Promise<number> {
      const db = await scope.db();
      const rows = await db
        .delete(connectFlows)
        .where(and(eq(connectFlows.ownerId, scope.ownerId), or(lt(connectFlows.expiresAt, now), inArray(connectFlows.status, ['used', 'cancelled', 'failed', 'expired']))))
        .returning({ id: connectFlows.id });
      return rows.length;
    },

    async pendingFlow(platform: ConnectorId, kind: 'oauth' | 'device'): Promise<ConnectFlow | null> {
      const db = await scope.db();
      const [row] = await db
        .select()
        .from(connectFlows)
        .where(and(eq(connectFlows.ownerId, scope.ownerId), eq(connectFlows.platform, platform), eq(connectFlows.kind, kind), eq(connectFlows.status, 'pending')))
        .orderBy(desc(connectFlows.createdAt))
        .limit(1);
      return row ?? null;
    },

    async countFlows(): Promise<number> {
      const db = await scope.db();
      const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(connectFlows).where(eq(connectFlows.ownerId, scope.ownerId));
      return row?.n ?? 0;
    },
  };
}
