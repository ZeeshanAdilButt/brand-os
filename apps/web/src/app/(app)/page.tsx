import Link from 'next/link';
import { ExternalLink, FileText, Send } from 'lucide-react';
import { JourneySteps } from '@/components/guided/journey-steps';
import { NextStepCard } from '@/components/guided/next-step-card';
import { NewArticleButton } from '@/components/articles/new-article-button';
import { PageHeader } from '@/components/page-header';
import { buttonVariants } from '@/components/ui/button';
import { StatusChip } from '@/components/ui/status-chip';
import { draftChip } from '@/lib/chips';
import { formatWhen } from '@/lib/format';
import { PLATFORMS } from '@/lib/catalog';
import { getHome } from '@/server/actions/journey';
import { sessionToOwner } from '@/server/actions/owner';
import { requireSessionUser } from '@/server/auth/session';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const user = await requireSessionUser();
  const owner = sessionToOwner(user, user.ctx);
  const home = await getHome(owner, {});

  return (
    <>
      <PageHeader title="Home" description="One article, a few destinations, and you approve each post yourself.">
        <Link href={home.focus ? `/publishing?article=${home.focus.id}` : "/publishing"} className={buttonVariants({ variant: "outline" })}>
          <Send aria-hidden />
          Publish
        </Link>
      </PageHeader>

      <NextStepCard
        kicker={home.kicker}
        subject={home.kicker === 'continue' ? home.focus?.title : undefined}
        headline={home.headline}
        why={home.why}
        href={home.href}
        actionLabel={home.kicker === 'start' ? 'Import an article' : home.kicker === 'attention' ? home.headline : (home.journey?.next.label ?? 'Continue')}
        footer={home.journey ? <JourneySteps steps={home.journey.steps} /> : null}
        secondary={
          home.alternative ? (
            home.alternative.newArticle ? (
              <NewArticleButton label="Write from scratch" variant="outline" />
            ) : home.alternative.href ? (
              <Link href={home.alternative.href} className={buttonVariants({ variant: 'ghost' })}>
                {home.alternative.label}
              </Link>
            ) : null
          ) : null
        }
      />

      {home.journey ? null : (
        <section aria-labelledby="progress-heading" className="mt-6 rounded-xl border bg-surface p-6">
          <h2 id="progress-heading" className="mb-1 text-lg font-semibold">
            How it works
          </h2>
          <p className="text-sm leading-6 text-muted-foreground">
            Write or import an article, choose where it should go, look at a preview of each destination, approve each post yourself, then share the links. Nothing is sent
            until you approve it.
          </p>
        </section>
      )}

      {home.articleCount > 0 ? (
        <div className="mt-6 grid items-start gap-6 lg:grid-cols-[2fr_1fr]">
          <section aria-labelledby="recent-articles" className="rounded-xl border bg-surface">
            <div className="flex items-center justify-between border-b px-5 py-3">
              <h2 id="recent-articles" className="text-base font-semibold">
                Recent articles
              </h2>
              <Link href="/articles" className="text-sm font-medium text-link hover:underline">
                All articles
              </Link>
            </div>
            <ul className="divide-y">
              {home.articles.map((a) => (
                <li key={a.id}>
                  <Link href={`/articles/${a.id}`} className="flex items-center gap-3 px-5 py-3 transition-colors duration-[120ms] hover:bg-muted">
                    <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{a.title}</span>
                      <span className="block text-xs text-muted-foreground">{a.empty ? 'No text yet · ' : ''}Edited {formatWhen(a.updatedAt)}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="recent-results" className="rounded-xl border bg-surface">
            <div className="flex items-center justify-between border-b px-5 py-3">
              <h2 id="recent-results" className="text-base font-semibold">
                Recent publishing results
              </h2>
              <Link href="/publishing" className="text-sm font-medium text-link hover:underline">
                Publishing
              </Link>
            </div>
            {home.results.length === 0 ? (
              <p className="px-5 py-6 text-sm leading-6 text-muted-foreground">Nothing has been published yet. When a post goes out, its link shows up here.</p>
            ) : (
              <ul className="divide-y">
                {home.results.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{r.articleTitle}</span>
                      <span className="block text-xs text-muted-foreground">
                        {PLATFORMS[r.platform].name} · {formatWhen(r.updatedAt)}
                      </span>
                    </span>
                    <StatusChip chip={draftChip(r.platform, { status: r.status, publishedVia: r.publishedVia })} />
                    {r.remoteUrl ? (
                      <a href={r.remoteUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-sm font-medium text-link hover:underline">
                        Open
                        <ExternalLink aria-hidden className="size-3.5" />
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}
    </>
  );
}
