import { describe, expect, it } from 'vitest';
import { PLATFORM_IDS, PLATFORMS, PUBLISHABLE_IDS, isPublishable, publishingState, type PlatformId } from '../src/lib/catalog';
import { previewText } from '../src/lib/previews';
import type { DraftPayload } from '../src/lib/publishing';
import { adaptShortText, chapterProblems, countPost, firstSentence, foldText, graphemeCount, keyPoints, linksIn, splitPosts, toHashtag, xWeightedLength } from '../src/lib/short-form';
import { contentAdapter, lintContent } from '../src/server/publishing/adapters/content';
import { PlatformError } from '../src/server/publishing/errors';
import { adapterFor } from '../src/server/publishing/registry';

const ARTICLE = {
  title: 'Why the write path stalls',
  description: 'The write path stalls when the log fills, and three settings decide how long.',
  tags: ['Go', 'databases', 'C++', 'distributed systems'],
  canonicalUrl: 'https://example-blog.dev/posts/write-path',
  coverImageUrl: null,
  series: null,
  bodyMarkdown: '# Why\n\nThe write path stalls when the log fills. It is a queue.\n\n## The log\n\nDetails.\n\n## The flush\n\nMore details.\n\n## The fix\n\nShort.\n',
};

const payload = (over: Partial<DraftPayload> = {}): DraftPayload => ({
  title: ARTICLE.title,
  description: ARTICLE.description,
  tags: [],
  canonicalUrl: ARTICLE.canonicalUrl,
  coverImageUrl: null,
  series: null,
  bodyMarkdown: 'Hello.',
  ...over,
});

const codes = (platform: PlatformId, p: DraftPayload, extras = {}) => lintContent(platform, p, extras).map((i) => `${i.severity}:${i.code}`);

describe('the destination catalog', () => {
  it('has every platform on the roadmap, each with a name, a reason, limits and a way to post by hand', () => {
    expect([...PLATFORM_IDS].sort()).toEqual(['bluesky', 'devto', 'hackernews', 'hashnode', 'linkedin', 'mastodon', 'medium', 'reddit', 'site', 'substack', 'threads', 'x', 'youtube']);
    for (const id of PLATFORM_IDS) {
      const info = PLATFORMS[id];
      expect(info.name, id).not.toBe('');
      expect(info.reason.length, id).toBeGreaterThan(20);
      expect(info.manual.openUrl, id).toMatch(/^https:\/\//);
      expect(info.manual.steps.length, id).toBeGreaterThanOrEqual(2);
      expect(info.connect.steps.length, id).toBeGreaterThanOrEqual(2);
      expect(info.verification.label, id).not.toBe('');
    }
  });

  it('enables only the three destinations that have a connector, and never fakes the rest', () => {
    expect([...PUBLISHABLE_IDS].sort()).toEqual(['devto', 'hashnode', 'site']);
    for (const id of PLATFORM_IDS.filter((p) => !PUBLISHABLE_IDS.includes(p))) {
      expect(isPublishable(id), id).toBe(false);
      expect(['preview_only', 'manual_only', 'coming_later']).toContain(publishingState(id, true));
      expect(publishingState(id, false)).toBe(publishingState(id, true));
    }
    expect(publishingState('devto', false)).toBe('connect_required');
    expect(publishingState('devto', true)).toBe('available');
  });

  it('states the reason each one is not actionable, with its roadmap day where there is one', () => {
    expect(PLATFORMS.medium.reason).toMatch(/no API/i);
    expect(PLATFORMS.hackernews.reason).toMatch(/no submission API/i);
    expect(PLATFORMS.hackernews.reason).toMatch(/pre-filled submit link/i);
    expect(PLATFORMS.linkedin.roadmap).toBe('Phase 2, Day 9');
    expect(PLATFORMS.x.capabilities.cost).toMatch(/\$0\.20/);
    expect(PLATFORMS.x.unverified.length).toBeGreaterThan(0);
  });

  it('chooses a connect method that matches what the platform offers', () => {
    expect(PLATFORMS.devto.connectMethod).toBe('api_key_guided');
    expect(PLATFORMS.bluesky.connectMethod).toBe('api_key_guided');
    for (const id of ['linkedin', 'x', 'threads', 'mastodon', 'youtube'] as const) {
      expect(PLATFORMS[id].connectMethod, id).toBe('oauth');
      expect(PLATFORMS[id].connect.oauth?.scopes.length, id).toBeGreaterThan(0);
      expect(PLATFORMS[id].connect.oauth?.redirectPath, id).toMatch(/^\/api\/connect\//);
    }
    for (const id of ['medium', 'substack', 'reddit', 'hackernews'] as const) expect(PLATFORMS[id].connectMethod, id).toBe('manual_only');
  });
});

describe('counting', () => {
  it('counts a joined emoji as one grapheme and a link as 23 on X', () => {
    expect(graphemeCount('a👨‍👩‍👧‍👦b')).toBe(3);
    expect(xWeightedLength('a'.repeat(10))).toBe(10);
    expect(xWeightedLength(`see https://example-blog.dev/a/very/long/path/that/goes/on/and/on/forever/and/ever.html ok`)).toBe('see '.length + 23 + ' ok'.length);
    // CJK and emoji weigh 2 on X.
    expect(xWeightedLength('日本語')).toBe(6);
    expect(xWeightedLength('😀')).toBe(2);
  });

  it('finds links without trailing punctuation', () => {
    expect(linksIn('Read https://example-blog.dev/a, then (http://x.test/b).')).toEqual(['https://example-blog.dev/a', 'http://x.test/b']);
  });

  it('counts each platform in its own unit', () => {
    expect(countPost('bluesky', '👨‍👩‍👧‍👦'.repeat(300))).toBe(300);
    expect(countPost('x', 'x'.repeat(280))).toBe(280);
    expect(countPost('mastodon', `${'x'.repeat(10)} https://example-blog.dev/${'p'.repeat(200)}`)).toBe(10 + 1 + 23);
    expect(countPost('threads', 'é'.repeat(3))).toBe(3);
  });
});

describe('X: 280 per post, and a thread split', () => {
  it('keeps a post of exactly 280 whole and splits 281 into a thread', () => {
    expect(splitPosts('x', 'a'.repeat(280))).toHaveLength(1);
    const words = Array.from({ length: 70 }, (_, i) => `word${i}`).join(' ');
    const posts = splitPosts('x', words);
    expect(posts.length).toBeGreaterThan(1);
    for (const post of posts) expect(post.count).toBeLessThanOrEqual(280);
    expect(posts.map((p) => p.text).join(' ').replace(/\s+/g, ' ')).toBe(words);
  });

  it('respects explicit --- lines and splits long sentences inside a chunk', () => {
    const posts = splitPosts('x', 'First post.\n---\nSecond post.\n---\nThird post.');
    expect(posts.map((p) => p.text)).toEqual(['First post.', 'Second post.', 'Third post.']);
    const long = `${'Sentence one is here. '.repeat(20)}\n---\nTail`;
    expect(splitPosts('x', long).length).toBeGreaterThan(2);
  });

  it('flags an unsplittable post as an error and a thread as a warning', () => {
    expect(codes('x', payload({ bodyMarkdown: 'ok' }))).not.toContain('error:post_too_long');
    const thread = Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ');
    expect(codes('x', payload({ bodyMarkdown: thread }))).toContain('warning:thread');
    expect(codes('x', payload({ bodyMarkdown: thread }))).not.toContain('error:post_too_long');
  });

  it('warns when more than one post carries a link, because each costs $0.20', () => {
    const body = 'One https://example-blog.dev/a\n---\nTwo https://example-blog.dev/b';
    expect(codes('x', payload({ bodyMarkdown: body }))).toContain('warning:x_link_cost');
    expect(codes('x', payload({ bodyMarkdown: 'One\n---\nTwo https://example-blog.dev/b' }))).not.toContain('warning:x_link_cost');
  });

  it('starts from a thread with the link in the last post only', () => {
    const { text } = adaptShortText('x', ARTICLE);
    const posts = splitPosts('x', text);
    expect(posts.length).toBeGreaterThanOrEqual(2);
    expect(posts.filter((p) => linksIn(p.text).length > 0)).toHaveLength(1);
    expect(linksIn(posts.at(-1)!.text)).toEqual([ARTICLE.canonicalUrl]);
    for (const post of posts) expect(post.over).toBe(false);
  });
});

describe('Bluesky (300 graphemes), Threads (500), Mastodon (500)', () => {
  it('Bluesky counts graphemes, not code units', () => {
    const family = '👨‍👩‍👧‍👦';
    expect(splitPosts('bluesky', family.repeat(300))).toHaveLength(1);
    expect(splitPosts('bluesky', `${family.repeat(300)} ${family.repeat(10)}`).length).toBe(2);
    expect(codes('bluesky', payload({ bodyMarkdown: 'a'.repeat(300) }))).toEqual(expect.not.arrayContaining(['error:post_too_long']));
  });

  it('adapts to fit one post, with the link and hashtags kept', () => {
    for (const [platform, limit] of [['bluesky', 300], ['threads', 500], ['mastodon', 500]] as const) {
      const { text } = adaptShortText(platform, { ...ARTICLE, description: 'Very long description. '.repeat(60) });
      expect(countPost(platform, text), platform).toBeLessThanOrEqual(limit);
      expect(text, platform).toContain(ARTICLE.canonicalUrl);
    }
  });

  it('Threads keeps one topic tag; Mastodon needs plain hashtags and an instance for a share link', () => {
    expect(codes('threads', payload({ bodyMarkdown: 'Hi #one #two' }))).toContain('warning:threads_topic');
    expect(codes('mastodon', payload({ bodyMarkdown: 'Hi #good-tag' }))).toContain('warning:hashtag_form');
    expect(codes('mastodon', payload())).toContain('warning:instance_missing');
    expect(codes('mastodon', payload(), { options: { instance: 'hachyderm.io' } })).not.toContain('warning:instance_missing');
  });

  it('makes hashtags from tags', () => {
    expect(toHashtag('distributed systems')).toBe('DistributedSystems');
    expect(toHashtag('C++')).toBe('C');
    expect(toHashtag('go')).toBe('go');
    expect(toHashtag('123')).toBe('');
  });
});

describe('LinkedIn (long post, "see more" fold)', () => {
  it('errors past 3,000 characters and never splits into a thread', () => {
    expect(codes('linkedin', payload({ bodyMarkdown: 'x'.repeat(3000) }))).not.toContain('error:post_too_long');
    expect(codes('linkedin', payload({ bodyMarkdown: 'x'.repeat(3001) }))).toContain('error:post_too_long');
    expect(splitPosts('linkedin', 'word '.repeat(1000))).toHaveLength(1);
  });

  it('cuts the preview at the fold, on a word boundary', () => {
    const body = `${'word '.repeat(80)}end`;
    const { shown, hidden } = foldText(body, 210);
    expect([...shown].length).toBeLessThanOrEqual(210);
    expect(hidden.length).toBeGreaterThan(0);
    expect(`${shown} ${hidden}`.replace(/\s+/g, ' ')).toBe(body);
    expect(foldText('short', 210)).toEqual({ shown: 'short', hidden: '' });
    expect(previewText('linkedin', payload({ bodyMarkdown: body }))).toMatch(/see more/);
    expect(previewText('linkedin', payload({ bodyMarkdown: 'short' }))).not.toMatch(/see more/);
  });

  it('starts from the title, a hook, the key points and the link', () => {
    const { text } = adaptShortText('linkedin', ARTICLE);
    expect(text).toContain(ARTICLE.title);
    expect(text).toContain('• The log');
    expect(text).toContain(`Read the full post: ${ARTICLE.canonicalUrl}`);
    expect(text).toMatch(/#Go/);
  });
});

describe('Hacker News, Reddit and YouTube', () => {
  it('Hacker News titles are at most 80 characters and need a link', () => {
    expect(codes('hackernews', payload({ title: 'x'.repeat(80) }))).not.toContain('error:title_long');
    expect(codes('hackernews', payload({ title: 'x'.repeat(81) }))).toContain('error:title_long');
    expect(codes('hackernews', payload({ canonicalUrl: null }))).toContain('error:url_missing');
    expect(codes('hackernews', payload({ bodyMarkdown: 'some text' }))).toContain('warning:text_and_link');
    expect(codes('hackernews', payload({ title: 'AN ALL CAPITALS HEADLINE HERE' }))).toContain('warning:title_caps');
    expect(previewText('hackernews', payload({ title: 'x'.repeat(81) }))).toMatch(/81 of 80/);
  });

  it('Reddit needs a valid subreddit for the pre-filled link, and has a body limit', () => {
    expect(codes('reddit', payload())).toContain('warning:subreddit_missing');
    expect(codes('reddit', payload(), { options: { subreddit: 'r/programming' } })).not.toContain('warning:subreddit_missing');
    expect(codes('reddit', payload(), { options: { subreddit: 'bad name!' } })).toContain('error:subreddit_form');
    expect(codes('reddit', payload({ title: 'x'.repeat(301) }))).toContain('error:title_long');
  });

  it('YouTube shows metadata only and checks title, description and chapters', () => {
    expect(codes('youtube', payload())).toContain('warning:no_video');
    expect(codes('youtube', payload({ title: 'x'.repeat(101) }))).toContain('error:title_long');
    expect(codes('youtube', payload({ bodyMarkdown: 'x'.repeat(5001) }))).toContain('error:description_long');
    expect(chapterProblems('0:00 Intro\n1:00 Middle\n2:30 End')).toEqual([]);
    expect(chapterProblems('0:10 Intro\n1:00 Middle\n2:30 End')).toContain('The first chapter must start at 0:00.');
    expect(chapterProblems('0:00 Intro\n0:05 Middle\n2:30 End')).toContain('Each chapter must be at least 10 seconds long.');
    expect(chapterProblems('0:00 Intro\n1:00 Middle')).toContain('YouTube needs at least three chapters.');
    expect(previewText('youtube', payload())).toMatch(/No video is attached/);
  });
});

describe('long-form destinations that are not connected', () => {
  it('Medium warns about tables and extra topics; Substack about the missing canonical field', () => {
    const table = '| a | b |\n|---|---|\n| 1 | 2 |\n';
    expect(codes('medium', payload({ bodyMarkdown: table }))).toContain('warning:tables_unsupported');
    expect(codes('medium', payload({ tags: ['a', 'b', 'c', 'd', 'e', 'f'] }))).toContain('warning:tags_too_many');
    expect(codes('substack', payload())).toContain('warning:no_canonical_field');
    expect(adapterFor('substack').adapt(ARTICLE).payload.bodyMarkdown).toMatch(/Originally published at https:\/\/example-blog.dev\/posts\/write-path/);
  });
});

describe('every destination can be previewed and checked', () => {
  it.each(PLATFORM_IDS)('%s: adapts the article, lints it and renders an approximate preview', (platform) => {
    const adapter = adapterFor(platform);
    const { payload: adapted } = adapter.adapt(ARTICLE);
    expect(adapted.title, 'title').toBe(ARTICLE.title);
    expect(Array.isArray(adapter.validate(adapted, platform === 'site' ? {} : undefined))).toBe(true);
    const text = previewText(platform, adapted);
    expect(text).toMatch(/^Approximate preview of /);
    expect(text).toContain(PLATFORMS[platform].name);
  });

  it('adapted short posts start inside their limits', () => {
    for (const platform of ['x', 'bluesky', 'threads', 'mastodon', 'linkedin'] as const) {
      const { payload: adapted } = adapterFor(platform).adapt(ARTICLE);
      expect(lintContent(platform, adapted).filter((i) => i.severity === 'error'), platform).toEqual([]);
    }
  });

  it('pulls a hook, key points and a sentence from the article', () => {
    expect(firstSentence('# Title\n\nThe write path stalls when the log fills. It is a queue.\n')).toBe('The write path stalls when the log fills.');
    expect(keyPoints(ARTICLE.bodyMarkdown)).toEqual(['The log', 'The flush', 'The fix']);
  });
});

describe('destinations without a connector cannot reach any platform', () => {
  it.each(PLATFORM_IDS.filter((p) => !isPublishable(p)))('%s: health, stage, publish and check all refuse, and say nothing was sent', async (platform) => {
    const adapter = contentAdapter(platform);
    const ctx = { secret: 'x', config: {}, fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch, now: () => new Date(), baseUrl: '', timeoutMs: 10 };
    const draft = { id: 'd', payload: payload(), remoteId: null };
    for (const call of [() => adapter.health(ctx), () => adapter.stage(ctx, draft), () => adapter.publish(ctx, draft), () => adapter.check(ctx, draft)]) {
      const err = await call().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(PlatformError);
      expect((err as PlatformError).notSent).toBe(true);
    }
  });
});
