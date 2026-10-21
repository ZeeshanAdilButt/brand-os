import type { BlockContent, DefinitionContent, ListItem, PhrasingContent, Root, RootContent, TableRow } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';
import type { LintResult, ContentItem } from '../model.js';
import type { PNode, PortableDoc } from '../portable-doc.js';
import type { Transform } from './types.js';

/**
 * The dev.to article payload. `published` is the literal `false`: the skeleton
 * cannot express a live article. Going public is a separate, approved publish.
 */
export interface DevtoPayload {
  title: string;
  body_markdown: string;
  published: false;
  canonical_url: string;
  main_image: string;
  description: string;
  tags: string[];
  series?: string;
}

export const DEVTO_MAX_TAGS = 4;

type Block = BlockContent | DefinitionContent;

const sanitizeTag = (tag: string): string => tag.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * dev.to tags: lowercase, `[a-z0-9]` only, deduplicated, at most 4. With a non-empty `preferred`
 * list, the tags that appear in both lists come first in preference order, then the rest in
 * their original order; without one, the first 4 in original order.
 */
export function sanitizeDevtoTags(tags: string[], preferred: string[] = []): string[] {
  const candidates = [...new Set(tags.map(sanitizeTag).filter((tag) => tag !== ''))];
  const wanted = [...new Set(preferred.map(sanitizeTag))].filter((tag) => candidates.includes(tag));
  const ordered = [...wanted, ...candidates.filter((tag) => !wanted.includes(tag))];
  return ordered.slice(0, DEVTO_MAX_TAGS);
}

// ---------------------------------------------------------------- render

const text = (value: string): PhrasingContent => ({ type: 'text', value });
const strong = (value: string): PhrasingContent => ({ type: 'strong', children: [text(value)] });
const paragraph = (children: PhrasingContent[]): Block => ({ type: 'paragraph', children });

function calloutBlocks(node: Extract<PNode, { type: 'callout' }>, item: ContentItem): Block[] {
  const body = lowerBlocks(node.children, item);
  const first = body[0];
  let lead: PhrasingContent[];
  let titleLine: Block | undefined;

  if (node.kind === 'alert') {
    // The title already reads "Big Word Alert: <term>".
    lead = [strong(node.title ?? 'Alert')];
  } else {
    lead = [strong('Note:')];
    if (node.title) titleLine = paragraph([...lead, text(` ${node.title}`)]);
  }

  if (titleLine) return [titleLine, ...body];
  if (first?.type === 'paragraph') {
    return [{ type: 'paragraph', children: [...lead, text(' '), ...first.children] }, ...body.slice(1)];
  }
  return [paragraph(lead), ...body];
}

function lowerNode(node: PNode, item: ContentItem): Block[] {
  switch (node.type) {
    case 'heading':
      return [{ type: 'heading', depth: node.depth, children: node.children }];
    case 'paragraph':
      return [{ type: 'paragraph', children: node.children }];
    case 'list':
      return [
        {
          type: 'list',
          ordered: node.ordered,
          ...(node.ordered && node.start !== undefined ? { start: node.start } : {}),
          spread: false,
          children: node.items.map((children): ListItem => ({ type: 'listItem', spread: false, children: lowerBlocks(children, item) })),
        },
      ];
    case 'code':
      return [{ type: 'code', lang: node.lang ?? null, value: node.value }];
    case 'table': {
      const row = (cells: string[]): TableRow => ({
        type: 'tableRow',
        children: cells.map((cell) => ({ type: 'tableCell', children: [text(cell)] })),
      });
      return [{ type: 'table', children: [row(node.header), ...node.rows.map(row)] }];
    }
    case 'image':
      // SVG images keep their absolute site URL until spike S3 decides whether dev.to renders SVG.
      return [paragraph([{ type: 'image', url: node.src, alt: node.alt }])];
    case 'callout':
      return [{ type: 'blockquote', children: calloutBlocks(node, item) }];
    case 'interactive': {
      // No placeholder image: a text block until an asset host can hold a PNG snapshot (Phase 2).
      const name = node.name ?? node.component;
      return [
        {
          type: 'blockquote',
          children: [
            paragraph([
              strong(`Interactive diagram: ${name}.`),
              text(' Open it on the original post: '),
              // Raw on purpose: as text, remark-stringify escapes the `:` and `.` of the URL.
              { type: 'html', value: `${item.canonicalUrl}${node.anchor}` },
            ]),
          ],
        },
      ];
    }
    case 'blockquote':
      return [{ type: 'blockquote', children: lowerBlocks(node.children, item) }];
    case 'thematicBreak':
      return [{ type: 'thematicBreak' }];
    case 'html':
      return [{ type: 'html', value: node.value }];
    case 'unsupported':
      // Never silently dropped: `lint` reports it as an error, which blocks approval.
      return [];
  }
}

const lowerBlocks = (nodes: PNode[], item: ContentItem): Block[] => nodes.flatMap((node) => lowerNode(node, item));

const footerLine = (canonicalUrl: string): string =>
  `*Originally published at [example-blog.dev](${canonicalUrl}).*`;

/**
 * Render the lowered post as dev.to markdown: GFM tables and fenced code kept, callouts as
 * blockquotes, interactive diagrams as a text block with a link, then the attribution footer.
 */
export function renderDevtoMarkdown(doc: PortableDoc, item: ContentItem): string {
  const footer: RootContent[] = [
    { type: 'thematicBreak' },
    {
      type: 'paragraph',
      children: [
        {
          type: 'emphasis',
          children: [
            text('Originally published at '),
            { type: 'link', url: item.canonicalUrl, children: [text('example-blog.dev')] },
            text('.'),
          ],
        },
      ],
    },
  ];
  const root: Root = { type: 'root', children: [...lowerBlocks(doc.nodes, item), ...footer] };

  return unified()
    .use(remarkGfm)
    .use(remarkStringify, {
      bullet: '-',
      emphasis: '*',
      strong: '*',
      fence: '`',
      fences: true,
      rule: '-',
      listItemIndent: 'one',
      incrementListMarker: true,
    })
    .stringify(root);
}

// ------------------------------------------------------------------ lint

interface MdNode {
  type: string;
  children?: MdNode[];
  url?: string;
  value?: string;
  identifier?: string;
}

/** Every image URL in the markdown: `![](url)`, reference images and `<img src>` in raw HTML. */
function imageUrls(markdown: string): string[] {
  const root = unified().use(remarkParse).use(remarkGfm).parse(markdown) as unknown as MdNode;
  const definitions = new Map<string, string>();
  const urls: string[] = [];

  const collect = (node: MdNode): void => {
    if (node.type === 'definition' && node.identifier !== undefined && node.url !== undefined) {
      definitions.set(node.identifier, node.url);
    }
    node.children?.forEach(collect);
  };
  const walk = (node: MdNode): void => {
    if (node.type === 'image' && node.url !== undefined) urls.push(node.url);
    if (node.type === 'imageReference' && node.identifier !== undefined) {
      const url = definitions.get(node.identifier);
      if (url !== undefined) urls.push(url);
    }
    if (node.type === 'html' && node.value !== undefined) {
      for (const match of node.value.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
        urls.push(match[1] ?? match[2] ?? match[3] ?? '');
      }
    }
    node.children?.forEach(walk);
  };
  collect(root);
  walk(root);
  return urls;
}

function unsupportedNodes(nodes: PNode[]): Extract<PNode, { type: 'unsupported' }>[] {
  return nodes.flatMap((node): Extract<PNode, { type: 'unsupported' }>[] => {
    switch (node.type) {
      case 'unsupported':
        return [node];
      case 'callout':
      case 'blockquote':
        return unsupportedNodes(node.children);
      case 'list':
        return node.items.flatMap(unsupportedNodes);
      default:
        return [];
    }
  });
}

const error = (rule: string, message: string): LintResult => ({ rule, severity: 'error', message });

export interface DevtoTransformOptions {
  /** `platforms.devto.tagPreference` from config: tags to keep first, in this order. */
  tagPreference?: string[];
  /** Image URLs that must never ship, besides the cover (`main_image`). */
  placeholderUrls?: string[];
}

export function createDevtoTransform(options: DevtoTransformOptions = {}): Transform<DevtoPayload> {
  const { tagPreference, placeholderUrls = [] } = options;

  return {
    platform: 'devto',
    kind: 'article',

    skeleton(item: ContentItem): DevtoPayload {
      return {
        title: item.frontmatter.title,
        body_markdown: renderDevtoMarkdown(item.doc, item),
        published: false,
        canonical_url: item.canonicalUrl,
        main_image: item.coverPngUrl,
        description: item.notes?.metaDescription || item.frontmatter.description,
        tags: sanitizeDevtoTags(item.frontmatter.tags, tagPreference),
      };
    },

    lint(p: DevtoPayload, item: ContentItem): LintResult[] {
      const results: LintResult[] = [];

      for (const node of unsupportedNodes(item.doc.nodes)) {
        results.push(
          error('unsupported-node', `Unsupported component <${node.component}> at line ${node.line}: add a transform rule.`),
        );
      }

      // A full-text copy is the post itself: its title, description, cover and body come from the
      // post (or its publishing notes) and nowhere else, so an approval can never cover rewritten
      // headline claims or a swapped cover image.
      const titles = [item.notes?.primaryTitle, item.frontmatter.title].filter((t): t is string => t !== undefined && t !== '');
      if (p.title.trim() === '') results.push(error('devto-title', 'The title is empty.'));
      else if (!titles.includes(p.title)) {
        results.push(error('devto-title', `The title must be the post's own title (${titles.map((t) => `"${t}"`).join(' or ')}), got "${p.title}".`));
      }
      const descriptions = [item.notes?.metaDescription, item.frontmatter.description].filter((d): d is string => d !== undefined && d !== '');
      if (!descriptions.includes(p.description)) {
        results.push(
          error('devto-description', `The description must be the post's meta description or frontmatter description, got "${p.description}".`),
        );
      }
      if (p.main_image.trim() === '') results.push(error('devto-main-image', 'main_image is empty.'));
      else if (p.main_image !== item.coverPngUrl) {
        results.push(error('devto-main-image', `main_image must be the post's cover PNG (${item.coverPngUrl}), got ${p.main_image}.`));
      }
      if (p.body_markdown !== renderDevtoMarkdown(item.doc, item)) {
        results.push(error('devto-body', 'body_markdown is not the post as rendered now; recreate the draft from the current post.'));
      }

      if (p.canonical_url !== item.canonicalUrl) {
        results.push(
          error('canonical-url', `canonical_url must be exactly ${item.canonicalUrl} (no UTM), got ${p.canonical_url}.`),
        );
      }

      const badTags = p.tags.filter((tag) => !/^[a-z0-9]+$/.test(tag));
      if (p.tags.length > DEVTO_MAX_TAGS) {
        results.push(error('devto-tags', `dev.to allows at most ${DEVTO_MAX_TAGS} tags, got ${p.tags.length}.`));
      }
      if (badTags.length > 0) {
        results.push(error('devto-tags', `Tags must be lowercase letters and digits only: ${badTags.join(', ')}.`));
      }
      if (new Set(p.tags).size !== p.tags.length) results.push(error('devto-tags', 'Tags must be unique.'));

      if (!p.body_markdown.includes(footerLine(item.canonicalUrl))) {
        results.push(error('devto-footer', 'The "Originally published at" footer with the canonical link is missing.'));
      }

      const placeholders = new Set([p.main_image, ...placeholderUrls].filter((url) => url !== ''));
      const hits = [...new Set(imageUrls(p.body_markdown).filter((url) => placeholders.has(url)))];
      for (const url of hits) {
        results.push(error('placeholder-image', `The body embeds a placeholder image (${url}); remove it before approval.`));
      }

      return results;
    },
  };
}

export const devtoTransform: Transform<DevtoPayload> = createDevtoTransform();
