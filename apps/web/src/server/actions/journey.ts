import { computeJourney, publishHref, toJourneyDestinations, type Journey } from '../../lib/next-step';
import type { DraftStatus, PlatformId, PublishedVia } from '../../lib/publishing';
import { listDestinations, listDrafts } from './publishing';
import { listArticles } from './articles';
import type { OwnerContext } from './owner';
import type { PublishEnv } from '../publishing/registry';

/** What Home shows: the one next action, the checklist for the article it is about, and recent work. Everything is read from real state. */
export interface HomeData {
  /** Why this is the headline: attention (an outcome or a post waiting on you), continuing work, or a fresh start. */
  kicker: 'attention' | 'continue' | 'start';
  headline: string;
  why: string;
  href: string;
  /** A quieter second way in, when there is one. */
  alternative: { label: string; href: string | null; newArticle?: true } | null;
  journey: Journey | null;
  focus: { id: string; title: string } | null;
  articles: { id: string; title: string; status: string; updatedAt: string; empty: boolean }[];
  results: { id: string; articleId: string; articleTitle: string; platform: PlatformId; status: DraftStatus; publishedVia: PublishedVia | null; remoteUrl: string | null; updatedAt: string }[];
  articleCount: number;
}

export async function getHome(owner: OwnerContext, env: Pick<PublishEnv, 'now'>): Promise<HomeData> {
  const [list, drafts] = await Promise.all([listArticles(owner, { limit: 30 }), listDrafts(owner, env, { limit: 100 })]);
  const articles = list.articles;
  const titleOf = new Map(articles.map((a) => [a.id, a.title || 'Untitled article']));

  // Order of importance: an unknown outcome, then a post waiting for review, then unfinished work, then a fresh start.
  const unknown = drafts.find((d) => d.status === 'unknown');
  const waiting = drafts.find((d) => d.status === 'pending_approval' && d.approval?.status === 'pending');
  // Unfinished work: an article with text that still has something to prepare or publish. An empty draft is a last resort.
  const withText = articles.filter((a) => a.bodyChars > 0);
  const hasUnpublished = (id: string) => drafts.some((d) => d.articleId === id && d.status !== 'published');
  const hasPublished = (id: string) => drafts.some((d) => d.articleId === id && d.status === 'published');
  const unfinished = withText.find((a) => hasUnpublished(a.id)) ?? withText.find((a) => !hasPublished(a.id)) ?? withText[0] ?? articles[0] ?? null;
  const focus = unknown ? articles.find((a) => a.id === unknown.articleId) : waiting ? articles.find((a) => a.id === waiting.articleId) : unfinished;

  let journey: Journey | null = null;
  if (focus) {
    const destinations = await listDestinations(owner, env, focus.id);
    journey = computeJourney({
      articleCount: articles.length,
      article: { id: focus.id, title: focus.title, hasText: focus.bodyChars > 0 },
      destinations: toJourneyDestinations(destinations),
    });
  }

  let kicker: HomeData['kicker'] = 'start';
  let headline = 'Import an article';
  let why = 'Everything starts from one article. Bring in a Markdown file or a page, or write one from scratch.';
  let href = '/articles/import';
  let alternative: HomeData['alternative'] = { label: 'Write from scratch', href: null, newArticle: true };
  if (unknown && focus) {
    kicker = 'attention';
    headline = 'Check post status';
    why = 'A publish to one destination has an unknown result. Checking only reads, and nothing is sent again.';
    href = publishHref(focus.id, { step: '3', d: unknown.platform });
    alternative = null;
  } else if (waiting && focus) {
    kicker = 'attention';
    headline = 'Review next post';
    why = 'A post is waiting for your approval. Nothing goes public until you approve it.';
    href = publishHref(focus.id, { step: '3', d: waiting.platform });
    alternative = null;
  } else if (focus && journey) {
    kicker = 'continue';
    headline = journey.allDone ? `“${focus.title || 'Untitled article'}” is out` : `Continue “${focus.title || 'Untitled article'}”`;
    why = journey.next.why;
    href = journey.next.href;
    alternative = { label: 'Import another article', href: '/articles/import' };
  }

  const results = drafts
    .filter((d) => d.status === 'published' || d.status === 'failed' || d.status === 'unknown')
    .slice(0, 5)
    .map((d) => ({ id: d.id, articleId: d.articleId, articleTitle: titleOf.get(d.articleId) ?? 'An article', platform: d.platform, status: d.status, publishedVia: d.publishedVia, remoteUrl: d.remoteUrl, updatedAt: d.updatedAt }));

  return {
    kicker,
    headline,
    why,
    href,
    alternative,
    journey,
    focus: focus ? { id: focus.id, title: focus.title || 'Untitled article' } : null,
    articles: articles.slice(0, 5).map((a) => ({ id: a.id, title: a.title || 'Untitled article', status: a.status, updatedAt: a.updatedAt.toISOString(), empty: a.bodyChars === 0 })),
    results,
    articleCount: articles.length,
  };
}
