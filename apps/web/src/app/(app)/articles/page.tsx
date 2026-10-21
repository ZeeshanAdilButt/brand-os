import type { Metadata } from 'next';
import Link from 'next/link';
import { BookOpen, ChevronLeft, ChevronRight, FileDown, FileText, Search } from 'lucide-react';
import { ArticleStatusBadge } from '@/components/articles/status-badge';
import { NewArticleButton } from '@/components/articles/new-article-button';
import { MarkedText } from '@/components/knowledge/marked-text';
import { PageHeader } from '@/components/page-header';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { approxReadingMinutes, ARTICLE_STATUSES, SOURCE_KIND_LABELS, STATUS_LABELS, type ArticleStatus } from '@/lib/articles';
import { cn } from '@/lib/utils';
import { articleCounts, listArticles } from '@/server/actions/articles';
import { ActionError, sessionToOwner } from '@/server/actions/owner';
import { requireSessionUser } from '@/server/auth/session';

export const metadata: Metadata = { title: 'Articles' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

function href(params: Record<string, string>): string {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== ''));
  const s = query.toString();
  return s ? `/articles?${s}` : '/articles';
}

const when = (d: Date) => d.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });

export default async function ArticlesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requireSessionUser();
  const owner = sessionToOwner(user, user.ctx);
  const raw = await searchParams;
  const q = first(raw.q).trim();
  const requested = first(raw.status);
  const status = (ARTICLE_STATUSES as readonly string[]).includes(requested) || requested === 'all' ? requested : '';
  const page = Math.max(1, Number.parseInt(first(raw.page), 10) || 1);

  const counts = await articleCounts(owner);
  let result: Awaited<ReturnType<typeof listArticles>> | null = null;
  let problem: string | null = null;
  try {
    result = await listArticles(owner, { q, status, limit: PAGE_SIZE + 1, offset: (page - 1) * PAGE_SIZE });
  } catch (err) {
    if (!(err instanceof ActionError)) throw err;
    problem = 'One of the filters is not valid. Reset the filters and try again.';
  }
  const hasMore = (result?.articles.length ?? 0) > PAGE_SIZE;
  const shown = result ? result.articles.slice(0, PAGE_SIZE) : [];
  const hitById = new Map(result?.hits?.map((h) => [h.article.id, h]) ?? []);
  const base = { q, status };
  const active = counts.draft + counts.ready;
  const tabs: { key: string; label: string; count: number }[] = [
    { key: '', label: 'Active', count: active },
    { key: 'draft', label: STATUS_LABELS.draft, count: counts.draft },
    { key: 'ready', label: STATUS_LABELS.ready, count: counts.ready },
    { key: 'archived', label: STATUS_LABELS.archived, count: counts.archived },
    { key: 'all', label: 'All', count: counts.total },
  ];
  const filtered = Boolean(q || status);

  return (
    <>
      <PageHeader
        eyebrow="Articles"
        title="Your technical articles"
        description="Write in Markdown with a live preview, import what you already have, and keep every version. Nothing here is published anywhere until you approve it."
      >
        <div className="flex flex-wrap items-start gap-2 pt-1">
          <NewArticleButton />
          <Link href="/articles/import" className={buttonVariants({ variant: 'outline' })}>
            <FileDown aria-hidden />
            Import
          </Link>
        </div>
      </PageHeader>

      {counts.total > 0 || filtered ? (
        <div className="mb-6 grid gap-4">
          <nav aria-label="Filter by status" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
            {tabs.map((tab) => {
              const current = (status || '') === tab.key;
              return (
                <Link
                  key={tab.key || 'active'}
                  href={href({ q, status: tab.key })}
                  aria-current={current ? 'page' : undefined}
                  className={cn(
                    'inline-flex h-9 shrink-0 items-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors',
                    current ? 'border-primary bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  {tab.label}
                  <span className={cn('rounded-full px-1.5 text-xs', current ? 'bg-primary-foreground/20' : 'bg-muted')}>{tab.count}</span>
                </Link>
              );
            })}
          </nav>
          <form method="get" action="/articles" role="search" className="flex gap-2">
            {status ? <input type="hidden" name="status" value={status} /> : null}
            <div className="relative flex-1">
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input name="q" defaultValue={q} placeholder="Search titles, text and tags" aria-label="Search your articles" className="pl-9" maxLength={200} />
            </div>
            <Button type="submit">Search</Button>
            {filtered ? (
              <Link href="/articles" className={buttonVariants({ variant: 'ghost' })}>
                Reset
              </Link>
            ) : null}
          </form>
        </div>
      ) : null}

      {problem ? <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{problem}</p> : null}

      {!problem && counts.total === 0 && !filtered ? (
        <section className="rounded-xl border border-dashed border-input bg-card/60 p-6 text-center sm:p-10">
          <div aria-hidden className="mx-auto mb-4 grid size-12 place-items-center rounded-xl border bg-background text-link shadow-soft">
            <FileText className="size-6" />
          </div>
          <h2 className="font-serif text-2xl font-semibold">No articles yet</h2>
          <p className="mx-auto mt-2 max-w-xl leading-relaxed text-muted-foreground">
            Start a new article, or bring in one you have already written: a Markdown file, a page on your site, or a folder of posts. Code blocks, tables and
            diagrams come across intact.
          </p>
          <div className="mt-6 flex flex-wrap items-start justify-center gap-2">
            <NewArticleButton label="Write your first article" />
            <Link href="/articles/import" className={buttonVariants({ variant: 'outline' })}>
              <FileDown aria-hidden />
              Import an article
            </Link>
          </div>
        </section>
      ) : null}

      {!problem && result && shown.length === 0 && (counts.total > 0 || filtered) ? (
        <section className="rounded-xl border border-dashed border-input bg-card/60 p-8 text-center">
          <h2 className="font-serif text-xl font-semibold">{q ? 'No matches' : 'Nothing with this status'}</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
            {q ? 'Search looks at titles, descriptions, tags and text, and matches word stems (run finds running). Try fewer or different words.' : 'Pick another tab above.'}
          </p>
          <Link href="/articles" className={cn(buttonVariants({ variant: 'outline' }), 'mt-5')}>
            Reset filters
          </Link>
        </section>
      ) : null}

      {shown.length > 0 ? (
        <>
          <p className="mb-3 text-sm text-muted-foreground" aria-live="polite">
            {q ? `${shown.length}${hasMore || page > 1 ? '+' : ''} ranked ${shown.length === 1 && !hasMore ? 'result' : 'results'} for "${q}"` : `${shown.length}${hasMore || page > 1 ? '+' : ''} ${shown.length === 1 && !hasMore ? 'article' : 'articles'}`}
          </p>
          <ul className="grid gap-3">
            {shown.map((article) => {
              const hit = hitById.get(article.id);
              const minutes = approxReadingMinutes(article.bodyChars);
              return (
                <li key={article.id} className="rounded-xl border bg-card p-4 shadow-xs sm:p-5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <ArticleStatusBadge status={article.status as ArticleStatus} />
                    {article.sourceKind !== 'manual' ? (
                      <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">{SOURCE_KIND_LABELS[article.sourceKind]}</span>
                    ) : null}
                  </div>
                  <h2 className="mt-3 font-serif text-lg font-semibold leading-snug">
                    <Link href={`/articles/${article.id}`} className="rounded-sm hover:underline">
                      {hit ? <MarkedText text={hit.titleMarked} /> : article.title || 'Untitled article'}
                    </Link>
                  </h2>
                  {hit ? (
                    <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                      <MarkedText text={hit.snippet} />
                    </p>
                  ) : article.description ? (
                    <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-muted-foreground">{article.description}</p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
                    {article.tags.length > 0 ? (
                      <ul aria-label="Tags" className="flex flex-wrap gap-1.5">
                        {article.tags.slice(0, 6).map((tag) => (
                          <li key={tag} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem]">
                            {tag}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <span>Edited {when(article.updatedAt)}</span>
                    <span>{minutes === 0 ? 'Empty' : `about ${minutes} min read`}</span>
                    <span className="flex items-center gap-1 sm:ml-auto">
                      <Link href={`/articles/${article.id}/read`} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
                        <BookOpen aria-hidden />
                        Read
                      </Link>
                      <Link href={`/articles/${article.id}`} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                        Edit
                      </Link>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
          {page > 1 || hasMore ? (
            <nav aria-label="Pagination" className="mt-6 flex items-center justify-between">
              {page > 1 ? (
                <Link href={href({ ...base, page: String(page - 1) })} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                  <ChevronLeft aria-hidden />
                  Previous
                </Link>
              ) : (
                <span />
              )}
              <span className="text-sm text-muted-foreground">Page {page}</span>
              {hasMore ? (
                <Link href={href({ ...base, page: String(page + 1) })} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                  Next
                  <ChevronRight aria-hidden />
                </Link>
              ) : (
                <span />
              )}
            </nav>
          ) : null}
        </>
      ) : null}
    </>
  );
}
