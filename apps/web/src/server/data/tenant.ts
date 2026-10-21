import type { AppDb } from '../db/client';
import { getDb } from '../db';
import type { AuditInput } from './audit';
import { scopedAudit } from './audit';
import { scopedItems, scopedSources } from './knowledge';
import { scopedPreferences, scopedProfile } from './profile';
import { makeScope, type DbSource } from './scope';

export { NotFoundError } from './scope';

/**
 * THE data-access entry point for tenant tables. `forOwner(ownerId)` returns repositories whose
 * every query is filtered by that owner id and whose inserts set it. App code, route handlers and
 * server actions never import tenant tables or write queries; a source-rule test enforces that.
 *
 * `ownerId` must come from the authenticated session (see src/server/auth), never from request
 * input, a form field, an MCP argument or an AI tool call. Pass `db` to use a specific connection
 * or transaction; omit it to use the process-wide database.
 */
export function forOwner(ownerId: string, db?: AppDb) {
  const source: DbSource = db ? async () => db : async () => (await getDb()).db;
  const scope = makeScope(ownerId, source);
  return {
    ownerId: scope.ownerId,
    profile: scopedProfile(scope),
    preferences: scopedPreferences(scope),
    sources: scopedSources(scope),
    items: scopedItems(scope),
    audit: {
      async record(input: AuditInput) {
        return scopedAudit(await scope.db(), scope.ownerId).record(input);
      },
      async list(limit?: number) {
        return scopedAudit(await scope.db(), scope.ownerId).list(limit);
      },
    },

    /** Everything this owner holds, as plain data. Used by the export endpoint. */
    async exportAll() {
      const [profile, preferences, sources, items] = await Promise.all([
        scopedProfile(scope).get(),
        scopedPreferences(scope).get(),
        scopedSources(scope).list(),
        scopedItems(scope).list({ limit: 200 }),
      ]);
      // Page through items so the export is complete, not just the first screen.
      const allItems = [...items];
      while (allItems.length % 200 === 0 && allItems.length > 0) {
        const next = await scopedItems(scope).list({ limit: 200, offset: allItems.length });
        if (next.length === 0) break;
        allItems.push(...next);
      }
      return { profile, preferences, sources, items: allItems };
    },
  };
}

export type OwnerData = ReturnType<typeof forOwner>;
