import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildContentItem } from '../src/content-item.js';
import { createLinkedinTransform, linkedinTransform } from '../src/transforms/linkedin.js';
import { transforms } from '../src/transforms/registry.js';
import { withUtm } from '../src/urls.js';
import type { ContentItem } from '../src/model.js';
import type { LinkedinPayload } from '../src/transforms/linkedin.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

const BASE = 'https://www.example-blog.dev';
const SLUG = 'prometheus-cardinality-explained';
const CANONICAL = `${BASE}/blog/${SLUG}`;
const LINK = withUtm(CANONICAL, 'linkedin', SLUG);

const build = (notes: string | null = fixture('sample-notes.md')): ContentItem =>
  buildContentItem({
    slug: SLUG,
    mdxRaw: fixture('sample-post.mdx'),
    ...(notes === null ? {} : { notesRaw: notes }),
    repoCommit: 'abc1234',
    dirty: false,
    baseUrl: BASE,
  });

const item = build();
const withCard = createLinkedinTransform({ linkCard: true });
const rules = (p: LinkedinPayload, i: ContentItem = item, t = withCard): string[] => t.lint(p, i).map((r) => r.rule);
const severityOf = (p: LinkedinPayload, rule: string, i: ContentItem = item, t = withCard): string | undefined =>
  t.lint(p, i).find((r) => r.rule === rule)?.severity;

/** A post body that passes every rule; every number in it is a single digit. */
const GOOD_BODY = [
  'Latency lives in queues, not in service time.',
  '',
  'The most useful idea is simple: measure the queue before you tune the service.',
  'Three graphs on one dashboard reduce to a single piece of arithmetic.',
  '',
  '- Read one counter, the number of requests waiting.',
  '- Divide it by the arrival rate to get the wait time.',
  '- Watch the tail, because the mean hides the queue.',
  '',
  'Once you can read that one counter, a slow endpoint stops being a mystery and becomes a queue you can see, name and shrink.',
  'That is the whole takeaway, and everything else in the article is the arithmetic that backs it up.',
  '',
  'Full walkthrough with the graphs:',
].join('\n');
const good = (body = GOOD_BODY): LinkedinPayload => ({ text: `${body}\n${LINK}` });

describe('linkedin skeleton', () => {
  it('uses the notes excerpt followed by the UTM link, plus a link card when enabled', () => {
    expect(withCard.platform).toBe('linkedin');
    expect(withCard.kind).toBe('post');
    const p = withCard.skeleton(item);
    expect(p.text).toBe(`${item.notes?.excerpt}\n\n${LINK}`);
    expect(p.link).toEqual({
      url: LINK,
      title: 'How Queues Hide Latency, Starting From One Counter',
      description: item.notes?.metaDescription,
      thumbnailUrl: item.coverPngUrl,
    });
  });

  it('carries the UTM params linkedin / social / slug', () => {
    const url = new URL(withCard.skeleton(item).link!.url);
    expect(url.searchParams.get('utm_source')).toBe('linkedin');
    expect(url.searchParams.get('utm_medium')).toBe('social');
    expect(url.searchParams.get('utm_campaign')).toBe(SLUG);
  });

  it('still produces a skeleton without a notes file, from the frontmatter', () => {
    const bare = build(null);
    const p = withCard.skeleton(bare);
    expect(p.text).toBe(`${bare.frontmatter.description}\n\n${LINK}`);
    expect(p.link?.title).toBe(bare.frontmatter.title);
    expect(p.link?.description).toBe(bare.frontmatter.description);
    expect(p.link?.thumbnailUrl).toBe(bare.coverPngUrl);
  });

  it('has no link key at all when linkCard is false (default)', () => {
    const p = linkedinTransform.skeleton(item);
    expect('link' in p).toBe(false);
    expect(Object.keys(p)).toEqual(['text']);
    expect(p.text).toBe(`${item.notes?.excerpt}\n\n${LINK}`);
    expect('link' in createLinkedinTransform({ linkCard: false }).skeleton(item)).toBe(false);
  });

  it('passes every rule except li-takeaway (deliberately too thin)', () => {
    for (const t of [withCard, linkedinTransform]) {
      for (const i of [item, build(null)]) {
        expect(rules(t.skeleton(i), i, t)).toEqual(['li-takeaway']);
      }
    }
  });

  it('is registered as the default (no link card) transform', () => {
    expect(transforms['linkedin']).toBe(linkedinTransform);
    expect(transforms['devto']).toBeDefined();
  });
});

describe('linkedin lint', () => {
  it('accepts a complete takeaway post', () => {
    expect(rules(good())).toEqual([]);
    expect(rules(good(), item, linkedinTransform)).toEqual([]);
  });

  describe('li-length', () => {
    it('errors over 3000 graphemes and allows exactly 3000', () => {
      const pad = (n: number): LinkedinPayload => ({ text: `${GOOD_BODY}\n${'a'.repeat(n)}\n${LINK}` });
      const base = pad(0).text.length;
      expect(rules(pad(3000 - base))).not.toContain('li-length');
      expect(rules(pad(3000 - base + 1))).toContain('li-length');
      expect(severityOf(pad(3000 - base + 1), 'li-length')).toBe('error');
    });

    it('counts graphemes, not UTF-16 units', () => {
      // 1500 family emoji are 1500 graphemes (far more code units), so the post stays under 3000.
      const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
      const p: LinkedinPayload = { text: `${GOOD_BODY}\n${family.repeat(1500)}\n${LINK}` };
      expect(rules(p)).not.toContain('li-length');
    });
  });

  describe('li-one-link', () => {
    it('errors with no link', () => {
      expect(severityOf({ text: GOOD_BODY }, 'li-one-link')).toBe('error');
    });
    it('errors with two links', () => {
      expect(severityOf({ text: `${GOOD_BODY}\n${LINK}\n${LINK}` }, 'li-one-link')).toBe('error');
      expect(severityOf({ text: `${GOOD_BODY}\n${LINK}\nhttps://example.com/x` }, 'li-one-link')).toBe('error');
    });
    it('errors when the link is not exactly the UTM canonical', () => {
      expect(severityOf({ text: `${GOOD_BODY}\n${CANONICAL}` }, 'li-one-link')).toBe('error');
      expect(severityOf({ text: `${GOOD_BODY}\nhttps://example.com/other` }, 'li-one-link')).toBe('error');
    });
    it('errors when link.url differs from the expected URL', () => {
      const p: LinkedinPayload = { ...good(), link: { url: CANONICAL, title: 't', description: 'd', thumbnailUrl: 'x' } };
      expect(severityOf(p, 'li-one-link')).toBe('error');
      const ok: LinkedinPayload = { ...good(), link: { url: LINK, title: 't', description: 'd', thumbnailUrl: 'x' } };
      expect(rules(ok)).toEqual([]);
    });
  });

  describe('li-link-card-disabled', () => {
    const card: LinkedinPayload = { ...good(), link: { url: LINK, title: 't', description: 'd', thumbnailUrl: 'x' } };
    it('errors when a link card is supplied while linkCard is off', () => {
      expect(rules(card, item, linkedinTransform)).toEqual(['li-link-card-disabled']);
      expect(severityOf(card, 'li-link-card-disabled', item, linkedinTransform)).toBe('error');
    });
    it('passes the same payload when linkCard is on', () => {
      expect(rules(card, item, withCard)).not.toContain('li-link-card-disabled');
      expect(rules(card, item, withCard)).toEqual([]);
    });
    it('does not fire for a payload without a link', () => {
      expect(rules(good(), item, linkedinTransform)).toEqual([]);
    });
  });

  describe('li-utm', () => {
    it('errors when the link has no UTM', () => {
      const p = { text: `${GOOD_BODY}\n${CANONICAL}` };
      expect(rules(p)).toContain('li-utm');
      expect(severityOf(p, 'li-utm')).toBe('error');
    });
    it('errors when the UTM source is wrong', () => {
      const wrong = withUtm(CANONICAL, 'x', SLUG);
      expect(rules({ text: `${GOOD_BODY}\n${wrong}` })).toContain('li-utm');
    });
    it('passes on the correct UTM link', () => {
      expect(rules(good())).not.toContain('li-utm');
    });
  });

  describe('li-takeaway', () => {
    it('errors with fewer than 3 non-link lines', () => {
      expect(severityOf(good('First real line of text.\nSecond real line of text.'), 'li-takeaway')).toBe('error');
    });
    it('errors under 400 graphemes even with 3 lines', () => {
      expect(severityOf(good('One.\nTwo.\nThree.'), 'li-takeaway')).toBe('error');
    });
    it('errors with 400+ graphemes on fewer than 3 lines', () => {
      expect(severityOf(good('word '.repeat(100).trim()), 'li-takeaway')).toBe('error');
    });
    it('the link line does not count as a line', () => {
      const body = `${'a'.repeat(200)}\n${'b'.repeat(200)}`;
      expect(rules(good(body))).toContain('li-takeaway');
      expect(rules(good(`${body}\n${'c'.repeat(10)}`))).not.toContain('li-takeaway');
    });
    it('passes with 3 lines and 400 graphemes', () => {
      expect(rules(good())).not.toContain('li-takeaway');
    });
  });

  describe('li-numbers', () => {
    it('errors on a figure that is in neither the article nor the notes', () => {
      const p = good(`${GOOD_BODY}\nWe cut latency by 73% on the fleet.`);
      const results = withCard.lint(p, item).filter((r) => r.rule === 'li-numbers');
      expect(results).toHaveLength(1);
      expect(results[0]?.severity).toBe('error');
      expect(results[0]?.message).toContain('73');
    });
    it('allows single digits', () => {
      expect(rules(good(`${GOOD_BODY}\nThree graphs, 5 points.`))).not.toContain('li-numbers');
    });
    it('allows numbers that appear in the notes (fact labels)', () => {
      // "31 series to 7" is only in the notes' fact labels.
      expect(item.doc.plainText).not.toMatch(/\b31\b/);
      expect(rules(good(`${GOOD_BODY}\nMeasured: 31 series to 7 after aggregation.`))).not.toContain('li-numbers');
    });
    it('allows numbers from the frontmatter title and description', () => {
      const i: ContentItem = { ...item, frontmatter: { ...item.frontmatter, title: 'Top 87 queues', description: 'About 65 things' } };
      expect(rules(good(`${GOOD_BODY}\nTop 87 queues, 65 things.`), i)).not.toContain('li-numbers');
    });
    it('allows numbers from other notes fields (ogText, verifyBeforePublishing)', () => {
      const notes = { ...item.notes!, ogText: 'Service time is 4242 ms.', verifyBeforePublishing: ['Check 9191 again'] };
      const i: ContentItem = { ...item, notes };
      const p = good(`${GOOD_BODY}\n4242 ms and 9191.`);
      expect(rules(p, i)).not.toContain('li-numbers');
      expect(rules(p)).toContain('li-numbers');
    });
    it('ignores digits inside the URL', () => {
      const i: ContentItem = { ...item, slug: 'post-2024-9999', canonicalUrl: `${BASE}/blog/post-2024-9999` };
      const link = withUtm(i.canonicalUrl, 'linkedin', i.slug);
      expect(rules({ text: `${GOOD_BODY}\n${link}` }, i)).not.toContain('li-numbers');
    });
    it('works without notes', () => {
      const bare = build(null);
      expect(rules(good(`${GOOD_BODY}\nSaves 8812 hours.`), bare)).toContain('li-numbers');
      expect(rules(good(), bare)).not.toContain('li-numbers');
    });
  });

  describe('li-hashtag-wall (warning)', () => {
    const tags = (n: number): string => Array.from({ length: n }, (_, k) => `#tag${String.fromCharCode(97 + k)}`).join(' ');
    it('warns on more than 5 hashtags, not on 5', () => {
      expect(rules(good(`${GOOD_BODY}\n${tags(5)}`))).not.toContain('li-hashtag-wall');
      const six = good(`${GOOD_BODY}\n${tags(6)}`);
      expect(rules(six)).toContain('li-hashtag-wall');
      expect(severityOf(six, 'li-hashtag-wall')).toBe('warning');
    });
    it('does not count a lone # or a # inside a word', () => {
      expect(rules(good(`${GOOD_BODY}\nSee # and a#b, c#d, e#f, g#h, i#j, k#l.`))).not.toContain('li-hashtag-wall');
    });
  });

  describe('li-emoji-wall (warning)', () => {
    it('warns on more than 3 emoji, not on 3', () => {
      expect(rules(good(`${GOOD_BODY}\n\u{1F680}\u{1F525}✨`))).not.toContain('li-emoji-wall');
      const four = good(`${GOOD_BODY}\n\u{1F680}\u{1F525}✨\u{1F4A1}`);
      expect(rules(four)).toContain('li-emoji-wall');
      expect(severityOf(four, 'li-emoji-wall')).toBe('warning');
    });
    it('counts a multi-codepoint emoji as one', () => {
      const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
      expect(rules(good(`${GOOD_BODY}\n${family} ${family} ${family}`))).not.toContain('li-emoji-wall');
      expect(rules(good(`${GOOD_BODY}\n${family} ${family} ${family} ${family}`))).toContain('li-emoji-wall');
    });
    it('does not count digits or plain symbols', () => {
      expect(rules(good(`${GOOD_BODY}\n1 2 3 4 5 # * -> ok`))).not.toContain('li-emoji-wall');
    });
  });
});
