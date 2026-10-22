import { PLATFORMS, RECOMMENDED_ORDER, isPlatformId, type PlatformId } from './catalog';

/**
 * "Recommended for this article" chips in the publish wizard. The rules are plain and visible: each chip says why.
 * They look only at facts about the article, what the owner has connected and what they chose last time. They never
 * pick for the owner; they only order and explain.
 */

export interface ArticleFacts {
  words: number;
  hasCode: boolean;
  hasCanonical: boolean;
  hasDescription: boolean;
  tags: string[];
}

export function articleFacts(article: { bodyMarkdown: string; tags: string[]; canonicalUrl: string | null; description: string }): ArticleFacts {
  const words = (article.bodyMarkdown.replace(/```[\s\S]*?```/g, ' ').match(/[\p{L}\p{N}']+/gu) ?? []).length;
  return {
    words,
    hasCode: /^(```|~~~)/m.test(article.bodyMarkdown),
    hasCanonical: Boolean(article.canonicalUrl),
    hasDescription: article.description.trim().length > 0,
    tags: article.tags,
  };
}

export interface Recommendation {
  platform: PlatformId;
  reason: string;
}

export interface RecommendOptions {
  /** Platforms the owner already connected. */
  connected: ReadonlySet<PlatformId>;
  /** What the owner picked the last time, most recent first. */
  remembered: readonly PlatformId[];
}

const LIMIT = 5;

export function recommend(facts: ArticleFacts, options: RecommendOptions): Recommendation[] {
  const picked = new Map<PlatformId, string>();
  const add = (platform: PlatformId, reason: string) => {
    if (!picked.has(platform)) picked.set(platform, reason);
  };

  add('site', 'Your own site is the canonical home: publish there first.');
  if (facts.words >= 300) {
    add('devto', facts.hasCode ? 'A technical article with code suits DEV.to readers.' : 'A full article reaches DEV.to readers, with a link back to your site.');
  }
  if (facts.words >= 400 && options.connected.has('hashnode')) add('hashnode', 'Your Hashnode account is connected, and a full article fits.');
  if (facts.hasCanonical) add('linkedin', 'A short post with the link brings your network to the article.');
  if (facts.hasCanonical) add('bluesky', 'Free and quick: a short post with the link.');
  if (facts.hasCode && facts.words >= 600 && facts.hasCanonical) add('hackernews', 'A substantial technical piece. Hacker News is strict about promotion: read its rules.');

  for (const platform of options.remembered) {
    if (isPlatformId(platform)) add(platform, `You chose ${PLATFORMS[platform].name} last time.`);
  }
  // Connected accounts the owner has not chosen are worth a nudge only when the article is long enough to fill them.
  for (const platform of options.connected) {
    if (facts.words >= 300 && PLATFORMS[platform].kind === 'long_form') add(platform, `${PLATFORMS[platform].name} is connected.`);
  }

  return [...picked.entries()]
    .map(([platform, reason]) => ({ platform, reason }))
    .sort((a, b) => RECOMMENDED_ORDER.indexOf(a.platform) - RECOMMENDED_ORDER.indexOf(b.platform))
    .slice(0, LIMIT);
}
