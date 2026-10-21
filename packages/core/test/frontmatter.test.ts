import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parsePost, PostParseError } from '../src/frontmatter.js';

const fixture = (name: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
const sample = fixture('sample-post.mdx').toString('utf8');
const crlfBom = fixture('crlf-bom-post.mdx').toString('utf8');

const withFrontmatter = (lines: string[]): string => `---\n${lines.join('\n')}\n---\n\nBody.\n`;
const validLines = [
  'title: "T"',
  'date: "2026-07-19"',
  'category: "engineering"',
  'tags: ["a"]',
  'description: "D"',
  'published: true',
  'coverImage: "/images/blogs-covers/x.svg"',
];
const without = (key: string): string[] => validLines.filter((l) => !l.startsWith(`${key}:`));
const replacing = (key: string, line: string): string[] =>
  validLines.map((l) => (l.startsWith(`${key}:`) ? line : l));

const expectParseError = (raw: string): PostParseError => {
  try {
    parsePost(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(PostParseError);
    return error as PostParseError;
  }
  throw new Error('parsePost did not throw');
};

describe('fixtures', () => {
  it('crlf-bom-post.mdx keeps its BOM and CRLF bytes (guards against git eol conversion)', () => {
    const bytes = fixture('crlf-bom-post.mdx');
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.includes(Buffer.from('\r\n'))).toBe(true);
    expect(fixture('sample-post.mdx').includes(Buffer.from('\r'))).toBe(false);
  });
});

describe('parsePost', () => {
  it('parses the sample post', () => {
    const { frontmatter, body } = parsePost(sample);
    expect(frontmatter.tags).toHaveLength(6);
    expect(frontmatter.published).toBe(true);
    expect(frontmatter.date).toBe('2026-07-19');
    expect(frontmatter).toMatchObject({
      title: 'How High Cardinality Hurts Prometheus',
      category: 'engineering',
      coverImage: '/images/blogs-covers/prometheus-cardinality.svg',
    });
    expect(body).toContain("import Callout from '@/components/Callout';");
    expect(body).toContain('<PacketJourney name="x" />');
    expect(body).not.toContain('title:');
  });

  it('gives identical results for a CRLF file with a BOM', () => {
    expect(parsePost(crlfBom)).toEqual(parsePost(sample));
    expect(parsePost(crlfBom).body).not.toContain('\r');
  });

  it('keeps an ISO date string when the YAML date is unquoted', () => {
    const raw = withFrontmatter(replacing('date', 'date: 2026-07-19'));
    expect(parsePost(raw).frontmatter.date).toBe('2026-07-19');
  });

  it('throws PostParseError with field "title" when title is missing', () => {
    const error = expectParseError(withFrontmatter(without('title')));
    expect(error.field).toBe('title');
    expect(error.reason).toEqual(expect.any(String));
    expect(error.message).toContain('title');
  });

  it('rejects an empty title', () => {
    expect(expectParseError(withFrontmatter(replacing('title', 'title: ""'))).field).toBe('title');
  });

  it('rejects category "blog" (enum engineering|case-study|productivity|community)', () => {
    const error = expectParseError(withFrontmatter(replacing('category', 'category: "blog"')));
    expect(error.field).toBe('category');
  });

  it.each(['engineering', 'case-study', 'productivity', 'community'])('accepts category %s', (category) => {
    const raw = withFrontmatter(replacing('category', `category: "${category}"`));
    expect(parsePost(raw).frontmatter.category).toBe(category);
  });

  it('rejects a malformed date', () => {
    expect(expectParseError(withFrontmatter(replacing('date', 'date: "19/07/2026"'))).field).toBe('date');
  });

  it('rejects an impossible calendar date', () => {
    expect(expectParseError(withFrontmatter(replacing('date', 'date: "2026-02-31"'))).field).toBe('date');
  });

  it('rejects non-boolean published', () => {
    expect(expectParseError(withFrontmatter(replacing('published', 'published: "yes"'))).field).toBe(
      'published',
    );
  });

  it('names the offending tag index', () => {
    const error = expectParseError(withFrontmatter(replacing('tags', 'tags: ["a", 3]')));
    expect(error.field).toBe('tags.1');
  });

  it('reports a missing frontmatter block', () => {
    expect(expectParseError('# Just a heading\n').field).toBe('frontmatter');
  });

  it('refuses code frontmatter instead of evaluating it', () => {
    const raw = '---js\n({ title: "x" })\n---\n\nBody\n';
    expect(expectParseError(raw).field).toBe('frontmatter');
  });

  it('reports YAML syntax errors as a frontmatter error', () => {
    expect(expectParseError('---\ntitle: "unclosed\n---\n\nBody\n').field).toBe('frontmatter');
  });
});
