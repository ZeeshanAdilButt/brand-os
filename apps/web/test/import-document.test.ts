import { describe, expect, it } from 'vitest';
import { decodeText, DocumentError, MAX_IMPORT_BYTES, parseMarkdownDocument, titleFromFilename } from '../src/server/import/document';

describe('front matter', () => {
  it('reads title, description, tags, canonical, date and cover; keeps the rest as metadata', () => {
    const doc = parseMarkdownDocument(
      [
        '---',
        'title: "Why queues back up"',
        'description: Notes on queue depth.',
        'tags: [queues, "latency", Queues]',
        'canonical: https://example-blog.dev/queues',
        'date: 2026-03-04',
        'cover: /images/queues.png',
        'series: Operations',
        'draft: true',
        '---',
        '',
        'Body text.',
      ].join('\n'),
      'queues.md',
    );
    expect(doc.title).toBe('Why queues back up');
    expect(doc.description).toBe('Notes on queue depth.');
    expect(doc.tags).toEqual(['queues', 'latency']);
    expect(doc.canonicalUrl).toBe('https://example-blog.dev/queues');
    expect(doc.extraMetadata).toMatchObject({ date: '2026-03-04', cover: '/images/queues.png', series: 'Operations', draft: true });
    expect(doc.body).toBe('Body text.\n');
    expect(doc.warnings.join(' ')).toContain('cover image');
  });

  it('accepts alternative key names and comma separated tags', () => {
    const doc = parseMarkdownDocument('---\nTitle: Hello\nsummary: S\nkeywords: a, b , c\nCanonical_URL: https://example-blog.dev/x\npublished: 2026-01-01\n---\ntext', 'x.md');
    expect(doc).toMatchObject({ title: 'Hello', description: 'S', tags: ['a', 'b', 'c'], canonicalUrl: 'https://example-blog.dev/x' });
    expect(doc.extraMetadata.date).toBe('2026-01-01');
  });

  it('keeps a canonical value that is not a web address as metadata and says so', () => {
    const doc = parseMarkdownDocument('---\ntitle: T\ncanonical: javascript:alert(1)\n---\nx', 't.md');
    expect(doc.canonicalUrl).toBeNull();
    expect(doc.extraMetadata.canonical).toBe('javascript:alert(1)');
    expect(doc.warnings.some((w) => w.includes('not a web address'))).toBe(true);
  });

  it('keeps unreadable front matter in the body instead of dropping it', () => {
    const doc = parseMarkdownDocument('---\ntitle: [unclosed\n---\nBody', 'broken.md');
    expect(doc.body).toContain('title: [unclosed');
    expect(doc.warnings.join(' ')).toMatch(/front matter/);
    expect(doc.title).toBe('Broken');
  });

  it('handles a file with no front matter and uses the first heading as the title', () => {
    const doc = parseMarkdownDocument('# My heading\n\nFirst paragraph.\n\n## Next\n', 'notes.md');
    expect(doc.title).toBe('My heading');
    expect(doc.body).toBe('First paragraph.\n\n## Next\n');
    expect(doc.notes.join(' ')).toContain('first heading');
  });

  it('does not take a heading inside a code fence, or a later heading, as the title', () => {
    const doc = parseMarkdownDocument('Intro text\n\n# Later heading\n\n```sh\n# comment\n```\n', 'my_file-name.md');
    expect(doc.title).toBe('My file name');
    expect(doc.body).toContain('# Later heading');
    expect(doc.body).toContain('# comment');
  });

  it('copes with CRLF line endings and a byte order mark', () => {
    const doc = parseMarkdownDocument('﻿---\r\ntitle: Windows file\r\ntags:\r\n  - one\r\n  - two\r\n---\r\n\r\nLine one\r\nLine two\r\n', 'w.md');
    expect(doc.title).toBe('Windows file');
    expect(doc.tags).toEqual(['one', 'two']);
    expect(doc.body).toBe('Line one\nLine two\n');
    expect(doc.body).not.toContain('\r');
  });

  it('does not treat a horizontal rule at the top as front matter', () => {
    const doc = parseMarkdownDocument('---\n\nJust a rule above.\n', 'rule.md');
    expect(doc.body).toContain('Just a rule above.');
    expect(doc.title).toBe('Rule');
  });
});

describe('MDX', () => {
  const mdx = [
    '---',
    'title: With components',
    '---',
    "import { Chart } from '../components/chart'",
    'export const meta = { a: 1 }',
    '',
    'Intro.',
    '',
    '<Chart data={rows} />',
    '',
    '<Callout type="note">Heads up</Callout>',
    '',
    '```jsx',
    '<NotCounted />',
    '```',
    '',
    'Inline `<AlsoNotCounted>` in prose.',
  ].join('\n');

  it('keeps imports and components as literal text and warns once with the counts', () => {
    const doc = parseMarkdownDocument(mdx, 'post.mdx');
    expect(doc.body).toContain("import { Chart } from '../components/chart'");
    expect(doc.body).toContain('<Chart data={rows} />');
    expect(doc.body).toContain('<NotCounted />');
    const warning = doc.warnings.find((w) => w.includes('MDX'));
    expect(warning).toBeTruthy();
    expect(warning).toContain('1 import statement');
    expect(warning).toContain('1 export statement');
    expect(warning).toContain('2 components');
    expect(warning).toContain('<Chart>');
    expect(warning).toContain('<Callout>');
    expect(warning).not.toContain('NotCounted');
  });

  it('does not warn for plain Markdown', () => {
    expect(parseMarkdownDocument('# Hi\n\nJust text with <b>html</b> and a < b > c.\n', 'p.md').warnings).toEqual([]);
  });
});

describe('reading file bytes', () => {
  it('decodes UTF-8 and refuses binary or non-UTF-8 content', () => {
    expect(decodeText(new TextEncoder().encode('héllo'))).toBe('héllo');
    expect(() => decodeText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]))).toThrow(DocumentError);
    expect(() => decodeText(new Uint8Array([0xff, 0xfe, 0x41]))).toThrow(DocumentError);
    expect(() => decodeText(new Uint8Array(MAX_IMPORT_BYTES + 1).fill(65))).toThrow(DocumentError);
  });

  it('makes a readable title from a file name', () => {
    expect(titleFromFilename('docs/getting-started_guide.mdx')).toBe('Getting started guide');
    expect(titleFromFilename('')).toBe('Untitled');
  });
});
