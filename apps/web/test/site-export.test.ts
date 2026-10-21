import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  branchNameFor,
  formatDate,
  isSafeBranch,
  mdxHazards,
  parseRepo,
  presetMapping,
  renderSiteFile,
  resolvePathTemplate,
  SITE_PRESETS,
  slugForPath,
  validateRepoPath,
  type SiteContent,
} from '../src/lib/site-export';

const CONTENT: SiteContent = {
  title: 'Why the write path stalls',
  description: 'A short look at write stalls.',
  tags: ['go', 'databases'],
  canonicalUrl: 'https://example-blog.dev/posts/write-path',
  coverImageUrl: 'https://example-blog.dev/img/cover.png',
  series: null,
  bodyMarkdown: '# Intro\n\nThe write path stalls when the log fills.\n',
};
const DATE = '2026-10-21T09:30:15Z';

/** The front matter of a rendered file, parsed back. */
function frontMatterOf(file: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(file);
  expect(match, 'the file starts with front matter').not.toBeNull();
  return parse(match![1]!) as Record<string, unknown>;
}

describe('Markdown export presets', () => {
  it.each(SITE_PRESETS)('%s: front matter holds the post’s fields under the preset’s key names', (preset) => {
    const mapping = presetMapping(preset);
    const { content } = renderSiteFile(CONTENT, mapping, DATE, 'write-path');
    const data = frontMatterOf(content);
    expect(data[mapping.fields.title]).toBe('Why the write path stalls');
    expect(data[mapping.fields.description]).toBe('A short look at write stalls.');
    expect(data[mapping.fields.tags]).toEqual(['go', 'databases']);
    expect(data[mapping.fields.canonical]).toBe('https://example-blog.dev/posts/write-path');
    expect(data[mapping.fields.cover]).toBe('https://example-blog.dev/img/cover.png');
    expect(content.endsWith('The write path stalls when the log fills.\n')).toBe(true);
  });

  it('uses different key names and extras per preset', () => {
    const hugo = frontMatterOf(renderSiteFile(CONTENT, presetMapping('hugo'), DATE, 'write-path').content);
    expect(hugo).toMatchObject({ canonicalURL: 'https://example-blog.dev/posts/write-path', draft: false, slug: 'write-path' });
    const jekyll = frontMatterOf(renderSiteFile(CONTENT, presetMapping('jekyll'), DATE, 'write-path').content);
    expect(jekyll).toMatchObject({ layout: 'post', canonical_url: 'https://example-blog.dev/posts/write-path' });
    expect(jekyll).not.toHaveProperty('slug');
    expect(presetMapping('mdx').extension).toBe('mdx');
    expect(presetMapping('generic').fields.canonical).toBe('canonical_url');
  });

  it('writes the date in the chosen format, always in UTC', () => {
    expect(formatDate(DATE, 'date')).toBe('2026-10-21');
    expect(formatDate(DATE, 'iso')).toBe('2026-10-21T09:30:15Z');
    expect(formatDate(DATE, 'jekyll')).toBe('2026-10-21 09:30:15 +0000');
    // A local-evening time that is already the next day in UTC does not shift.
    expect(formatDate('2026-10-21T23:30:00-05:00', 'date')).toBe('2026-10-22');
    expect(formatDate('not a date', 'date')).toBe('not a date');
  });

  it('lets the owner rename keys, leave parts out and add fixed keys', () => {
    const mapping = presetMapping('generic');
    mapping.fields.title = 'headline';
    mapping.fields.tags = '';
    mapping.fields.cover = '';
    mapping.fixed = [{ key: 'layout', value: 'article' }, { key: 'toc', value: true }];
    const data = frontMatterOf(renderSiteFile(CONTENT, mapping, DATE, 'write-path').content);
    expect(data.headline).toBe('Why the write path stalls');
    expect(data).not.toHaveProperty('title');
    expect(data).not.toHaveProperty('tags');
    expect(data).not.toHaveProperty('cover_image');
    expect(data).toMatchObject({ layout: 'article', toc: true });
  });

  it('keeps special characters intact and parseable', () => {
    const tricky: SiteContent = {
      ...CONTENT,
      title: 'Colons: quotes "and" #hashes, plus: \'single\' & ampersands',
      description: 'Line one\nline two with a trailing colon:',
      tags: ['c++', 'a: b', '#sharp', 'émoji-😀'],
      series: 'Part: 1',
    };
    const mapping = presetMapping('generic');
    const data = frontMatterOf(renderSiteFile(tricky, mapping, DATE, 'tricky').content);
    expect(data.title).toBe(tricky.title);
    // A description is a single line in front matter.
    expect(data.description).toBe('Line one line two with a trailing colon:');
    expect(data.tags).toEqual(tricky.tags);
    expect(data.series).toBe('Part: 1');
  });

  it('omits empty parts instead of writing empty keys', () => {
    const data = frontMatterOf(renderSiteFile({ ...CONTENT, description: '', tags: [], canonicalUrl: null, coverImageUrl: null }, presetMapping('generic'), DATE, 'x').content);
    expect(Object.keys(data).sort()).toEqual(['date', 'slug', 'title']);
  });

  it('normalizes CRLF line endings to LF and ends with exactly one newline', () => {
    const windows: SiteContent = { ...CONTENT, bodyMarkdown: '# Intro\r\n\r\nLine one\r\nLine two\r\n\r\n\r\n' };
    const { content } = renderSiteFile(windows, presetMapping('generic'), DATE, 'x');
    expect(content).not.toContain('\r');
    expect(content.endsWith('Line one\nLine two\n')).toBe(true);
    expect(content.endsWith('\n\n')).toBe(false);
  });

  it('is deterministic: the same inputs give the same bytes', () => {
    const a = renderSiteFile(CONTENT, presetMapping('hugo'), DATE, 'write-path').content;
    const b = renderSiteFile({ ...CONTENT }, presetMapping('hugo'), DATE, 'write-path').content;
    expect(a).toBe(b);
  });
});

describe('where the file goes', () => {
  const vars = { slug: 'write-path', dateIso: DATE, extension: 'md' as const };

  it('fills the placeholders', () => {
    expect(resolvePathTemplate('content/posts/{slug}.md', vars)).toEqual({ ok: true, path: 'content/posts/write-path.md' });
    expect(resolvePathTemplate('_posts/{year}-{month}-{day}-{slug}.{ext}', vars)).toEqual({ ok: true, path: '_posts/2026-10-21-write-path.md' });
    expect(resolvePathTemplate('src/{slug}.{ext}', { ...vars, extension: 'mdx' })).toEqual({ ok: true, path: 'src/write-path.mdx' });
  });

  it.each([
    ['../outside/{slug}.md', 'leaves the repository'],
    ['/abs/{slug}.md', 'absolute'],
    ['content\\{slug}.md', 'backslash'],
    ['content//{slug}.md', 'double slash'],
    ['.git/hooks/{slug}.md', 'git folder'],
    ['content/{slug}.exe', 'wrong extension'],
    ['content/{slug}/', 'a folder'],
    ['content/{unknown}.md', 'unknown placeholder'],
    ['', 'empty'],
    ['content/a:b/{slug}.md', 'special characters'],
  ])('refuses %s (%s)', (template) => {
    expect(resolvePathTemplate(template, vars).ok).toBe(false);
  });

  it('checks a finished path the same way', () => {
    expect(validateRepoPath('content/posts/a.md').ok).toBe(true);
    expect(validateRepoPath('content/../etc/passwd.md').ok).toBe(false);
    expect(validateRepoPath('a'.repeat(400) + '.md').ok).toBe(false);
  });

  it('builds the working branch from the slug and the first 8 characters of the hash', () => {
    const hash = 'ABCDEF0123456789'.repeat(4).toLowerCase();
    expect(branchNameFor('Write Path!', hash)).toBe('brand-os/write-path-abcdef01');
    expect(branchNameFor('', hash)).toBe('brand-os/post-abcdef01');
    expect(isSafeBranch(branchNameFor('x', hash))).toBe(true);
  });

  it('knows a safe branch name and a repository name', () => {
    for (const bad of ['', 'a b', '-x', 'x..y', 'x//y', 'x.lock', 'x/', '/x', 'x@{1}', 'a~b']) expect(isSafeBranch(bad), bad).toBe(false);
    for (const good of ['main', 'release/1.2', 'brand-os/x-1234abcd']) expect(isSafeBranch(good), good).toBe(true);
    expect(parseRepo('example-owner/example-site')).toEqual({ owner: 'example-owner', name: 'example-site' });
    for (const bad of ['', 'one', 'a/b/c', 'a/..', 'a/b.git', '-a/b', 'a b/c']) expect(parseRepo(bad), bad).toBeNull();
    expect(slugForPath('Héllo, World!')).toBe('hello-world');
  });

  it('warns about MDX hazards outside code only', () => {
    expect(mdxHazards('Plain text.\n\n```js\nconst a = { b: 1 };\n<div></div>\n```\n')).toEqual([]);
    expect(mdxHazards('Use {curly} braces.').length).toBe(1);
    expect(mdxHazards('A <Widget prop="x" /> here').length).toBe(1);
    expect(mdxHazards('<!-- note -->').length).toBeGreaterThan(0);
  });
});
