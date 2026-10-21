import GithubSlugger from 'github-slugger';
import type { Element, ElementContent, Properties, Root } from 'hast';
import { toString } from 'hast-util-to-string';
import { defaultSchema, sanitize, type Schema } from 'hast-util-sanitize';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import { HIGHLIGHT_ALIASES, HIGHLIGHT_LANGUAGES, PLAIN_TEXT_LANGUAGES } from './languages';

/**
 * THE Markdown pipeline. The editing preview (in the browser) and the reading view (on the server)
 * both call renderMarkdown, so what you preview is what you read.
 *
 *   Markdown (GFM: tables, task lists, footnotes, strikethrough, autolinks)
 *     -> HTML tree, raw HTML allowed in
 *     -> sanitize against an allow-list, comparing before and after so every removal is REPORTED
 *     -> syntax highlighting, heading anchors, safe links and images, mermaid placeholders
 *     -> HTML string
 *
 * Nothing is dropped silently: removed elements, attributes and unsafe links come back as notices
 * for the UI to show ("N items were not rendered"). Plain HTML comments are the one exception; they
 * are invisible by nature and stay in the Markdown source. Math is not rendered (dollar-sign text
 * stays as written); embeds are not supported (iframes are removed and reported).
 */

export interface RenderNotice {
  /** Stable key for the kind of removal, for lists and tests. */
  key: string;
  /** What was removed, in words a writer understands. */
  label: string;
  count: number;
}

export interface RenderedHeading {
  depth: number;
  text: string;
  id: string;
}

export interface RenderResult {
  html: string;
  notices: RenderNotice[];
  /** Total of all notice counts: the "N" in "N items were not rendered". */
  removedCount: number;
  headings: RenderedHeading[];
  mermaidCount: number;
  /** Uploaded images the document points at (`asset:<id>` references). */
  assetIds: string[];
}

export const ASSET_URL_PREFIX = '/api/assets/';
const ASSET_REF = /^asset:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const ID_PREFIX = 'user-content-';
const MARK = 'dataCphId';

/** The sanitizer's allow-list: GitHub's, plus a marker the pipeline uses to see what was removed. */
const SCHEMA: Schema = {
  ...defaultSchema,
  clobberPrefix: ID_PREFIX,
  // Elements whose contents are not text a reader should see.
  strip: ['script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'frame', 'frameset'],
  attributes: {
    ...defaultSchema.attributes,
    '*': [...(defaultSchema.attributes?.['*'] ?? []), MARK],
  },
};

interface PreEntry {
  id: number;
  tag: string;
  props: Properties;
  parent: number | null;
}

type Data = Record<string, unknown>;
const dataOf = (file: unknown) => (file as { data: Data }).data;

function isElement(node: unknown): node is Element {
  return typeof node === 'object' && node !== null && (node as { type?: string }).type === 'element';
}

/** `asset:<id>` becomes the authenticated route; anything else is left for the sanitizer to judge. */
function rehypeAssets() {
  return (tree: Root, file: unknown) => {
    const ids = new Set<string>();
    visit(tree, 'element', (node) => {
      for (const key of ['src', 'href'] as const) {
        const value = node.properties?.[key];
        if (typeof value !== 'string') continue;
        const match = ASSET_REF.exec(value.trim());
        if (match) {
          const id = match[1]!.toLowerCase();
          ids.add(id);
          node.properties[key] = `${ASSET_URL_PREFIX}${id}`;
        }
      }
    });
    dataOf(file).assetIds = [...ids];
  };
}

function attributeName(prop: string): string {
  if (/^on[A-Za-z]/.test(prop)) return prop.toLowerCase();
  if (prop === 'className') return 'class';
  return prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}


/** Sanitize, and report precisely what the sanitizer took out. */
function rehypeSanitizeAndReport() {
  return (tree: Root, file: unknown) => {
    const before: PreEntry[] = [];
    let counter = 0;
    visit(tree, 'element', (node, _index, parent) => {
      const id = ++counter;
      node.properties = { ...node.properties, [MARK]: id };
      const parentId = isElement(parent) ? Number(parent.properties?.[MARK]) : null;
      const props: Properties = { ...node.properties };
      delete props[MARK];
      before.push({ id, tag: node.tagName, props, parent: parentId });
    });

    const clean = sanitize(tree, SCHEMA) as Root;

    const after = new Map<number, Properties>();
    visit(clean, 'element', (node) => {
      const id = Number(node.properties?.[MARK]);
      if (Number.isFinite(id)) after.set(id, { ...node.properties });
      delete node.properties[MARK];
    });

    const counts = new Map<string, RenderNotice>();
    const add = (key: string, label: string) => {
      const existing = counts.get(key);
      if (existing) existing.count += 1;
      else counts.set(key, { key, label, count: 1 });
    };
    const strip = new Set(SCHEMA.strip ?? []);
    const gone = new Set<number>();
    for (const entry of before) {
      if (entry.parent !== null && gone.has(entry.parent)) {
        gone.add(entry.id);
        continue;
      }
      const surviving = after.get(entry.id);
      if (!surviving) {
        // A removed element with a "strip" tag takes its content with it; others leave their children.
        if (strip.has(entry.tag)) gone.add(entry.id);
        const known = SCHEMA.tagNames?.includes(entry.tag);
        const label = strip.has(entry.tag)
          ? `<${entry.tag}> element (it can run code or load other pages)`
          : known
            ? `<${entry.tag}> in a place HTML does not allow`
            : `<${entry.tag}> element (not a supported tag)`;
        add(`element:${entry.tag}`, label);
        continue;
      }
      for (const [prop, value] of Object.entries(entry.props)) {
        if (prop in surviving) continue;
        if (prop === 'href' || prop === 'src' || prop === 'cite' || prop === 'longDesc') {
          const text = String(value);
          const scheme = /^\s*([a-z][a-z0-9+.-]*):/i.exec(text)?.[1]?.toLowerCase();
          add(`link:${scheme ?? 'other'}`, scheme ? `Link with the unsafe address type "${scheme}:"` : `Link address removed from <${entry.tag}>`);
        } else {
          add(`attr:${prop}:${entry.tag}`, `${attributeName(prop)} attribute on <${entry.tag}>`);
        }
      }
    }
    const notices = [...counts.values()];
    dataOf(file).notices = notices;
    return clean;
  };
}

/** Anchors, safe external links and images, scrolling tables, mermaid placeholders. Runs after sanitizing. */
function rehypeEnhance() {
  return (tree: Root, file: unknown) => {
    const slugger = new GithubSlugger();
    const headings: RenderedHeading[] = [];
    let mermaid = 0;

    visit(tree, 'element', (node, index, parent) => {
      const props = (node.properties ??= {});

      if (/^h[1-6]$/.test(node.tagName)) {
        const text = toString(node).trim();
        const existing = typeof props.id === 'string' ? props.id : null;
        const id = existing ?? `${ID_PREFIX}${slugger.slug(text) || 'section'}`;
        props.id = id;
        if (!existing && text) {
          headings.push({ depth: Number(node.tagName.slice(1)), text, id });
          node.children.push({
            type: 'element',
            tagName: 'a',
            properties: { className: ['anchor'], href: `#${id}`, ariaLabel: `Link to ${text}` },
            children: [{ type: 'text', value: '#' }],
          });
        }
        return;
      }

      if (node.tagName === 'a' && typeof props.href === 'string') {
        if (props.href.startsWith('#') && !props.href.startsWith(`#${ID_PREFIX}`)) {
          props.href = `#${ID_PREFIX}${props.href.slice(1)}`;
        } else if (/^https?:\/\//i.test(props.href)) {
          props.rel = ['noopener', 'noreferrer', 'nofollow'];
        }
        return;
      }

      if (node.tagName === 'img') {
        props.loading = 'lazy';
        props.decoding = 'async';
        props.referrerPolicy = 'no-referrer';
        return;
      }

      if (node.tagName === 'table' && parent && index !== undefined) {
        const wrapper: Element = {
          type: 'element',
          tagName: 'div',
          properties: { className: ['md-table'], tabIndex: 0, role: 'region', ariaLabel: 'Table (scrolls sideways)' },
          children: [node],
        };
        parent.children[index] = wrapper;
        return;
      }

      if (node.tagName === 'pre') {
        const code = node.children.find((c): c is Element => isElement(c) && c.tagName === 'code');
        const classes = (code?.properties?.className as string[] | undefined) ?? [];
        const lang = classes.find((c) => c.startsWith('language-'))?.slice('language-'.length);
        if (lang) props.dataLang = lang;
        if (lang === 'mermaid' && parent && index !== undefined) {
          mermaid += 1;
          const block: Element = {
            type: 'element',
            tagName: 'div',
            properties: { className: ['mermaid-block'], dataMermaid: '' },
            children: [node as ElementContent],
          };
          parent.children[index] = block;
        }
      }
    });

    const data = dataOf(file);
    data.headings = headings;
    data.mermaidCount = mermaid;
  };
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true, clobberPrefix: '' })
  .use(rehypeRaw)
  .use(rehypeAssets)
  .use(rehypeSanitizeAndReport)
  .use(rehypeHighlight, {
    languages: HIGHLIGHT_LANGUAGES,
    aliases: HIGHLIGHT_ALIASES,
    plainText: PLAIN_TEXT_LANGUAGES,
    detect: false,
  })
  .use(rehypeEnhance)
  .use(rehypeStringify);

/** Render Markdown to safe HTML plus a report of anything that was left out. */
export async function renderMarkdown(source: string): Promise<RenderResult> {
  const file = await processor.process(source.replace(/^﻿/, ''));
  const data = file.data as Data;
  const notices = (data.notices as RenderNotice[] | undefined) ?? [];
  return {
    html: String(file),
    notices,
    removedCount: notices.reduce((sum, n) => sum + n.count, 0),
    headings: (data.headings as RenderedHeading[] | undefined) ?? [],
    mermaidCount: (data.mermaidCount as number | undefined) ?? 0,
    assetIds: (data.assetIds as string[] | undefined) ?? [],
  };
}

/** The "N items were not rendered" heading for a result, or null when nothing was removed. */
export function noticeSummary(result: Pick<RenderResult, 'removedCount'>): string | null {
  const n = result.removedCount;
  if (n === 0) return null;
  return n === 1 ? '1 item was not rendered' : `${n} items were not rendered`;
}
