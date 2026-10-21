import { Readability } from '@mozilla/readability';
import type { Element, Root } from 'hast';
import { parseHTML } from 'linkedom';
import rehypeParse from 'rehype-parse';
import rehypeRemark from 'rehype-remark';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import { UrlImportError } from './url';

export interface ExtractedArticle {
  title: string;
  markdown: string;
  byline: string | null;
  siteName: string | null;
  publishedTime: string | null;
  warnings: string[];
}

const SAFE_LINK = /^(https?:|mailto:)/i;

/** Resolve a possibly relative address against the page it came from; null when it is not usable. */
function absolute(value: unknown, base: URL): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const url = new URL(value.trim(), base);
    return SAFE_LINK.test(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

const LANG_CLASS = /(?:^|\s)(?:language|lang|highlight-source|brush:)[-:\s]?([a-z0-9+#_-]+)/i;

/** Make links absolute, drop unusable ones, and put each code block's language where the converter looks for it. */
function rehypePrepare(base: URL) {
  return (tree: Root) => {
    visit(tree, 'element', (node: Element, index, parent) => {
      const props = node.properties ?? {};
      if (node.tagName === 'a') {
        const href = absolute(props.href, base);
        if (href) props.href = href;
        else delete props.href;
      } else if (node.tagName === 'img') {
        const lazy = props.dataSrc ?? props.dataOriginal ?? props.dataLazySrc;
        const src = absolute(typeof props.src === 'string' && !props.src.startsWith('data:') ? props.src : lazy, base);
        if (src) props.src = src;
        else if (parent && index !== undefined) {
          // No usable address: keep the alt text instead of an empty image.
          const alt = typeof props.alt === 'string' ? props.alt : '';
          parent.children[index] = { type: 'text', value: alt };
        }
      } else if (node.tagName === 'pre') {
        const code = node.children.find((c): c is Element => c.type === 'element' && c.tagName === 'code');
        if (code) {
          const classes = [
            ...(Array.isArray(node.properties?.className) ? node.properties.className : []),
            ...(Array.isArray(code.properties?.className) ? code.properties.className : []),
          ].join(' ');
          const lang = LANG_CLASS.exec(classes)?.[1]?.toLowerCase();
          if (lang) code.properties = { ...code.properties, className: [`language-${lang}`] };
        }
      }
    });
  };
}

const toMarkdown = (base: URL) =>
  unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypePrepare, base)
    .use(rehypeRemark)
    .use(remarkGfm)
    .use(remarkStringify, { bullet: '-', emphasis: '_', strong: '*', fences: true, listItemIndent: 'one', rule: '-' });

/** Convert an HTML fragment to Markdown, keeping code blocks, tables, links and images. */
export async function htmlToMarkdown(html: string, base: URL): Promise<string> {
  const file = await toMarkdown(base).process(html);
  return String(file).replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** Find the main article in a web page and turn it into Markdown. */
export async function extractArticle(html: string, pageUrl: URL): Promise<ExtractedArticle> {
  const { document } = parseHTML(html);
  const warnings: string[] = [];
  const result = new Readability(document as unknown as Document, { keepClasses: true, charThreshold: 100 }).parse();
  if (!result || !result.content) {
    throw new UrlImportError('failed', 'No article text could be found on that page. Try saving the page as Markdown and importing the file.');
  }
  const markdown = await htmlToMarkdown(result.content, pageUrl);
  if (markdown.trim().length < 80) {
    warnings.push('Very little text was found on that page. Check that the whole article came across.');
  }
  warnings.push('Images stay on the original site; they are linked, not copied. Upload your own copies if you want them kept.');
  const title = (result.title ?? '').trim() || (document.title ?? '').trim();
  return {
    title,
    markdown,
    byline: result.byline?.trim() || null,
    siteName: result.siteName?.trim() || null,
    publishedTime: result.publishedTime?.trim() || null,
    warnings,
  };
}
