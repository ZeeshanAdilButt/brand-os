import type { AppDb } from '../db/client';
import { getDb } from '../db';
import type { AuditInput } from './audit';
import { scopedAudit } from './audit';
import { scopedArticles, scopedAssets, scopedStudioSettings } from './articles';
import { scopedCredentials } from './agent-credentials';
import { scopedProviders } from './ai-providers';
import { scopedItems, scopedSources } from './knowledge';
import { scopedPreferences, scopedProfile } from './profile';
import { makeScope, type DbSource, type Scope } from './scope';

export { NotFoundError, SlugTakenError } from './scope';
export { ConflictError } from './articles';
export { findCredentialBySecretHash } from './agent-credentials';

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
    articles: scopedArticles(scope),
    assets: scopedAssets(scope),
    studioSettings: scopedStudioSettings(scope),
    credentials: scopedCredentials(scope),
    providers: scopedProviders(scope),
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
      const [profile, preferences, sources, items, articles] = await Promise.all([
        scopedProfile(scope).get(),
        scopedPreferences(scope).get(),
        scopedSources(scope).list(),
        scopedItems(scope).list({ limit: 200 }),
        allArticles(scope),
      ]);
      // Page through items so the export is complete, not just the first screen.
      const allItems = [...items];
      while (allItems.length % 200 === 0 && allItems.length > 0) {
        const next = await scopedItems(scope).list({ limit: 200, offset: allItems.length });
        if (next.length === 0) break;
        allItems.push(...next);
      }
      return { profile, preferences, sources, items: allItems, articles };
    },
  };
}

/** Every article with its body, paged so the export is complete. Assets are listed by the export route, not embedded. */
async function allArticles(scope: Scope) {
  const repo = scopedArticles(scope);
  const all = await repo.listAll(0, 100);
  while (all.length > 0 && all.length % 100 === 0) {
    const next = await repo.listAll(all.length, 100);
    if (next.length === 0) break;
    all.push(...next);
  }
  return all;
}

export type OwnerData = ReturnType<typeof forOwner>;
