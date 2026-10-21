import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AppDb } from '../db/client';
import { auditEvents, type AuditEvent } from '../db/schema';

const ownerIdSchema = z.uuid();

export interface AuditInput {
  actor: AuditEvent['actor'];
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * The only way to touch audit_events. Every query is scoped by owner id, so one tenant can never
 * read or write another's rows. New tables follow this shape: a scopedX(db, ownerId) factory.
 */
export function scopedAudit(db: AppDb, ownerId: string) {
  const owner = ownerIdSchema.parse(ownerId);
  return {
    async record(input: AuditInput): Promise<AuditEvent> {
      const [row] = await db
        .insert(auditEvents)
        .values({
          ownerId: owner,
          actor: input.actor,
          action: input.action,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          metadata: input.metadata ?? {},
        })
        .returning();
      if (!row) throw new Error('audit insert returned no row');
      return row;
    },
    async list(limit = 50): Promise<AuditEvent[]> {
      return db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.ownerId, owner))
        .orderBy(desc(auditEvents.createdAt))
        .limit(Math.min(Math.max(limit, 1), 500));
    },
  };
}
