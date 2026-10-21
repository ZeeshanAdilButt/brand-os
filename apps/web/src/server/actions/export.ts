import type { OwnerContext } from './owner';

export const EXPORT_FORMAT = 'brand-os-export-v1';

function withoutOwner<T extends { ownerId: string }>(row: T): Omit<T, 'ownerId'> {
  const { ownerId: _owner, ...rest } = row;
  void _owner;
  return rest;
}

/** Everything the signed-in user holds, as JSON-ready data. Another user's rows are never included. */
export async function exportMyData(owner: OwnerContext) {
  const all = await owner.data.exportAll();
  await owner.data.audit.record({ actor: owner.actor, action: 'account.exported', entityType: 'user', entityId: owner.ownerId });
  return {
    format: EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    profile: all.profile ? withoutOwner(all.profile) : null,
    preferences: all.preferences ? withoutOwner(all.preferences) : null,
    sources: all.sources.map(withoutOwner),
    items: all.items.map(withoutOwner),
    articles: all.articles.map(withoutOwner),
  };
}
