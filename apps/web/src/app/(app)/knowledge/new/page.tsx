import type { Metadata } from 'next';
import { ItemForm, NEW_ITEM } from '@/components/knowledge/item-form';
import { PageHeader } from '@/components/page-header';
import { listSources } from '@/server/actions/knowledge';
import { sessionToOwner } from '@/server/actions/owner';
import { requireSessionUser } from '@/server/auth/session';

export const metadata: Metadata = { title: 'Add knowledge item' };
export const dynamic = 'force-dynamic';

export default async function NewItemPage() {
  const user = await requireSessionUser();
  const sources = await listSources(sessionToOwner(user, user.ctx));
  return (
    <>
      <PageHeader eyebrow="Knowledge" title="Add an item" description="One claim, project, reading note or certification per item, so each can be reviewed and cited on its own." />
      <div className="max-w-2xl">
        <ItemForm values={NEW_ITEM} sources={sources.map((s) => ({ id: s.id, title: s.title }))} />
      </div>
    </>
  );
}
