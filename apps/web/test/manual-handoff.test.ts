import { describe, expect, it } from 'vitest';
import { PLATFORM_IDS, PLATFORMS } from '../src/lib/catalog';
import { buildManualKit, validateManualUrl, type ManualContext } from '../src/lib/manual';
import type { DraftPayload } from '../src/lib/publishing';

const SITE: ManualContext = { siteHost: 'www.example-blog.dev', siteRepo: 'example-owner/example-site', siteBase: 'main', sitePath: 'content/posts/write-path.md', siteFile: '---\ntitle: T\n---\n\nBody\n' };

const payload = (over: Partial<DraftPayload> = {}): DraftPayload => ({
  title: 'Why the write path stalls',
  description: 'A short look at write stalls.',
  tags: ['go', 'databases'],
  canonicalUrl: 'https://example-blog.dev/posts/write-path',
  coverImageUrl: null,
  series: null,
  bodyMarkdown: 'The write path stalls when the log fills.',
  ...over,
});

describe('the manual posting kit', () => {
  it.each(PLATFORM_IDS)('%s: always has something to copy, a page to open and plain steps', (platform) => {
    const kit = buildManualKit(platform, payload(), {}, SITE);
    expect(kit.all.length).toBeGreaterThan(10);
    expect(kit.parts.length).toBeGreaterThan(0);
    expect(kit.openUrl).toMatch(/^https:\/\//);
    expect(kit.steps.length).toBeGreaterThanOrEqual(2);
    expect(kit.all).not.toMatch(/undefined|null/);
  });

  it('builds a pre-filled Hacker News submit link, encoded', () => {
    const kit = buildManualKit('hackernews', payload({ title: 'A & B: "quoted"' }), {}, SITE);
    expect(kit.submitUrl).toBe(`https://news.ycombinator.com/submitlink?u=${encodeURIComponent('https://example-blog.dev/posts/write-path')}&t=${encodeURIComponent('A & B: "quoted"')}`);
    expect(buildManualKit('hackernews', payload({ canonicalUrl: null }), {}, SITE).submitUrl).toBeNull();
  });

  it('builds a Reddit submit link for the chosen subreddit, as a self post when there is a body', () => {
    const withSub = buildManualKit('reddit', payload(), { options: { subreddit: 'r/programming' } }, SITE);
    expect(withSub.submitUrl).toMatch(/^https:\/\/www\.reddit\.com\/r\/programming\/submit\?type=self&title=/);
    expect(buildManualKit('reddit', payload({ bodyMarkdown: '' }), {}, SITE).submitUrl).toMatch(/^https:\/\/www\.reddit\.com\/submit\?type=link&title=.*&url=/);
    const huge = buildManualKit('reddit', payload({ bodyMarkdown: 'x'.repeat(5000) }), {}, SITE);
    expect(huge.submitUrl!.length).toBeLessThan(2000);
    expect(huge.submitNote).toMatch(/too long/);
  });

  it('builds the compose links for X, Bluesky, Threads, LinkedIn and Mastodon', () => {
    expect(buildManualKit('x', payload({ bodyMarkdown: 'Hello world' }), {}, SITE).submitUrl).toBe('https://x.com/intent/post?text=Hello%20world');
    expect(buildManualKit('bluesky', payload({ bodyMarkdown: 'Hello' }), {}, SITE).submitUrl).toBe('https://bsky.app/intent/compose?text=Hello');
    expect(buildManualKit('threads', payload({ bodyMarkdown: 'Hello' }), {}, SITE).submitUrl).toMatch(/^https:\/\/www\.threads\.com\/intent\/post\?text=Hello/);
    expect(buildManualKit('linkedin', payload(), {}, SITE).submitUrl).toBe(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent('https://example-blog.dev/posts/write-path')}`);
    expect(buildManualKit('mastodon', payload({ bodyMarkdown: 'Hi' }), { options: { instance: 'hachyderm.io' } }, SITE).submitUrl).toBe('https://hachyderm.io/share?text=Hi');
    expect(buildManualKit('mastodon', payload(), { options: { instance: 'not a host' } }, SITE).submitUrl).toBeNull();
  });

  it('pre-fills only the first post of a thread and says so', () => {
    const kit = buildManualKit('x', payload({ bodyMarkdown: 'One\n---\nTwo' }), {}, SITE);
    expect(kit.submitUrl).toBe('https://x.com/intent/post?text=One');
    expect(kit.submitNote).toMatch(/first post only/);
    expect(kit.parts.map((p) => p.label)).toEqual(['Post 1 of 2', 'Post 2 of 2']);
  });

  it('gives the personal site its finished file and a GitHub new-file link', () => {
    const kit = buildManualKit('site', payload(), {}, SITE);
    expect(kit.parts.map((p) => p.label)).toEqual(['File path', 'File (front matter and body)']);
    expect(kit.submitUrl).toBe('https://github.com/example-owner/example-site/new/main?filename=content%2Fposts%2Fwrite-path.md');
  });
});

describe('recording a post made by hand: the link is checked against the platform', () => {
  const ok = (platform: Parameters<typeof validateManualUrl>[0], url: string, ctx: ManualContext = SITE) => validateManualUrl(platform, url, ctx).ok;

  it('accepts a post link on that platform’s own host', () => {
    expect(ok('devto', 'https://dev.to/someone/why-the-write-path-stalls-1a2b')).toBe(true);
    expect(ok('hashnode', 'https://someone.hashnode.dev/why-the-write-path-stalls')).toBe(true);
    expect(ok('medium', 'https://medium.com/@someone/why-the-write-path-stalls-abc123')).toBe(true);
    expect(ok('medium', 'https://someone.medium.com/why-abc123')).toBe(true);
    expect(ok('substack', 'https://someone.substack.com/p/why')).toBe(true);
    expect(ok('linkedin', 'https://www.linkedin.com/posts/someone_why-activity-123')).toBe(true);
    expect(ok('x', 'https://x.com/someone/status/1234567890')).toBe(true);
    expect(ok('x', 'https://twitter.com/someone/status/1234567890')).toBe(true);
    expect(ok('bluesky', 'https://bsky.app/profile/someone.bsky.social/post/3kabc')).toBe(true);
    expect(ok('threads', 'https://www.threads.com/@someone/post/ABC')).toBe(true);
    expect(ok('reddit', 'https://www.reddit.com/r/programming/comments/abc/why/')).toBe(true);
    expect(ok('youtube', 'https://www.youtube.com/watch?v=abcdefghijk')).toBe(true);
    expect(ok('youtube', 'https://youtu.be/abcdefghijk')).toBe(true);
    expect(ok('hackernews', 'https://news.ycombinator.com/item?id=12345')).toBe(true);
  });

  it('refuses a link on another platform’s host, even a lookalike', () => {
    expect(ok('devto', 'https://dev.to.evil.example/x')).toBe(false);
    expect(ok('devto', 'https://notdev.to/x')).toBe(false);
    expect(ok('devto', 'https://medium.com/x')).toBe(false);
    expect(ok('x', 'https://x.com.attacker.test/someone/status/1')).toBe(false);
    expect(ok('hackernews', 'https://example-blog.dev/item?id=1')).toBe(false);
    expect(ok('linkedin', 'https://linkedin.com.example.test/posts/1')).toBe(false);
    expect(ok('hashnode', 'https://hashnode.dev/x')).toBe(true);
    expect(ok('hashnode', 'https://evilhashnode.dev/x')).toBe(false);
  });

  it('refuses addresses that are not plain public https', () => {
    for (const bad of ['http://dev.to/x', 'ftp://dev.to/x', 'javascript:alert(1)', 'dev.to/x', '', 'https://user:pass@dev.to/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://dev.to@evil.test/x']) {
      expect(ok('devto', bad), bad).toBe(false);
    }
  });

  it('checks a Hacker News link points at an item', () => {
    expect(ok('hackernews', 'https://news.ycombinator.com/')).toBe(false);
    expect(ok('hackernews', 'https://news.ycombinator.com/item?id=abc')).toBe(false);
  });

  it('checks a Mastodon link looks like a post, on any instance', () => {
    expect(ok('mastodon', 'https://hachyderm.io/@someone/112233445566')).toBe(true);
    expect(ok('mastodon', 'https://fosstodon.org/users/someone/statuses/112233')).toBe(true);
    expect(ok('mastodon', 'https://hachyderm.io/@someone')).toBe(false);
  });

  it('checks a personal-site link against the host the owner configured', () => {
    expect(ok('site', 'https://www.example-blog.dev/posts/write-path')).toBe(true);
    expect(ok('site', 'https://example-blog.dev/posts/write-path')).toBe(true);
    expect(ok('site', 'https://other.example.test/posts/write-path')).toBe(false);
    const none = validateManualUrl('site', 'https://example-blog.dev/x', { siteHost: null });
    expect(none).toMatchObject({ ok: false });
    expect((none as { reason: string }).reason).toMatch(/Integrations/);
  });

  it('says why in words the owner can act on', () => {
    const verdict = validateManualUrl('devto', 'https://medium.com/x');
    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toContain(PLATFORMS.devto.manual.hosts[0]);
  });
});
