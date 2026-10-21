import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ConfidentialityBadge, KindBadge, PublicUseBadge, VerificationBadge } from '@/components/knowledge/badges';
import { DeleteButton, ReviewButton } from '@/components/knowledge/item-actions';
import { ItemForm } from '@/components/knowledge/item-form';
import { PageHeader } from '@/components/page-header';
import { getItem, listSources } from '@/server/actions/knowledge';
import { ActionError, sessionToOwner } from '@/server/actions/owner';
import { requireSessionUser } from '@/server/auth/session';

export const metadata: Metadata = { title: 'Edit knowledge item' };
export const dynamic = 'force-dynamic';

const when = (d: Date | null) => (d ? d.toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' }) : null);

export default async function EditItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireSessionUser();
  const owner = sessionToOwner(user, user.ctx);
  let item;
  try {
    item = await getItem(owner, id);
  } catch (err) {
    if (err instanceof ActionError && err.code === 'not_found') notFound();
    throw err;
  }
  const sources = await listSources(owner);

  return (
    <>
      <PageHeader eyebrow="Knowledge" title="Edit item">
        <div className="flex flex-wrap items-center gap-1.5">
          <KindBadge kind={item.kind} />
          <VerificationBadge status={item.verificationStatus} />
          <ConfidentialityBadge level={item.confidentiality} />
          <PublicUseBadge permitted={item.publicUsePermitted} />
        </div>
        <p className="text-sm text-muted-foreground">
          Added {when(item.createdAt)}. {item.lastReviewedAt ? `Last reviewed ${when(item.lastReviewedAt)}.` : 'Never reviewed.'}
        </p>
      </PageHeader>
      <div className="grid max-w-2xl gap-10">
        <ItemForm
          values={{
            id: item.id,
            kind: item.kind,
            title: item.title,
            body: item.body,
            tags: item.tags,
            sourceId: item.sourceId,
            sourceDate: item.sourceDate,
            verificationStatus: item.verificationStatus,
            confidence: item.confidence,
            confidentiality: item.confidentiality,
            publicUsePermitted: item.publicUsePermitted,
          }}
          sources={sources.map((s) => ({ id: s.id, title: s.title }))}
        />
        <section aria-labelledby="actions-heading" className="rounded-xl border bg-card p-4 sm:p-5">
          <h2 id="actions-heading" className="font-serif text-lg font-semibold">
            Review and removal
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            Marking an item reviewed confirms the claim is accurate and records today as the review date. It does not allow public use; that stays a
            separate choice above. Deleting removes only this item. Deleting your whole account arrives on Day 27.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {item.verificationStatus !== 'verified' ? <ReviewButton id={item.id} /> : null}
            <DeleteButton id={item.id} title={item.title} />
          </div>
        </section>
      </div>
    </>
  );
}
