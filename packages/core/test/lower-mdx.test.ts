import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parsePost } from '../src/frontmatter.js';
import { lowerMdx } from '../src/lower-mdx.js';
import type { PNode } from '../src/portable-doc.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

const opts = {
  baseUrl: 'https://www.example-blog.dev',
  canonicalUrl: 'https://www.example-blog.dev/blog/prometheus-cardinality-explained',
};

const lowerFixture = (name: string) => lowerMdx(parsePost(fixture(name)).body, opts);

function ofType<T extends PNode['type']>(nodes: PNode[], type: T): Extract<PNode, { type: T }>[] {
  return nodes.filter((node): node is Extract<PNode, { type: T }> => node.type === type);
}

describe('lowerMdx on sample-post.mdx', () => {
  const doc = lowerFixture('sample-post.mdx');

  it('drops import/export ESM nodes', () => {
    const json = JSON.stringify(doc.nodes);
    expect(json).not.toContain('mdxjsEsm');
    expect(json).not.toContain('import Callout');
    expect(doc.plainText).not.toContain('import Callout');
  });

  it('keeps exactly one alert callout with a Big Word Alert title', () => {
    const alerts = ofType(doc.nodes, 'callout').filter((c) => c.kind === 'alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.title?.startsWith('Big Word Alert')).toBe(true);
    expect(alerts[0]?.children[0]).toMatchObject({ type: 'paragraph' });
  });

  it('maps the note callout', () => {
    const notes = ofType(doc.nodes, 'callout').filter((c) => c.kind === 'note');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.title).toBe('Aside: this is Prometheus specifically');
  });

  it('lowers the GFM table to a header and rows of cell text', () => {
    const tables = ofType(doc.nodes, 'table');
    expect(tables).toHaveLength(1);
    expect(tables[0]?.header).toEqual(['Label', 'Why it explodes', 'Where it belongs instead']);
    expect(tables[0]?.rows).toHaveLength(2);
    expect(tables[0]?.rows[0]).toEqual([
      'Pod name on an autoscaling fleet',
      'Unique forever, replaced constantly',
      'Logs, with the Pod name in the line',
    ]);
  });

  it('absolutizes the site-relative SVG image and flags it', () => {
    const images = ofType(doc.nodes, 'image');
    expect(images).toHaveLength(1);
    expect(images[0]?.src.startsWith('https://www.example-blog.dev/')).toBe(true);
    expect(images[0]?.src).toBe('https://www.example-blog.dev/images/blogs/head-block.svg');
    expect(images[0]?.svg).toBe(true);
    expect(images[0]?.alt).toBe('The head block and the blocks on disk');
  });

  it('keeps the code language and value', () => {
    const code = ofType(doc.nodes, 'code');
    expect(code).toHaveLength(1);
    expect(code[0]?.lang).toBe('promql');
    expect(code[0]?.value).toBe('count by (__name__) ({__name__=~".+"})');
  });

  it('turns PacketJourney into an interactive node with an anchor', () => {
    const interactive = ofType(doc.nodes, 'interactive');
    expect(interactive).toEqual([{ type: 'interactive', component: 'PacketJourney', name: 'x', anchor: '#x' }]);
  });

  it('keeps headings with their depth', () => {
    const headings = ofType(doc.nodes, 'heading');
    expect(headings.map((h) => h.depth)).toEqual([2, 2]);
  });

  it('has no unsupported nodes', () => {
    expect(ofType(doc.nodes, 'unsupported')).toEqual([]);
  });

  it('plainText contains the table cell text and the callout text', () => {
    expect(doc.plainText).toContain('Pod name on an autoscaling fleet');
    expect(doc.plainText).toContain('Traces or logs');
    expect(doc.plainText).toContain('Label');
    expect(doc.plainText).toContain('A time series is one metric name plus one exact set of label values');
    expect(doc.plainText).toContain('series count is the cost driver everywhere');
    expect(doc.plainText).toContain('Big Word Alert: time series');
  });

  it('carries no mdast position data', () => {
    expect(JSON.stringify(doc.nodes)).not.toContain('"position"');
  });

  it('gives the same doc for the BOM + CRLF twin', () => {
    expect(lowerFixture('crlf-bom-post.mdx')).toEqual(doc);
  });
});

describe('lowerMdx on unknown components', () => {
  it('reports <FancyThing/> as one unsupported node with a line number', () => {
    const body = parsePost(fixture('unknown-jsx.mdx')).body;
    const doc = lowerMdx(body, opts);
    const unsupported = ofType(doc.nodes, 'unsupported');
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]?.component).toBe('FancyThing');
    const expectedLine = body.split('\n').findIndex((l) => l.includes('<FancyThing/>')) + 1;
    expect(unsupported[0]?.line).toBe(expectedLine);
    expect(doc.nodes.map((n) => n.type)).toEqual(['paragraph', 'unsupported', 'paragraph']);
  });
});

describe('lowerMdx details', () => {
  it('maps aside to kind aside and a missing type to note', () => {
    const doc = lowerMdx('<Callout type="aside">\n\nText.\n\n</Callout>\n\n<Callout>\n\nMore.\n\n</Callout>\n', opts);
    const callouts = ofType(doc.nodes, 'callout');
    expect(callouts.map((c) => c.kind)).toEqual(['aside', 'note']);
    expect(callouts[0]).not.toHaveProperty('title');
  });

  it('gives unsupported for any other Callout type', () => {
    const doc = lowerMdx('intro\n\n<Callout type="danger">\n\nText.\n\n</Callout>\n', opts);
    expect(ofType(doc.nodes, 'callout')).toEqual([]);
    expect(ofType(doc.nodes, 'unsupported')).toEqual([{ type: 'unsupported', component: 'Callout', line: 3 }]);
  });

  it('slugifies the interactive name for the anchor and falls back to the component name', () => {
    const doc = lowerMdx('<StateMachine name="TCP Handshake v2" />\n\n<OutOfBandDiagram />\n', opts);
    expect(ofType(doc.nodes, 'interactive')).toEqual([
      { type: 'interactive', component: 'StateMachine', name: 'TCP Handshake v2', anchor: '#tcp-handshake-v2' },
      { type: 'interactive', component: 'OutOfBandDiagram', anchor: '#outofbanddiagram' },
    ]);
  });

  it('absolutizes link and image URLs inline, and resolves #fragments against the canonical URL', () => {
    const doc = lowerMdx(
      'See [the guide](/blog/other), [ext](https://example.com/x), [here](#part-2) and ![pic](/a.png) inline.\n',
      opts,
    );
    const paragraph = ofType(doc.nodes, 'paragraph')[0];
    const urls = (paragraph?.children ?? []).flatMap((c) => (c.type === 'link' || c.type === 'image' ? [c.url] : []));
    expect(urls).toEqual([
      'https://www.example-blog.dev/blog/other',
      'https://example.com/x',
      `${opts.canonicalUrl}#part-2`,
      'https://www.example-blog.dev/a.png',
    ]);
  });

  it('resolves reference-style links through their definitions', () => {
    const doc = lowerMdx('A [ref][r] link.\n\n[r]: /docs/x\n', opts);
    const paragraph = ofType(doc.nodes, 'paragraph')[0];
    expect(paragraph?.children.find((c) => c.type === 'link')).toMatchObject({
      type: 'link',
      url: 'https://www.example-blog.dev/docs/x',
    });
  });

  it('lowers ordered and unordered lists, blockquotes and thematic breaks', () => {
    const doc = lowerMdx('1. one\n2. two\n\n- a\n- b\n\n> quoted\n\n---\n', opts);
    expect(doc.nodes.map((n) => n.type)).toEqual(['list', 'list', 'blockquote', 'thematicBreak']);
    const [ordered, bullets] = ofType(doc.nodes, 'list');
    expect(ordered?.ordered).toBe(true);
    expect(ordered?.items).toHaveLength(2);
    expect(bullets?.ordered).toBe(false);
    expect(doc.plainText).toContain('quoted');
  });

  it('keeps the start number of an ordered list that does not begin at 1', () => {
    const doc = lowerMdx('7. seven\n8. eight\n\nBetween.\n\n11. eleven\n', opts);
    const [first, second] = ofType(doc.nodes, 'list');
    expect(first).toMatchObject({ ordered: true, start: 7 });
    expect(first?.items).toHaveLength(2);
    expect(second).toMatchObject({ ordered: true, start: 11 });
    const bullets = ofType(lowerMdx('- a\n- b\n', opts).nodes, 'list')[0];
    expect(bullets !== undefined && 'start' in bullets).toBe(false);
  });

  it('reports an unknown lowercase element as unsupported (in MDX it is JSX, not html)', () => {
    const doc = lowerMdx('<div>raw</div>\n', opts);
    expect(doc.nodes).toEqual([{ type: 'unsupported', component: 'div', line: 1 }]);
  });

  it('reports a component used inline instead of dropping it silently', () => {
    const doc = lowerMdx('Some text with <FancyThing /> inside.\n', opts);
    expect(doc.nodes.map((n) => n.type)).toEqual(['paragraph', 'unsupported']);
    expect(ofType(doc.nodes, 'unsupported')[0]?.component).toBe('FancyThing');
    expect(doc.plainText).toContain('Some text with');
  });

  it('reports JSX inside a table cell as unsupported, after the table', () => {
    const doc = lowerMdx('| a | b |\n|---|---|\n| <FancyThing/> | `x` and **y** |\n', opts);
    expect(doc.nodes.map((n) => n.type)).toEqual(['table', 'unsupported']);
    expect(ofType(doc.nodes, 'unsupported')[0]).toEqual({ type: 'unsupported', component: 'FancyThing', line: 3 });
    expect(ofType(doc.nodes, 'table')[0]?.rows).toEqual([['', 'x and y']]);
  });

  it('reports an inline expression as unsupported after its paragraph', () => {
    const doc = lowerMdx('First line.\n\nWe have {props.count} items and {1 + 1} more.\n', opts);
    expect(doc.nodes.map((n) => n.type)).toEqual(['paragraph', 'paragraph', 'unsupported', 'unsupported']);
    expect(ofType(doc.nodes, 'unsupported')).toEqual([
      { type: 'unsupported', component: '{expression}', line: 3 },
      { type: 'unsupported', component: '{expression}', line: 3 },
    ]);
  });

  it('reports a flow expression as unsupported in place', () => {
    const doc = lowerMdx('Before.\n\n{items.map((i) => i.name)}\n\nAfter.\n', opts);
    expect(doc.nodes.map((n) => n.type)).toEqual(['paragraph', 'unsupported', 'paragraph']);
    expect(doc.nodes[1]).toEqual({ type: 'unsupported', component: '{expression}', line: 3 });
  });

  it('drops comment-only expressions silently, inline and in flow', () => {
    const doc = lowerMdx('{/* flow */}\n\nText {/* inline */}here.\n\n{/* a */ /* b */}\n', opts);
    expect(doc.nodes.map((n) => n.type)).toEqual(['paragraph']);
    expect(doc.plainText).toBe('Text here.');
  });

  it('drops export statements and comment-only expressions', () => {
    const doc = lowerMdx('export const meta = { a: 1 };\n\n{/* a comment */}\n\nBody text.\n', opts);
    expect(doc.nodes.map((n) => n.type)).toEqual(['paragraph']);
    expect(doc.plainText).toBe('Body text.');
  });

  it('does not share state between calls', () => {
    const a = lowerMdx('[x](/one)\n', opts);
    const b = lowerMdx('[x](/one)\n', { ...opts, baseUrl: 'https://example.org' });
    expect(JSON.stringify(a)).toContain('https://www.example-blog.dev/one');
    expect(JSON.stringify(b)).toContain('https://example.org/one');
  });
});
