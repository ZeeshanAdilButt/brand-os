import { html, raw, type SafeHtml } from './html.js';

/**
 * A small, safe look at a markdown body: enough to read a dev.to article the way it will roughly
 * appear (headings, paragraphs, lists, quotes, code, emphasis), never a full renderer. Every piece of
 * text goes through `html`, links and images are shown as text (no href, no network), and the exact
 * markdown is always shown next to it.
 */

const HEADINGS: readonly [SafeHtml, SafeHtml][] = [1, 2, 3, 4, 5, 6].map((n) => [raw(`<h${n}>`), raw(`</h${n}>`)]);

const INLINE = /(`[^`]+`)|!\[([^\]]*)\]\(([^)\s]*)[^)]*\)|\[([^\]]+)\]\(([^)\s]*)[^)]*\)|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*/g;

/** Inline markdown: `code`, images, links, **bold** and *em*. Anything else is plain (escaped) text. */
export function inlineMarkdown(text: string): SafeHtml {
  const out: (SafeHtml | string)[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index;
    if (at > last) out.push(text.slice(last, at));
    if (m[1] !== undefined) out.push(html`<code>${m[1].slice(1, -1)}</code>`);
    else if (m[3] !== undefined) out.push(html`<span class="md-img" title="${m[3]}">image: ${m[2] || 'no alt text'}</span>`);
    else if (m[4] !== undefined) out.push(html`<span class="md-link" title="${m[5] ?? ''}">${m[4]}</span>`);
    else if (m[6] !== undefined) out.push(html`<strong>${m[6]}</strong>`);
    else if (m[7] !== undefined) out.push(html`<em>${m[7]}</em>`);
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return html`${out}`;
}

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const LIQUID = /^\s*\{%.*%\}\s*$/;

/** Block-level markdown, line by line. */
export function renderMarkdown(source: string): SafeHtml {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: SafeHtml[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (FENCE.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i] as string)) code.push(lines[i++] as string);
      i++;
      blocks.push(html`<pre><code>${code.join('\n')}</code></pre>`);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      const [open, close] = HEADINGS[(heading[1] as string).length - 1] as [SafeHtml, SafeHtml];
      blocks.push(html`${open}${inlineMarkdown(heading[2] ?? '')}${close}`);
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push(html`<hr>`);
      i++;
      continue;
    }
    if (LIQUID.test(line)) {
      blocks.push(html`<p class="md-tag">${line.trim()}</p>`);
      i++;
      continue;
    }
    const list = BULLET.test(line) ? BULLET : NUMBERED.test(line) ? NUMBERED : undefined;
    if (list !== undefined) {
      const items: SafeHtml[] = [];
      while (i < lines.length) {
        const item = list.exec(lines[i] as string);
        if (item === null) break;
        items.push(html`<li>${inlineMarkdown(item[1] ?? '')}</li>`);
        i++;
      }
      blocks.push(list === BULLET ? html`<ul>${items}</ul>` : html`<ol>${items}</ol>`);
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length) {
        const q = QUOTE.exec(lines[i] as string);
        if (q === null) break;
        quoted.push(q[1] ?? '');
        i++;
      }
      blocks.push(html`<blockquote><p>${inlineMarkdown(quoted.join(' '))}</p></blockquote>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length) {
      const next = lines[i] as string;
      if (next.trim() === '' || FENCE.test(next) || HEADING.test(next) || RULE.test(next) || BULLET.test(next) || NUMBERED.test(next) || QUOTE.test(next) || LIQUID.test(next)) break;
      para.push(next.trim());
      i++;
    }
    if (para.length === 0) {
      // A line no block rule took (it cannot happen with the rules above, but never loop forever).
      blocks.push(html`<p>${inlineMarkdown(line)}</p>`);
      i++;
      continue;
    }
    blocks.push(html`<p>${inlineMarkdown(para.join(' '))}</p>`);
  }
  return html`${blocks}`;
}
