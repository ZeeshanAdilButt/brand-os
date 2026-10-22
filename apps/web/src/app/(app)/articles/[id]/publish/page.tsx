import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { PublishScreen } from '@/components/publish/publish-screen';
import { parseSearch } from '@/lib/publish-address';
import { articleFacts } from '@/lib/recommend';
import { renderMarkdown } from '@/lib/markdown/render';
import { aiAvailability } from '@/server/actions/ai-providers';
import { getArticle } from '@/server/actions/articles';
import { getSiteSettings } from '@/server/actions/composer';
import { ActionError, sessionToOwner } from '@/server/actions/owner';
import { listDestinations } from '@/server/actions/publishing';
import { requireSessionUser } from '@/server/auth/session';

export const metadata: Metadata = { title: 'Publish' };
export const dynamic = 'force-dynamic';

export default async function PublishPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ view?: string; step?: string; d?: string }> }) {
  const { id } = await params;
  const initial = parseSearch(await searchParams);
  const user = await requireSessionUser();
  const owner = sessionToOwner(user, user.ctx);
  let article;
  try {
    article = await getArticle(owner, id);
  } catch (err) {
    if (err instanceof ActionError && err.code === 'not_found') notFound();
    throw err;
  }
  const [destinations, site, ai, rendered] = await Promise.all([listDestinations(owner, {}, article.id), getSiteSettings(owner), aiAvailability(owner), renderMarkdown(article.bodyMarkdown)]);
  let siteHost: string | null = null;
  try {
    siteHost = site.siteUrl ? new URL(site.siteUrl).hostname : null;
  } catch {
    siteHost = null;
  }

  return (
    <>
      <PageHeader title="Publish" description={article.title ? `Send “${article.title}” where your readers are. Each post needs your own approval.` : 'Send this article where your readers are. Each post needs your own approval.'} />
      <PublishScreen
        articleId={article.id}
        article={{ title: article.title, body: article.bodyMarkdown }}
        html={rendered.html}
        destinations={destinations}
        facts={{ siteHost, repo: site.repo, baseBranch: site.baseBranch }}
        articleFacts={articleFacts({ bodyMarkdown: article.bodyMarkdown, tags: article.tags, canonicalUrl: article.canonicalUrl, description: article.description })}
        aiAvailable={ai.available}
        revision={article.revision}
        initial={initial}
      />
    </>
  );
}
