import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Clock, PenLine } from 'lucide-react';
import { ArticleStatusBadge } from '@/components/articles/status-badge';
import { RenderedMarkdown, RenderNotices } from '@/components/articles/rendered-markdown';
import { buttonVariants } from '@/components/ui/button';
import { countWords, readingMinutes } from '@/lib/articles';
import { renderMarkdown } from '@/lib/markdown/render';
import { getArticle } from '@/server/actions/articles';
import { ActionError, sessionToOwner } from '@/server/actions/owner';
import { requireSessionUser } from '@/server/auth/session';

export const metadata: Metadata = { title: 'Reading view' };
export const dynamic = 'force-dynamic';

export default async function ReadArticlePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireSessionUser();
  const owner = sessionToOwner(user, user.ctx);
  let article;
  try {
    article = await getArticle(owner, id);
  } catch (err) {
    if (err instanceof ActionError && err.code === 'not_found') notFound();
    throw err;
  }
  const rendered = await renderMarkdown(article.bodyMarkdown);
  const words = countWords(article.bodyMarkdown);
  const minutes = readingMinutes(words);
  const toc = rendered.headings.filter((h) => h.depth === 2 || h.depth === 3);

  return (
    <div className="mx-auto max-w-[68rem]">
      <div className="mb-8 flex flex-wrap items-center gap-2">
        <Link href="/articles" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
          <ArrowLeft aria-hidden />
          All articles
        </Link>
        <Link href={`/articles/${article.id}`} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          <PenLine aria-hidden />
          Edit
        </Link>
      </div>

      <div className="grid gap-10 xl:grid-cols-[minmax(0,44rem)_14rem] xl:justify-center">
        <article aria-labelledby="article-title" className="min-w-0">
          <header className="mb-8 border-b pb-6">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <ArticleStatusBadge status={article.status} />
              {article.canonicalUrl ? (
                <a href={article.canonicalUrl} rel="noopener noreferrer nofollow" className="truncate text-xs text-link underline underline-offset-2">
                  Canonical: {article.canonicalUrl}
                </a>
              ) : null}
            </div>
            <h1 id="article-title" className="font-serif text-4xl font-semibold leading-tight sm:text-5xl">
              {article.title || 'Untitled article'}
            </h1>
            {article.description ? <p className="mt-4 font-serif text-xl leading-relaxed text-muted-foreground">{article.description}</p> : null}
            <p className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <Clock aria-hidden className="size-4" />
                {minutes === 0 ? 'No text yet' : `${minutes} min read`}
              </span>
              <span>{words.toLocaleString('en')} words</span>
              <span>Edited {article.updatedAt.toLocaleDateString('en', { year: 'numeric', month: 'long', day: 'numeric' })}</span>
            </p>
            {article.tags.length > 0 ? (
              <ul aria-label="Tags" className="mt-4 flex flex-wrap gap-1.5">
                {article.tags.map((tag) => (
                  <li key={tag} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {tag}
                  </li>
                ))}
              </ul>
            ) : null}
          </header>

          {article.coverAssetId ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/api/assets/${article.coverAssetId}`} alt="" className="mb-8 aspect-[16/9] w-full rounded-xl border object-cover" />
          ) : null}

          <RenderNotices notices={rendered.notices} className="mb-8" />

          {article.bodyMarkdown.trim() === '' ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-muted-foreground">
              This article has no text yet.{' '}
              <Link href={`/articles/${article.id}`} className="text-link underline underline-offset-2">
                Open the editor
              </Link>
              .
            </p>
          ) : (
            <RenderedMarkdown html={rendered.html} />
          )}
        </article>

        {toc.length > 2 ? (
          <nav aria-label="On this page" className="hidden xl:block">
            <div className="sticky top-24">
              <p className="label-caps mb-3 text-muted-foreground">On this page</p>
              <ul className="grid gap-1.5 border-l text-sm">
                {toc.map((heading) => (
                  <li key={heading.id} style={{ paddingLeft: heading.depth === 3 ? '1.5rem' : '0.75rem' }}>
                    <a href={`#${heading.id}`} className="block rounded-sm leading-snug text-muted-foreground hover:text-foreground">
                      {heading.text}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </nav>
        ) : null}
      </div>
    </div>
  );
}
