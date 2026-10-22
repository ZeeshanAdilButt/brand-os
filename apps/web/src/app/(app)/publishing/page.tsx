import type { Metadata } from 'next';
import { ArrowUpRight, FileText, Send } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { formatWhen } from '@/lib/format';
import { DRAFT_STATUS_LABELS, PLATFORMS, type DraftStatus } from '@/lib/publishing';
import { cn } from '@/lib/utils';
import { sessionToOwner } from '@/server/actions/owner';
import { listConnections, listDrafts } from '@/server/actions/publishing';
import { requireSessionUser } from '@/server/auth/session';

export const metadata: Metadata = { title: 'Publishing' };
export const dynamic = 'force-dynamic';

const TONE: Record<DraftStatus, string> = {
  draft: 'border-input text-muted-foreground',
  staged: 'border-teal-text/50 text-teal-text',
  pending_approval: 'border-warning/60 text-warning',
  approved: 'border-warning/60 text-warning',
  publishing: 'border-warning/60 text-warning',
  published: 'border-success/60 bg-success/10 text-success',
  failed: 'border-destructive/50 text-destructive',
  unknown: 'border-destructive/60 bg-destructive/10 text-destructive',
  source_changed: 'border-warning/60 text-warning',
};

export default async function PublishingPage() {
  const user = await requireSessionUser();
  const owner = sessionToOwner(user, user.ctx);
  const [drafts, connections] = await Promise.all([listDrafts(owner, {}, { limit: 100 }), listConnections(owner)]);
  const connected = connections.filter((c) => c.connection?.status === 'connected');
  const waiting = drafts.filter((d) => d.status === 'pending_approval').length;
  const unknown = drafts.filter((d) => d.status === 'unknown').length;

  return (
    <>
      <PageHeader eyebrow="Publishing" title="Drafts and posts" description="Every post prepared for a platform, where it stands, and what needs you. Nothing goes out without your explicit approval of that exact post." />

      {unknown > 0 ? (
        <p role="alert" className="mb-6 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm">
          {unknown} post{unknown === 1 ? ' has' : 's have'} an unknown result. Open it and use “Check on platform”. It will not be sent again on its own.
        </p>
      ) : null}
      {waiting > 0 ? <p className="mb-6 rounded-lg border border-warning/50 bg-warning/10 px-4 py-3 text-sm">{waiting} post{waiting === 1 ? ' is' : 's are'} waiting for your approval.</p> : null}

      {drafts.length === 0 ? (
        <section className="rounded-xl border border-dashed bg-card/60 p-6 sm:p-8">
          <div className="flex flex-col gap-5 sm:flex-row sm:gap-6">
            <div aria-hidden className="grid size-12 shrink-0 place-items-center rounded-xl border bg-background text-link shadow-soft">
              <Send className="size-6" />
            </div>
            <div className="min-w-0">
              <h2 className=" text-2xl font-semibold">Nothing prepared yet</h2>
              <p className="mt-2 max-w-2xl leading-relaxed text-muted-foreground">
                Open an article and choose Publish. You pick a destination, build the post, look at a private copy on the platform, and approve it yourself.
              </p>
              <ol className="mt-4 grid max-w-xl gap-2 text-sm">
                <li>
                  <span className="font-medium">1.</span> {connected.length > 0 ? `${connected.map((c) => c.info.name).join(' and ')} ${connected.length === 1 ? 'is' : 'are'} connected.` : 'Connect a platform in Settings.'}
                </li>
                <li>
                  <span className="font-medium">2.</span> Open an article, then Publish, then Prepare draft.
                </li>
                <li>
                  <span className="font-medium">3.</span> Stage the private draft, check it on the platform, request approval, then approve.
                </li>
              </ol>
              <div className="mt-5 flex flex-wrap gap-2">
                <Link href="/articles" className={buttonVariants({ size: 'sm' })}>
                  <FileText aria-hidden />
                  Open an article
                </Link>
                <Link href="/settings/connections" className={buttonVariants({ size: 'sm', variant: 'outline' })}>
                  Connections
                </Link>
              </div>
            </div>
          </div>
        </section>
      ) : (
        <ul className="grid gap-3">
          {drafts.map((d) => (
            <li key={d.id} className="rounded-xl border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link href={`/articles/${d.articleId}?panel=publish`} className=" text-lg font-semibold underline-offset-2 hover:underline">
                    {d.payload.title || 'Untitled article'}
                  </Link>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {PLATFORMS[d.platform].name}
                    {d.account ? ` · ${d.account}` : ''} · updated {formatWhen(d.updatedAt)}
                  </p>
                </div>
                <Badge variant="outline" className={cn(TONE[d.status])}>
                  {DRAFT_STATUS_LABELS[d.status]}
                </Badge>
              </div>
              {d.remoteUrl && d.status === 'published' ? (
                <a href={d.remoteUrl} target="_blank" rel="noreferrer noopener" className="mt-2 inline-flex items-center gap-1 break-all text-sm font-medium text-link underline underline-offset-2">
                  {d.remoteUrl}
                  <ArrowUpRight aria-hidden className="size-3.5 shrink-0" />
                </a>
              ) : null}
              {d.failureMessage && (d.status === 'failed' || d.status === 'unknown') ? <p className="mt-2 text-sm text-muted-foreground">{d.failureMessage}</p> : null}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-8 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        The side-by-side composer, per-destination editing and approved batches arrive on Day 6. Today each destination is prepared, staged and approved on its own, from the article studio.
      </p>
    </>
  );
}
