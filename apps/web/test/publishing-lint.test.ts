import { describe, expect, it } from 'vitest';
import { analyzeBody, hasErrors, isPrivateHost, judgeUrl, lintPayload } from '../src/server/publishing/lint';
import { canonicalJson, payloadHashOf, sourceHashOf } from '../src/server/publishing/source';
import { devtoTag, hashnodeSlug, sanitizeTags } from '../src/server/publishing/tags';

describe('which addresses other people can reach', () => {
  it.each([
    ['https://example-blog.dev/a.png', true],
    ['http://example-blog.dev/a.png', true],
    ['//example-blog.dev/a.png', true],
    ['#section', true],
    ['mailto:someone@example-blog.dev', true],
    ['asset:3c1f4f0e-0000-4000-8000-000000000000', false],
    ['/api/assets/3c1f4f0e', false],
    ['./images/a.png', false],
    ['../a.png', false],
    ['images/a.png', false],
    ['file:///c:/work/a.png', false],
    ['data:image/png;base64,AAAA', false],
    ['http://localhost:3100/x', false],
    ['http://127.0.0.1/x', false],
    ['http://192.168.1.20/x', false],
    ['http://10.0.0.5/x', false],
    ['http://172.20.1.1/x', false],
    ['http://[::1]/x', false],
    ['http://my-nas/x', false],
    ['https://printer.local/x', false],
    ['ftp://example-blog.dev/x', false],
  ])('%s is reachable: %s', (url, reachable) => {
    expect(judgeUrl(url).reachable).toBe(reachable);
  });

  it('knows private hosts', () => {
    expect(isPrivateHost('172.15.0.1')).toBe(false);
    expect(isPrivateHost('172.16.0.1')).toBe(true);
    expect(isPrivateHost('example-blog.dev')).toBe(false);
  });
});

describe('scanning a body', () => {
  it('ignores code blocks and inline code', () => {
    const found = analyzeBody('```md\n![x](asset:abc)\n[y](./local)\n```\n\nUse `![z](./nope.png)` like this.');
    expect(found.localImages).toEqual([]);
    expect(found.badLinks).toEqual([]);
  });

  it('finds images, links, reference links and HTML images', () => {
    const found = analyzeBody(
      ['![a](asset:one)', '![b](https://example-blog.dev/b.png "title")', '[c](./relative)', '[d][ref]', '<img src="./img/e.png" alt="e">', '', '[ref]: http://localhost:8080/ref'].join('\n'),
    );
    expect(found.localImages).toEqual(['asset:one', './img/e.png']);
    expect(found.badLinks).toEqual(['./relative', 'http://localhost:8080/ref']);
  });

  it('treats an image wrapped in a link as an image plus a link', () => {
    const found = analyzeBody('[![logo](./logo.png)](https://example-blog.dev/)');
    expect(found.localImages).toEqual(['./logo.png']);
    expect(found.badLinks).toEqual([]);
  });

  it('notes insecure images, unsupported HTML, mermaid and template-like text', () => {
    const found = analyzeBody('![a](http://example-blog.dev/a.png)\n\n<script>x</script><iframe src="y"></iframe>\n\n```mermaid\ngraph TD;\n```\n\n{{ value }}');
    expect(found.insecureImages).toEqual(['http://example-blog.dev/a.png']);
    expect(found.unsupportedHtml).toEqual(['<script>', '<iframe>']);
    expect(found.hasMermaid).toBe(true);
    expect(found.liquidLike).toEqual(['{{ value }}']);
  });
});

describe('payload lint', () => {
  const base = { title: 'T', description: '', tags: [], canonicalUrl: 'https://example-blog.dev/p', coverImageUrl: null, series: null, bodyMarkdown: 'Text.' };
  const options = { hasLocalCover: false, maxBodyChars: 100, platformName: 'Somewhere' };

  it('is clean for a good post', () => {
    expect(lintPayload(base, options)).toEqual([]);
  });

  it('orders nothing out of the data: errors block, warnings do not', () => {
    const issues = lintPayload({ ...base, title: '', canonicalUrl: null }, options);
    expect(hasErrors(issues)).toBe(true);
    expect(hasErrors(lintPayload({ ...base, canonicalUrl: null }, options))).toBe(false);
  });

  it('refuses a body over the limit, and a cover that is not public https', () => {
    expect(lintPayload({ ...base, bodyMarkdown: 'x'.repeat(101) }, options).map((i) => i.code)).toContain('body_too_long');
    expect(lintPayload({ ...base, coverImageUrl: './cover.png' }, options).map((i) => i.code)).toContain('cover_not_public');
    expect(lintPayload({ ...base, coverImageUrl: 'https://example-blog.dev/c.png' }, options)).toEqual([]);
  });

  it('warns when the cover only exists in the app', () => {
    expect(lintPayload(base, { ...options, hasLocalCover: true }).find((i) => i.code === 'cover_local_only')?.severity).toBe('warning');
  });
});

describe('tags', () => {
  it('cleans to the form each platform takes', () => {
    expect(devtoTag('Node.js', 30)).toBe('nodejs');
    expect(devtoTag('Café', 30)).toBe('cafe');
    expect(devtoTag('machine-learning', 30)).toBe('machinelearning');
    expect(devtoTag('a'.repeat(40), 30)).toHaveLength(30);
    expect(hashnodeSlug('Distributed Systems!', 50)).toBe('distributed-systems');
    expect(hashnodeSlug('---', 50)).toBe('');
  });

  it('reports what it dropped or changed', () => {
    const report = sanitizeTags(['Go', ' ', '???', 'go'], (t) => devtoTag(t, 30));
    expect(report.sent).toEqual(['go']);
    expect(report.changes).toHaveLength(3);
  });
});

describe('hashes', () => {
  it('are stable across key order and sensitive to every part', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
    const payload = { title: 'T', description: '', tags: ['a'], canonicalUrl: null, coverImageUrl: null, series: null, bodyMarkdown: 'x' };
    const one = payloadHashOf('devto', '@me', payload);
    expect(payloadHashOf('devto', '@me', { ...payload })).toBe(one);
    expect(payloadHashOf('hashnode', '@me', payload)).not.toBe(one);
    expect(payloadHashOf('devto', '@you', payload)).not.toBe(one);
    expect(payloadHashOf('devto', '@me', { ...payload, bodyMarkdown: 'y' })).not.toBe(one);
  });

  it('a source hash changes with any field the draft is built from', () => {
    const article = { title: 'T', slug: 's', description: '', tags: ['a'], canonicalUrl: null, coverAssetId: null, bodyMarkdown: 'x' };
    const base = sourceHashOf(article);
    for (const change of [{ title: 'U' }, { slug: 't' }, { description: 'd' }, { tags: ['b'] }, { canonicalUrl: 'https://example-blog.dev' }, { coverAssetId: 'id' }, { bodyMarkdown: 'y' }]) {
      expect(sourceHashOf({ ...article, ...change })).not.toBe(base);
    }
  });
});
