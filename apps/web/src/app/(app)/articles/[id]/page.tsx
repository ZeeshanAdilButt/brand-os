import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { StudioLoader } from '@/components/articles/studio-loader';
import type { ArticleDTO } from '@/lib/articles';
import { aiAvailability } from '@/server/actions/ai-providers';
import { getArticle } from '@/server/actions/articles';
import { ActionError, sessionToOwner } from '@/server/actions/owner';
import { requireSessionUser } from '@/server/auth/session';

export const metadata: Metadata = { title: 'Article studio' };
export const dynamic = 'force-dynamic';

export default async function ArticleStudioPage({ params }: { params: Promise<{ id: string }> }) {
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
  // Dates cross to the browser as plain strings.
  const initial: ArticleDTO = {
    id: article.id,
    title: article.title,
    slug: article.slug,
    description: article.description,
    tags: article.tags,
    canonicalUrl: article.canonicalUrl,
    coverAssetId: article.coverAssetId,
    status: article.status,
    bodyMarkdown: article.bodyMarkdown,
    sourceKind: article.sourceKind,
    sourceRef: article.sourceRef,
    extraMetadata: article.extraMetadata,
    revision: article.revision,
    createdAt: article.createdAt.toISOString(),
    updatedAt: article.updatedAt.toISOString(),
    publishedAt: article.publishedAt ? article.publishedAt.toISOString() : null,
  };
  const { providers } = await aiAvailability(owner);
  return <StudioLoader initial={initial} providers={providers} />;
}
