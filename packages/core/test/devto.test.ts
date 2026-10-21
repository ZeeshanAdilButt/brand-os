import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildContentItem } from '../src/content-item.js';
import { createDevtoTransform, devtoTransform, renderDevtoMarkdown, sanitizeDevtoTags } from '../src/transforms/devto.js';
import { transforms } from '../src/transforms/registry.js';
import type { ContentItem } from '../src/model.js';
import type { DevtoPayload } from '../src/transforms/devto.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

const BASE = 'https://www.example-blog.dev';
const SLUG = 'prometheus-cardinality-explained';
const CANONICAL = `${BASE}/blog/${SLUG}`;

const build = (mdxName = 'sample-post.mdx', notes: string | null = fixture('sample-notes.md')): ContentItem =>
  buildContentItem({
    slug: SLUG,
    mdxRaw: fixture(mdxName),
    ...(notes === null ? {} : { notesRaw: notes }),
    repoCommit: 'abc1234',
    dirty: false,
    baseUrl: BASE,
  });

const item = build();
const payload = devtoTransform.skeleton(item);
const rules = (p: DevtoPayload, i: ContentItem = item): string[] => devtoTransform.lint(p, i).map((r) => r.rule);

describe('buildContentItem', () => {
  it('composes the parsed post, notes, doc and URLs', () => {
    expect(item.slug).toBe(SLUG);
    expect(item.canonicalUrl).toBe(CANONICAL);
    expect(item.frontmatter.title).toBe('How High Cardinality Hurts Prometheus');
    expect(item.coverPngUrl).toBe(`${BASE}/images/blogs-covers/prometheus-cardinality.png`);
    expect(item.notes?.primaryTitle).toBe('How Queues Hide Latency, Starting From One Counter');
    expect(item.doc.nodes.length).toBeGreaterThan(0);
    expect(item.source).toMatchObject({ repoCommit: 'abc1234', dirty: false });
    expect(item.source.mdxSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(item.source.notesSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(item.canonicalLiveAt).toBeUndefined();
    expect(item.t0).toBeUndefined();
  });

  it('omits notes and the notes hash when no notes are given', () => {
    const bare = build('sample-post.mdx', null);
    expect(bare.notes).toBeUndefined();
    expect('notes' in bare).toBe(false);
    expect('notesSha256' in bare.source).toBe(false);
  });

  it('hashes CRLF and LF checkouts of the same file identically', () => {
    const lf = fixture('sample-post.mdx');
    const crlf = lf.replace(/\r?\n/g, '\r\n');
    const a = buildContentItem({ slug: SLUG, mdxRaw: lf, repoCommit: 'x', dirty: true, baseUrl: BASE });
    const b = buildContentItem({ slug: SLUG, mdxRaw: crlf, repoCommit: 'x', dirty: true, baseUrl: BASE });
    expect(a.source.mdxSha256).toBe(b.source.mdxSha256);
    expect(a.source.dirty).toBe(true);
  });

  it('changes the hash when the post changes', () => {
    const a = build();
    const b = buildContentItem({
      slug: SLUG,
      mdxRaw: fixture('sample-post.mdx') + '\nExtra.\n',
      repoCommit: 'abc1234',
      dirty: false,
      baseUrl: BASE,
    });
    expect(a.source.mdxSha256).not.toBe(b.source.mdxSha256);
  });
});

describe('devto skeleton', () => {
  it('is a dev.to article transform', () => {
    expect(devtoTransform.platform).toBe('devto');
    expect(devtoTransform.kind).toBe('article');
  });

  it('sets the canonical URL without UTM', () => {
    expect(payload.canonical_url).toBe(CANONICAL);
    expect(payload.canonical_url).not.toContain('utm_');
    expect(payload.body_markdown).not.toContain('utm_');
  });

  it('uses the cover PNG twin as main_image', () => {
    expect(payload.main_image).toBe(item.coverPngUrl);
    expect(payload.main_image.endsWith('.png')).toBe(true);
  });

  it('takes the first 4 frontmatter tags, all sanitized', () => {
    expect(payload.tags).toEqual(['prometheus', 'observability', 'tsdb', 'cardinality']);
    expect(payload.tags).toHaveLength(4);
    for (const tag of payload.tags) expect(tag).toMatch(/^[a-z0-9]+$/);
  });

  it('is never published', () => {
    expect(payload.published).toBe(false);
    const literal: false = payload.published;
    expect(literal).toBe(false);
  });

  it('uses the frontmatter title and the notes meta description', () => {
    expect(payload.title).toBe('How High Cardinality Hurts Prometheus');
    expect(payload.description).toBe(item.notes?.metaDescription);
  });

  it('falls back to the frontmatter description without notes', () => {
    const bare = build('sample-post.mdx', null);
    expect(devtoTransform.skeleton(bare).description).toBe(bare.frontmatter.description);
  });

  it('has no series when the post has none', () => {
    expect('series' in payload).toBe(false);
  });

  it('honours a configured tag preference', () => {
    const t = createDevtoTransform({ tagPreference: ['sre', 'kubernetes', 'prometheus'] });
    expect(t.skeleton(item).tags).toEqual(['sre', 'kubernetes', 'prometheus', 'observability']);
  });
});

describe('devto markdown', () => {
  const md = payload.body_markdown;

  it('strips imports and renders no Callout tags', () => {
    expect(md).not.toMatch(/^import /m);
    expect(md).not.toContain('<Callout');
    expect(md).not.toContain('</Callout');
  });

  it('renders the alert callout as a Big Word Alert blockquote', () => {
    expect(md).toContain('> **Big Word Alert: time series**');
    expect(md).toContain('A time series is one metric name');
  });

  it('renders the note callout as a Note blockquote', () => {
    expect(md).toContain('> **Note:** ');
    expect(md).toContain('Other time series stores make different trade-offs');
  });

  it('renders the interactive node as a text block with no image', () => {
    const line = '> **Interactive diagram: x.** Open it on the original post: ' + CANONICAL + '#x';
    expect(md).toContain(line);
    const interactive = md.split('\n').filter((l) => l.includes('Interactive diagram'));
    expect(interactive.join('\n')).not.toContain('![');
  });

  it('keeps the table as GFM', () => {
    expect(md).toMatch(/^\| Label +\| Why it explodes +\| Where it belongs instead +\|$/m);
    expect(md).toMatch(/^\| -+ \| -+ \| -+ \|$/m);
  });

  it('keeps fenced code with its language', () => {
    expect(md).toContain('```promql\ncount by (__name__) ({__name__=~".+"})\n```');
  });

  it('keeps the SVG image on its absolute site URL', () => {
    expect(md).toContain(
      '![The head block and the blocks on disk](https://www.example-blog.dev/images/blogs/head-block.svg)',
    );
  });

  it('ends with the attribution footer', () => {
    const footer = `*Originally published at [example-blog.dev](${CANONICAL}).*`;
    expect(md.trimEnd().endsWith(footer)).toBe(true);
    expect(md.endsWith('\n')).toBe(true);
  });

  it('matches the snapshot', () => {
    expect(md).toMatchSnapshot();
  });

  it('is deterministic', () => {
    expect(renderDevtoMarkdown(item.doc, item)).toBe(md);
    expect(devtoTransform.skeleton(build()).body_markdown).toBe(md);
  });

  it('keeps lists, quotes and inline formatting', () => {
    const mdx = [
      '---',
      'title: "T"',
      'date: "2026-01-01"',
      'category: "engineering"',
      'tags: ["a"]',
      'description: "d"',
      'published: true',
      'coverImage: "/c.svg"',
      '---',
      '',
      'A **bold**, *emph*, `code` and [link](/x) here.',
      '',
      '1. one',
      '2. two',
      '',
      '- a',
      '- b',
      '',
      '> quoted',
      '',
    ].join('\n');
    const other = buildContentItem({ slug: 's', mdxRaw: mdx, repoCommit: 'x', dirty: false, baseUrl: BASE });
    const out = renderDevtoMarkdown(other.doc, other);
    expect(out).toContain('A **bold**, *emph*, `code` and [link](https://www.example-blog.dev/x) here.');
    expect(out).toContain('1. one\n2. two');
    expect(out).toContain('- a\n- b');
    expect(out).toContain('> quoted');
  });

  it('renders an ordered list that starts at 7 from 7, not from 1', () => {
    const mdx = ['---', 'title: "T"', 'date: "2026-01-01"', 'category: "engineering"', 'tags: ["a"]', 'description: "d"', 'published: true', 'coverImage: "/c.svg"', '---', '', 'Steps so far.', '', '7. seventh', '8. eighth', ''].join('\n');
    const other = buildContentItem({ slug: 's', mdxRaw: mdx, repoCommit: 'x', dirty: false, baseUrl: BASE });
    const out = renderDevtoMarkdown(other.doc, other);
    expect(out).toContain('7. seventh\n8. eighth');
    expect(out).not.toContain('1. seventh');
  });
});

describe('devto lint', () => {
  it('is clean on the skeleton of the fixture', () => {
    expect(devtoTransform.lint(payload, item)).toEqual([]);
  });

  it('errors on an image equal to main_image', () => {
    const bad: DevtoPayload = {
      ...payload,
      body_markdown: `${payload.body_markdown}\n![cover](${payload.main_image})\n`,
    };
    const results = devtoTransform.lint(bad, item);
    expect(results.find((r) => r.rule === 'placeholder-image')?.severity).toBe('error');
  });

  it('errors on an image from the placeholderUrls list', () => {
    const t = createDevtoTransform({ placeholderUrls: ['https://cdn.example.com/placeholder.png'] });
    const bad: DevtoPayload = {
      ...payload,
      body_markdown: `${payload.body_markdown}\n![x](https://cdn.example.com/placeholder.png)\n`,
    };
    expect(t.lint(bad, item).map((r) => r.rule)).toContain('placeholder-image');
    expect(devtoTransform.lint(bad, item).map((r) => r.rule)).not.toContain('placeholder-image');
  });

  it('errors on HTML img tags that use a placeholder URL', () => {
    const bad: DevtoPayload = {
      ...payload,
      body_markdown: `${payload.body_markdown}\n<img src="${payload.main_image}" alt="c">\n`,
    };
    expect(rules(bad)).toContain('placeholder-image');
  });

  it('errors on an unsupported node, including nested ones', () => {
    const bad = build('unknown-jsx.mdx');
    const results = devtoTransform.lint(devtoTransform.skeleton(bad), bad);
    const hit = results.find((r) => r.rule === 'unsupported-node');
    expect(hit?.severity).toBe('error');
    expect(hit?.message).toContain('FancyThing');

    const nested: ContentItem = {
      ...item,
      doc: {
        plainText: '',
        nodes: [
          {
            type: 'callout',
            kind: 'note',
            children: [{ type: 'blockquote', children: [{ type: 'unsupported', component: 'Foo', line: 3 }] }],
          },
        ],
      },
    };
    const nestedHit = devtoTransform.lint(payload, nested).find((r) => r.rule === 'unsupported-node');
    expect(nestedHit?.message).toContain('Foo');
  });

  it('errors on 5 tags', () => {
    const results = devtoTransform.lint({ ...payload, tags: ['a', 'b', 'c', 'd', 'e'] }, item);
    expect(results.find((r) => r.rule === 'devto-tags')?.severity).toBe('error');
  });

  it('errors on tags that are not lowercase alphanumeric', () => {
    expect(rules({ ...payload, tags: ['Node.js'] })).toContain('devto-tags');
  });

  it('errors when the canonical URL is wrong or carries UTM', () => {
    expect(rules({ ...payload, canonical_url: `${CANONICAL}?utm_source=devto` })).toContain('canonical-url');
    expect(rules({ ...payload, canonical_url: 'https://example.com/blog/x' })).toContain('canonical-url');
  });

  it('errors when the attribution footer is missing', () => {
    expect(rules({ ...payload, body_markdown: 'Just text.\n' })).toContain('devto-footer');
  });

  it('errors when the title, description or cover is rewritten', () => {
    expect(rules({ ...payload, title: 'Cut latency by 87% in 2025' })).toContain('devto-title');
    expect(rules({ ...payload, description: 'We saved $4,000,000' })).toContain('devto-description');
    expect(rules({ ...payload, main_image: 'https://evil.example/x.png' })).toContain('devto-main-image');
    const all = devtoTransform.lint(
      { ...payload, title: 'Cut latency by 87% in 2025', description: 'We saved $4,000,000', main_image: 'https://evil.example/x.png' },
      item,
    );
    for (const rule of ['devto-title', 'devto-description', 'devto-main-image']) {
      expect(all.find((r) => r.rule === rule)?.severity, rule).toBe('error');
    }
  });

  it('accepts the notes primary title or the frontmatter title, and either description', () => {
    expect(item.notes?.primaryTitle).toBeDefined();
    expect(rules({ ...payload, title: item.notes?.primaryTitle as string })).not.toContain('devto-title');
    expect(rules({ ...payload, title: item.frontmatter.title })).not.toContain('devto-title');
    expect(rules({ ...payload, description: item.frontmatter.description })).not.toContain('devto-description');
    expect(rules({ ...payload, description: item.notes?.metaDescription as string })).not.toContain('devto-description');
  });

  it('errors when body_markdown is not the post as rendered now', () => {
    expect(rules({ ...payload, body_markdown: `${payload.body_markdown}\nAn extra line.\n` })).toContain('devto-body');
    expect(rules(payload)).not.toContain('devto-body');
  });

  it('errors on an empty title or a missing main image', () => {
    expect(rules({ ...payload, title: ' ' })).toContain('devto-title');
    expect(rules({ ...payload, main_image: '' })).toContain('devto-main-image');
  });
});

describe('sanitizeDevtoTags', () => {
  it('lowercases, strips non-alphanumerics, dedupes and caps at 4', () => {
    expect(sanitizeDevtoTags(['Node.js', 'node js', 'C++', 'Go-Lang', 'a_b', 'Five', 'Six'])).toEqual([
      'nodejs',
      'c',
      'golang',
      'ab',
    ]);
  });

  it('drops tags that sanitize to nothing', () => {
    expect(sanitizeDevtoTags(['++', 'x', '  '])).toEqual(['x']);
  });

  it('orders by preference, then falls back to frontmatter order', () => {
    expect(sanitizeDevtoTags(['a', 'b', 'c', 'd', 'e', 'f'], ['E', 'c', 'zzz'])).toEqual(['e', 'c', 'a', 'b']);
  });

  it('ignores an empty preference list', () => {
    expect(sanitizeDevtoTags(['a', 'b', 'c', 'd', 'e'], [])).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('registry', () => {
  it('registers the dev.to transform', () => {
    expect(transforms.devto).toBe(devtoTransform);
    expect(transforms.devto?.platform).toBe('devto');
  });
});
