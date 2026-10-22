import type { Metadata } from 'next';
import { ArrowUpRight, FileText, Send } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { buttonVariants } from '@/components/ui/button';
import { StatusChip } from '@/components/ui/status-chip';
import { draftChip } from '@/lib/chips';
import { formatWhen } from '@/lib/format';
import { PLATFORMS, type PlatformDraftDTO } from '@/lib/publishing';
import { publishHref } from '@/lib/next-step';
import { sessionToOwner } from '@/server/actions/owner';
import { listDrafts } from '@/server/actions/publishing';
import { requireSessionUser } from '@/server/auth/session';

export const metadata: Metadata = { title: 'Publishing' };
export const dynamic = 'force-dynamic';

function Row({ d }: { d: PlatformDraftDTO }) {
  return (
    <li className="rounded-xl border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={publishHref(d.articleId, { step: '3', d: d.platform })} className="text-base font-semibold underline-offset-2 hover:underline">
            {d.payload.title || 'Untitled article'}
          </Link>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {PLATFORMS[d.platform].name}
            {d.account ? ` · ${d.account}` : ''} · updated {formatWhen(d.updatedAt)}
          </p>
        </div>
        <StatusChip chip={draftChip(d.platform, d)} />
      </div>
      {d.remoteUrl && d.status === 'published' ? (
        <a href={d.remoteUrl} target="_blank" rel="noreferrer noopener" className="mt-2 inline-flex items-center gap-1 break-all text-sm font-medium text-link underline underline-offset-2">
          {d.remoteUrl}
          <ArrowUpRight aria-hidden className="size-3.5 shrink-0" />
        </a>
      ) : null}
      {d.failureMessage && (d.status === 'failed' || d.status === 'unknown') ? <p className="mt-2 text-sm text-muted-foreground">{d.failureMessage}</p> : null}
    </li>
  );
}

function Group({ title, note, drafts, id }: { title: string; note?: string; drafts: PlatformDraftDTO[]; id: string }) {
  if (drafts.length === 0) return null;
  return (
    <section aria-labelledby={id} className="mb-8">
      <h2 id={id} className="text-base font-semibold">
        {title} <span className="font-normal text-muted-foreground">({drafts.length})</span>
      </h2>
      {note ? <p className="mt-0.5 mb-3 text-sm text-muted-foreground">{note}</p> : <div className="mb-3" />}
      <ul className="grid gap-3">
        {drafts.map((d) => (
          <Row key={d.id} d={d} />
        ))}
      </ul>
    </section>
  );
}

export default async function PublishingPage() {
  const user = await requireSessionUser();
  const owner = sessionToOwner(user, user.ctx);
  const drafts = await listDrafts(owner, {}, { limit: 100 });
  const unknown = drafts.filter((d) => d.status === 'unknown');
  const waiting = drafts.filter((d) => d.status === 'pending_approval');
  const failed = drafts.filter((d) => d.status === 'failed' || d.status === 'source_changed');
  const inProgress = drafts.filter((d) => d.status === 'publishing' || d.status === 'approved');
  const prepared = drafts.filter((d) => d.status === 'draft' || d.status === 'staged');
  const done = drafts.filter((d) => d.status === 'published');
  const first = unknown[0] ?? waiting[0] ?? failed[0];

  return (
    <>
      <PageHeader title="Publishing" description="Every post prepared for a destination, where it stands, and what needs you.">
        {first ? (
          <Link href={publishHref(first.articleId, { step: '3', d: first.platform })} className={buttonVariants()}>
            {unknown.length > 0 ? 'Check post status' : waiting.length > 0 ? 'Review next post' : 'Fix next post'}
          </Link>
        ) : (
          <Link href="/articles" className={buttonVariants()}>
            <FileText aria-hidden />
            Prepare posts
          </Link>
        )}
      </PageHeader>

      {drafts.length === 0 ? (
        <section className="rounded-xl border border-input bg-surface p-6 sm:p-8">
          <div className="flex flex-col gap-5 sm:flex-row sm:gap-6">
            <div aria-hidden className="grid size-12 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground">
              <Send className="size-6" />
            </div>
            <div className="min-w-0">
              <h2 className="text-xl font-semibold">Nothing prepared yet</h2>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">Open an article and choose where it should go. You will see a preview of each destination and approve each post yourself.</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Link href="/articles" className={buttonVariants({ size: 'sm' })}>
                  Open an article
                </Link>
                <Link href="/platforms" className={buttonVariants({ size: 'sm', variant: 'outline' })}>
                  See the platforms
                </Link>
              </div>
            </div>
          </div>
        </section>
      ) : (
        <>
          <Group id="g-unknown" title="Result not known" note="It may or may not have gone out. Checking only reads, and nothing is sent again on its own." drafts={unknown} />
          <Group id="g-waiting" title="Waiting for your approval" note="Nothing goes public until you approve that exact post." drafts={waiting} />
          <Group id="g-failed" title="Needs a fix" note="The platform refused it, or the article changed after the post was prepared." drafts={failed} />
          <Group id="g-progress" title="In progress" drafts={inProgress} />
          <Group id="g-prepared" title="Prepared" note="Drafts you can still edit and preview." drafts={prepared} />
          <Group id="g-done" title="Published" drafts={done} />
        </>
      )}
    </>
  );
}
