import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { PublishScreen } from '@/components/publish/publish-screen';
import { parseSearch } from '@/lib/publish-address';
import { renderMarkdown } from '@/lib/markdown/render';
import { workspaceHref } from '@/lib/next-step';
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
  // Choosing platforms and previewing them is one screen now; this page is for approving and for the composer.
  if (initial.view !== 'composer' && (initial.step === null || initial.step === 1 || initial.step === 2)) redirect(workspaceHref(id, initial.focus ?? undefined));
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
      <PageHeader title={initial.view === 'composer' ? 'Composer' : 'Approve'} description={article.title ? `Review and approve each post of “${article.title}”, one at a time.` : 'Review and approve each post, one at a time.'} />
      <PublishScreen
        articleId={article.id}
        article={{ title: article.title, body: article.bodyMarkdown }}
        html={rendered.html}
        destinations={destinations}
        facts={{ siteHost, repo: site.repo, baseBranch: site.baseBranch }}
        aiAvailable={ai.available}
        revision={article.revision}
        initial={initial}
      />
    </>
  );
}
