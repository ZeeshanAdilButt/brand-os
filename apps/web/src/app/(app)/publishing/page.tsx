import type { Metadata } from 'next';
import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { PublishWorkspace } from '@/components/publish/workspace/workspace';
import { buttonVariants } from '@/components/ui/button';
import { StatusChip } from '@/components/ui/status-chip';
import { draftChip } from '@/lib/chips';
import { formatWhen } from '@/lib/format';
import { PLATFORMS, type PlatformDraftDTO } from '@/lib/publishing';
import { publishHref } from '@/lib/next-step';
import { isPlatformId } from '@/lib/catalog';
import { pickInitialArticle, wordsFromChars, type ArticleOption } from '@/lib/publish-workspace';
import { listArticles } from '@/server/actions/articles';
import { listDestinations } from '@/server/actions/publishing';
import { getArticle } from '@/server/actions/articles';
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

export default async function PublishingPage({ searchParams }: { searchParams: Promise<{ article?: string; platform?: string }> }) {
  const query = await searchParams;
  const user = await requireSessionUser();
  const owner = sessionToOwner(user, user.ctx);
  const [drafts, list] = await Promise.all([listDrafts(owner, {}, { limit: 100 }), listArticles(owner, { status: 'all', limit: 200 })]);
  const options: ArticleOption[] = list.articles.map((a) => ({ id: a.id, title: a.title, status: a.status as ArticleOption['status'], words: wordsFromChars(a.bodyChars), updatedAt: a.updatedAt.toISOString() }));
  const startId = pickInitialArticle(options, query.article);
  let initial: { article: { id: string; title: string; description: string; tags: string[]; canonicalUrl: string | null; bodyMarkdown: string } | null; destinations: Awaited<ReturnType<typeof listDestinations>>; platform: ReturnType<typeof asPlatform> } = { article: null, destinations: [], platform: null };
  if (startId) {
    const a = await getArticle(owner, startId);
    initial = {
      article: { id: a.id, title: a.title, description: a.description, tags: a.tags, canonicalUrl: a.canonicalUrl, bodyMarkdown: a.bodyMarkdown },
      destinations: await listDestinations(owner, {}, a.id),
      platform: asPlatform(query.platform),
    };
  }
  const unknown = drafts.filter((d) => d.status === 'unknown');
  const waiting = drafts.filter((d) => d.status === 'pending_approval');
  const failed = drafts.filter((d) => d.status === 'failed' || d.status === 'source_changed');
  const inProgress = drafts.filter((d) => d.status === 'publishing' || d.status === 'approved');
  const prepared = drafts.filter((d) => d.status === 'draft' || d.status === 'staged');
  const done = drafts.filter((d) => d.status === 'published');
  const first = unknown[0] ?? waiting[0] ?? failed[0];

  return (
    <>
      <PageHeader title="Publishing" description="Choose an article, choose where it goes, and see a preview of each. You approve every post yourself.">
        {first ? (
          <Link href={publishHref(first.articleId, { step: '3', d: first.platform })} className={buttonVariants({ variant: 'outline' })}>
            {unknown.length > 0 ? 'Check post status' : waiting.length > 0 ? 'Review next post' : 'Fix next post'}
          </Link>
        ) : null}
      </PageHeader>

      <PublishWorkspace articles={options} initial={initial} />

      {drafts.length > 0 ? (
        <div className="mt-10">
          <h2 className="mb-4 text-xl font-semibold">Activity</h2>
          <Group id="g-unknown" title="Result not known" note="It may or may not have gone out. Checking only reads, and nothing is sent again on its own." drafts={unknown} />
          <Group id="g-waiting" title="Waiting for your approval" note="Nothing goes public until you approve that exact post." drafts={waiting} />
          <Group id="g-failed" title="Needs a fix" note="The platform refused it, or the article changed after the post was prepared." drafts={failed} />
          <Group id="g-progress" title="In progress" drafts={inProgress} />
          <Group id="g-prepared" title="Prepared" note="Drafts you can still edit and preview." drafts={prepared} />
          <Group id="g-done" title="Published" drafts={done} />
        </div>
      ) : null}
    </>
  );
}

function asPlatform(value: string | undefined) {
  return value && isPlatformId(value) ? value : null;
}
