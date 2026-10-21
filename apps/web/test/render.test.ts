import { describe, expect, it } from 'vitest';
import { noticeSummary, renderMarkdown } from '../src/lib/markdown/render';

const ASSET = '33333333-3333-4333-8333-333333333333';

const FULL = `# Title of the post

Intro with a footnote[^1] and ~~strike~~ plus https://example-blog.dev/auto.

## Tasks

- [x] write it
- [ ] ship it

| Name | Count |
|:-----|------:|
| a    | 1     |
| b    | 2     |

\`\`\`go
func main() {
	fmt.Println("hi")
}
\`\`\`

\`\`\`sql
select 1;
\`\`\`

\`\`\`mermaid
graph TD
  A --> B
\`\`\`

![diagram](asset:${ASSET})

[jump to tasks](#tasks)

[^1]: The note.
`;

describe('Markdown rendering', () => {
  it('keeps headings, tables, task lists, footnotes, code and mermaid fences, with nothing reported', async () => {
    const r = await renderMarkdown(FULL);
    expect(r.notices).toEqual([]);
    expect(noticeSummary(r)).toBeNull();
    expect(r.html).toContain('<h1 id="user-content-title-of-the-post">Title of the post');
    expect(r.html).toContain('<table>');
    expect(r.html).toMatch(/<th align="right">Count<\/th>|<th align="right"[^>]*>Count/);
    expect(r.html).toContain('class="md-table"');
    expect(r.html).toMatch(/<input type="checkbox" checked disabled/);
    expect(r.html).toMatch(/<input type="checkbox" disabled/);
    expect(r.html).toContain('data-footnote-ref');
    expect(r.html).toContain('id="user-content-fn-1"');
    expect(r.html).toContain('href="#user-content-fn-1"');
    expect(r.html).toContain('href="#user-content-tasks"');
    expect(r.html).toContain('<del>strike</del>');
    expect(r.html).toContain('href="https://example-blog.dev/auto"');
    expect(r.headings.map((h) => h.text)).toEqual(['Title of the post', 'Tasks']);
  });

  it('highlights fenced code by language and leaves the text intact', async () => {
    const r = await renderMarkdown(FULL);
    expect(r.html).toContain('class="hljs language-go"');
    expect(r.html).toContain('hljs-keyword');
    expect(r.html).toContain('fmt.Println');
    expect(r.html).toContain('class="hljs language-sql"');
  });

  it('turns mermaid fences into a placeholder block that still holds the source', async () => {
    const r = await renderMarkdown(FULL);
    expect(r.mermaidCount).toBe(1);
    expect(r.html).toContain('class="mermaid-block"');
    expect(r.html).toContain('data-mermaid');
    expect(r.html).toContain('language-mermaid');
    expect(r.html).toContain('A --> B');
    const block = r.html.slice(r.html.indexOf('class="mermaid-block"'));
    expect(block.slice(0, block.indexOf('</div>'))).not.toContain('hljs');
  });

  it('keeps unknown fence languages as plain code', async () => {
    const r = await renderMarkdown('```zzlang\nsome code\n```');
    expect(r.html).toContain('some code');
    expect(r.notices).toEqual([]);
  });

  it('resolves uploaded images through the asset route and reports them', async () => {
    const r = await renderMarkdown(FULL);
    expect(r.assetIds).toEqual([ASSET]);
    expect(r.html).toContain(`src="/api/assets/${ASSET}"`);
    expect(r.html).toContain('loading="lazy"');
    expect(r.html).toContain('referrerpolicy="no-referrer"');
    expect(r.html).not.toContain('asset:');
  });

  it('does not treat a made-up asset reference as an image', async () => {
    const r = await renderMarkdown('![x](asset:not-an-id)');
    expect(r.html).not.toContain('asset:');
    expect(r.removedCount).toBe(1);
  });

  it('removes script and iframe and says so', async () => {
    const r = await renderMarkdown('before\n\n<script>alert(1)</script>\n\n<iframe src="https://example.test/x"></iframe>\n\nafter');
    expect(r.html).not.toMatch(/<script|<iframe|alert\(1\)/);
    expect(r.html).toContain('before');
    expect(r.html).toContain('after');
    expect(r.removedCount).toBe(2);
    expect(r.notices.map((n) => n.key).sort()).toEqual(['element:iframe', 'element:script']);
    expect(noticeSummary(r)).toBe('2 items were not rendered');
  });

  it('removes javascript: links, event handlers and styles, and reports each', async () => {
    const md = [
      '[click](javascript:alert(1))',
      '<a href="JaVaScRiPt:alert(2)">two</a>',
      '<img src="https://example.test/a.png" onerror="alert(3)">',
      '<p style="position:fixed" onclick="x()">styled</p>',
      '![img](data:text/html;base64,PHNjcmlwdD4=)',
    ].join('\n\n');
    const r = await renderMarkdown(md);
    expect(r.html).not.toMatch(/javascript:/i);
    expect(r.html).not.toMatch(/onerror|onclick|style=/i);
    expect(r.html).not.toContain('data:text/html');
    expect(r.html).toContain('click');
    expect(r.html).toContain('styled');
    const labels = r.notices.map((n) => n.label).join(' | ');
    expect(labels).toContain('javascript:');
    expect(labels).toContain('onerror attribute on <img>');
    expect(labels).toContain('onclick attribute on <p>');
    expect(labels).toContain('style attribute on <p>');
    expect(labels).toContain('"data:"');
    expect(r.removedCount).toBeGreaterThanOrEqual(6);
  });

  it('reports unsupported MDX-style components instead of hiding them', async () => {
    const r = await renderMarkdown('<Callout type="note">Careful here</Callout>\n\nplain');
    expect(r.html).toContain('Careful here');
    expect(r.notices.map((n) => n.label)).toEqual(['<callout> element (not a supported tag)']);
  });

  it('adds rel attributes to external links and does not clobber document names', async () => {
    const r = await renderMarkdown('[out](https://example.test/p)\n\n<a id="cookie" name="forms">x</a>\n\n<h2 id="location">h</h2>');
    expect(r.html).toContain('rel="noopener noreferrer nofollow"');
    expect(r.html).toContain('id="user-content-cookie"');
    expect(r.html).toContain('id="user-content-location"');
    expect(r.html).not.toMatch(/\sid="(cookie|location)"/);
  });

  it('gives duplicate headings distinct anchors', async () => {
    const r = await renderMarkdown('## Setup\n\n## Setup\n');
    expect(r.headings.map((h) => h.id)).toEqual(['user-content-setup', 'user-content-setup-1']);
  });

  it('renders a long mixed document quickly', async () => {
    const big = Array.from({ length: 400 }, (_, i) => `## Section ${i}\n\nParagraph with \`code\` and a [link](https://example.test/${i}).\n\n\`\`\`ts\nconst n: number = ${i};\n\`\`\`\n`).join('\n');
    const started = performance.now();
    const r = await renderMarkdown(big);
    expect(r.headings).toHaveLength(400);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('survives a byte order mark and CRLF line endings', async () => {
    const r = await renderMarkdown('﻿# Hi\r\n\r\n- a\r\n- b\r\n');
    expect(r.html).toContain('<h1 id="user-content-hi">Hi');
    expect(r.html).toContain('<li>a</li>');
  });
});
