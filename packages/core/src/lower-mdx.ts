import type { PhrasingContent } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { INTERACTIVE_COMPONENTS } from './portable-doc.js';
import { absolutize } from './urls.js';
import type { Inline, PNode, PortableDoc } from './portable-doc.js';

export interface LowerMdxOptions {
  /** Site origin; site-relative link and image URLs are resolved against it. */
  baseUrl: string;
  /** Canonical post URL; `#fragment` links are resolved against it. */
  canonicalUrl: string;
}

/**
 * Loose view of an mdast node. The MDX node types (`mdxJsxFlowElement`, ...)
 * only exist in mdast through module augmentation from packages this package
 * does not depend on directly, so the tree is walked through this shape.
 */
interface MdNode {
  type: string;
  children?: MdNode[];
  position?: { start: { line: number } } | undefined;
  value?: string;
  [key: string]: unknown;
}

interface JsxAttribute {
  type: string;
  name?: string;
  value?: unknown;
}

interface Definition {
  url: string;
  title?: string | null | undefined;
}

interface Context {
  baseUrl: string;
  canonicalUrl: string;
  definitions: Map<string, Definition>;
}

const INTERACTIVE = new Set<string>(INTERACTIVE_COMPONENTS);
const CALLOUT_KINDS = new Set(['note', 'aside', 'alert']);

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const stringProp = (node: MdNode, key: string): string | undefined => {
  const value = node[key];
  return typeof value === 'string' ? value : undefined;
};

const lineOf = (node: MdNode): number => node.position?.start.line ?? 0;

function collectDefinitions(node: MdNode, into: Map<string, Definition>): void {
  if (node.type === 'definition') {
    const identifier = stringProp(node, 'identifier');
    const url = stringProp(node, 'url');
    if (identifier !== undefined && url !== undefined && !into.has(identifier)) {
      into.set(identifier, { url, title: node['title'] as string | null | undefined });
    }
  }
  for (const child of node.children ?? []) collectDefinitions(child, into);
}

function resolveUrl(url: string, ctx: Context): string {
  if (url === '') return url;
  if (url.startsWith('#')) return `${ctx.canonicalUrl}${url}`;
  return absolutize(url, ctx.baseUrl);
}

/** Copy of a node without `position`, with the given overrides. */
function stripped(node: MdNode, overrides: Record<string, unknown>): Inline {
  const { position: _position, ...rest } = node;
  return { ...rest, ...overrides } as unknown as Inline;
}

function jsxAttribute(node: MdNode, name: string): JsxAttribute | undefined {
  const attributes = node['attributes'];
  if (!Array.isArray(attributes)) return undefined;
  return (attributes as JsxAttribute[]).find((a) => a.type === 'mdxJsxAttribute' && a.name === name);
}

/** The string value of a JSX attribute; undefined when absent, boolean-style or an expression. */
const jsxString = (node: MdNode, name: string): string | undefined => {
  const value = jsxAttribute(node, name)?.value;
  return typeof value === 'string' ? value : undefined;
};

function interactiveNode(component: string, name: string | undefined): PNode {
  const slug = (name === undefined ? '' : slugify(name)) || slugify(component);
  return { type: 'interactive', component, ...(name === undefined ? {} : { name }), anchor: `#${slug}` };
}

// ---------------------------------------------------------------- inline

function lowerInlines(nodes: MdNode[], ctx: Context, extras: PNode[]): Inline[] {
  return nodes.flatMap((node) => lowerInline(node, ctx, extras));
}

function lowerInline(node: MdNode, ctx: Context, extras: PNode[]): Inline[] {
  switch (node.type) {
    case 'emphasis':
    case 'strong':
    case 'delete':
      return [stripped(node, { children: lowerInlines(node.children ?? [], ctx, extras) })];
    case 'link':
      return [
        stripped(node, {
          url: resolveUrl(stringProp(node, 'url') ?? '', ctx),
          children: lowerInlines(node.children ?? [], ctx, extras),
        }),
      ];
    case 'image':
      return [stripped(node, { url: resolveUrl(stringProp(node, 'url') ?? '', ctx) })];
    case 'linkReference': {
      const definition = ctx.definitions.get(stringProp(node, 'identifier') ?? '');
      const children = lowerInlines(node.children ?? [], ctx, extras);
      if (!definition) return children;
      return [
        {
          type: 'link',
          url: resolveUrl(definition.url, ctx),
          ...(definition.title ? { title: definition.title } : {}),
          children,
        } as Inline,
      ];
    }
    case 'imageReference': {
      const definition = ctx.definitions.get(stringProp(node, 'identifier') ?? '');
      if (!definition) return [];
      return [
        {
          type: 'image',
          url: resolveUrl(definition.url, ctx),
          alt: stringProp(node, 'alt') ?? '',
          ...(definition.title ? { title: definition.title } : {}),
        } as Inline,
      ];
    }
    case 'text':
    case 'inlineCode':
    case 'break':
    case 'html':
    case 'footnoteReference':
      return [stripped(node, {})];
    case 'mdxJsxTextElement': {
      // A component in the middle of a sentence cannot be a block node. Report it
      // after the paragraph (never drop it silently) and keep its text in place.
      extras.push(...lowerJsx(node, ctx, false, true));
      return lowerInlines(node.children ?? [], ctx, extras);
    }
    case 'mdxTextExpression':
      // Dynamic content cannot be lowered: report it after the paragraph, keep the text around it.
      if (!isCommentOnly(node)) extras.push(expressionNode(node));
      return [];
    default:
      return [];
  }
}

function inlineText(nodes: readonly PhrasingContent[]): string {
  return nodes
    .map((node): string => {
      switch (node.type) {
        case 'text':
        case 'inlineCode':
          return node.value;
        case 'break':
          return '\n';
        case 'image':
          return node.alt ?? '';
        case 'emphasis':
        case 'strong':
        case 'delete':
        case 'link':
          return inlineText(node.children);
        default:
          return '';
      }
    })
    .join('');
}

// ------------------------------------------------------------------ flow

function lowerFlows(nodes: MdNode[], ctx: Context): PNode[] {
  return nodes.flatMap((node) => lowerFlow(node, ctx));
}

// A braces expression holding only block comments carries no content.
const isCommentOnly = (node: MdNode): boolean => /^(?:\/\*[\s\S]*?\*\/\s*)*$/.test((node.value ?? '').trim());

const expressionNode = (node: MdNode): PNode => ({ type: 'unsupported', component: '{expression}', line: lineOf(node) });

const isBlank = (node: MdNode): boolean => node.type === 'text' && (node.value ?? '').trim() === '';

function lowerFlow(node: MdNode, ctx: Context): PNode[] {
  switch (node.type) {
    case 'heading': {
      const extras: PNode[] = [];
      const depth = Math.min(6, Math.max(1, Number(node['depth']) || 1)) as 1 | 2 | 3 | 4 | 5 | 6;
      return [{ type: 'heading', depth, children: lowerInlines(node.children ?? [], ctx, extras) }, ...extras];
    }
    case 'paragraph':
      return lowerParagraph(node, ctx);
    case 'list': {
      const ordered = node['ordered'] === true;
      const start = node['start'];
      return [
        {
          type: 'list',
          ordered,
          ...(ordered && typeof start === 'number' && Number.isInteger(start) ? { start } : {}),
          items: (node.children ?? []).map((item) => lowerFlows(item.children ?? [], ctx)),
        },
      ];
    }
    case 'code': {
      const lang = stringProp(node, 'lang');
      return [{ type: 'code', ...(lang ? { lang } : {}), value: node.value ?? '' }];
    }
    case 'table': {
      const [headRow, ...bodyRows] = node.children ?? [];
      const extras: PNode[] = [];
      const cells = (row: MdNode): string[] =>
        (row.children ?? []).map((cell) => inlineText(lowerInlines(cell.children ?? [], ctx, extras)).trim());
      const header = headRow ? cells(headRow) : [];
      const rows = bodyRows.map(cells);
      return [{ type: 'table', header, rows }, ...extras];
    }
    case 'blockquote':
      return [{ type: 'blockquote', children: lowerFlows(node.children ?? [], ctx) }];
    case 'footnoteDefinition':
      return [{ type: 'blockquote', children: lowerFlows(node.children ?? [], ctx) }];
    case 'thematicBreak':
      return [{ type: 'thematicBreak' }];
    case 'html':
      return [{ type: 'html', value: node.value ?? '' }];
    case 'mdxJsxFlowElement':
      return lowerJsx(node, ctx, false, false);
    case 'mdxFlowExpression':
      return isCommentOnly(node) ? [] : [expressionNode(node)];
    default:
      // mdxjsEsm (import/export), definition, yaml: no output.
      return [];
  }
}

function lowerParagraph(node: MdNode, ctx: Context): PNode[] {
  const meaningful = (node.children ?? []).filter((child) => !isBlank(child));
  const only = meaningful.length === 1 ? meaningful[0] : undefined;

  if (only?.type === 'mdxJsxTextElement') {
    // `<Callout>text</Callout>` on one line is a paragraph holding one inline element.
    return lowerJsx(only, ctx, true, false);
  }

  const extras: PNode[] = [];
  const children = lowerInlines(node.children ?? [], ctx, extras);

  if (only && (only.type === 'image' || only.type === 'imageReference')) {
    const [image] = children;
    if (image?.type === 'image') {
      const src = image.url;
      return [{ type: 'image', src, alt: image.alt ?? '', svg: /\.svg$/i.test(src.split(/[?#]/)[0] ?? '') }];
    }
  }
  return [{ type: 'paragraph', children }, ...extras];
}

/**
 * Lower a JSX element. `inlineChildren` means its children are phrasing content
 * (a text element), which is wrapped in a paragraph to behave like flow content.
 * `reportOnly` is for components found mid-sentence: only the report node is
 * produced, and the caller keeps the element's text in the paragraph.
 */
function lowerJsx(node: MdNode, ctx: Context, inlineChildren: boolean, reportOnly: boolean): PNode[] {
  const rawName = node['name'];
  const name = typeof rawName === 'string' ? rawName : undefined;

  const flowChildren = (): PNode[] => {
    const children = node.children ?? [];
    return lowerFlows(inlineChildren ? [{ type: 'paragraph', children }] : children, ctx);
  };

  // `<>...</>` has no name: keep the content.
  if (name === undefined) return reportOnly ? [] : flowChildren();

  if (INTERACTIVE.has(name)) {
    return [interactiveNode(name, jsxString(node, 'name'))];
  }

  if (name === 'Callout' && !reportOnly) {
    const typeAttribute = jsxAttribute(node, 'type');
    const kind = typeAttribute === undefined ? 'note' : typeAttribute.value;
    if (typeof kind === 'string' && CALLOUT_KINDS.has(kind)) {
      const title = jsxString(node, 'title');
      return [
        {
          type: 'callout',
          kind: kind as 'note' | 'aside' | 'alert',
          ...(title === undefined ? {} : { title }),
          children: flowChildren(),
        },
      ];
    }
  }

  return [{ type: 'unsupported', component: name, line: lineOf(node) }];
}

// ------------------------------------------------------------- plain text

function nodeText(node: PNode): string {
  switch (node.type) {
    case 'heading':
    case 'paragraph':
      return inlineText(node.children);
    case 'list':
      return node.items.map((item) => blocksText(item)).join('\n');
    case 'code':
      return node.value;
    case 'table':
      return [node.header, ...node.rows].map((row) => row.join(' | ')).join('\n');
    case 'image':
      return node.alt;
    case 'callout':
      return [node.title ?? '', blocksText(node.children)].filter(Boolean).join('\n\n');
    case 'blockquote':
      return blocksText(node.children);
    default:
      return '';
  }
}

const blocksText = (nodes: readonly PNode[]): string =>
  nodes
    .map(nodeText)
    .filter((text) => text !== '')
    .join('\n\n');

// ----------------------------------------------------------------- entry

/**
 * Lower the body of an MDX post (frontmatter already removed) to a PortableDoc.
 *
 * - ESM `import`/`export` and comment-only expressions are dropped.
 * - Any other `{expression}` becomes `unsupported` (component `{expression}`).
 * - `Callout` maps to `callout` (its `type` becomes `kind`; any other value is `unsupported`).
 * - `PacketJourney`, `StateMachine` and `OutOfBandDiagram` map to `interactive`.
 * - Every other component becomes `unsupported`, with the 1-based line in `body`.
 * - Link and image URLs are absolutized against `baseUrl`; `#fragment` links against `canonicalUrl`.
 *
 * Throws the parser's error (with a line and column) when the MDX is invalid.
 */
export function lowerMdx(body: string, opts: LowerMdxOptions): PortableDoc {
  const processor = unified().use(remarkParse).use(remarkMdx).use(remarkGfm);
  const root = processor.parse(body) as unknown as MdNode;

  const definitions = new Map<string, Definition>();
  collectDefinitions(root, definitions);

  const nodes = lowerFlows(root.children ?? [], {
    baseUrl: opts.baseUrl,
    canonicalUrl: opts.canonicalUrl,
    definitions,
  });
  return { nodes, plainText: blocksText(nodes) };
}
