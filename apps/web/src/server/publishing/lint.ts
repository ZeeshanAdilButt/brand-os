import type { DraftPayload, LintIssue } from '../../lib/publishing';

/** Fenced code blocks and inline code can hold anything. Blank them out (keeping length) before scanning. */
export function stripCode(markdown: string): string {
  return markdown
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, (span) => ' '.repeat(span.length));
}

/** A host that only exists on the writer's machine or network. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.test') || host.endsWith('.invalid')) return true;
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return !host.includes('.');
}

export type UrlVerdict = { reachable: true } | { reachable: false; why: string };

/** Judge a link or image address by its form only. Nothing is fetched. */
export function judgeUrl(raw: string): UrlVerdict {
  const url = raw.trim().replace(/^<|>$/g, '');
  if (!url || url.startsWith('#')) return { reachable: true };
  if (/^asset:/i.test(url)) return { reachable: false, why: 'it is a file stored only in this app' };
  if (/^(file|blob):/i.test(url)) return { reachable: false, why: 'it points to a file on your machine' };
  if (/^data:/i.test(url)) return { reachable: false, why: 'it is embedded in the text instead of being a public link' };
  if (/^(mailto|tel):/i.test(url)) return { reachable: true };
  if (url.startsWith('//')) return judgeUrl(`https:${url}`);
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return { reachable: false, why: 'it is a relative address that means nothing outside your site' };
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { reachable: false, why: `the ${parsed.protocol} scheme is not a public web address` };
    if (isPrivateHost(parsed.hostname)) return { reachable: false, why: 'it points to your own machine or network' };
    return { reachable: true };
  } catch {
    return { reachable: false, why: 'it is not a valid address' };
  }
}

export interface BodyFindings {
  /** Images that only exist on this machine: asset references, relative paths, private hosts. */
  localImages: string[];
  /** Links nobody else can follow. */
  badLinks: string[];
  /** Images served over plain http, which browsers block on https pages. */
  insecureImages: string[];
  /** HTML elements the platforms remove or ignore. */
  unsupportedHtml: string[];
  hasMermaid: boolean;
  /** Text that Liquid-based platforms read as a template tag. */
  liquidLike: string[];
}

const short = (text: string) => (text.length > 90 ? `${text.slice(0, 87)}...` : text);

/** Scan Markdown for the things that break when it leaves this app. */
export function analyzeBody(markdown: string): BodyFindings {
  const text = stripCode(markdown);
  const findings: BodyFindings = { localImages: [], badLinks: [], insecureImages: [], unsupportedHtml: [], hasMermaid: /^(```|~~~)\s*mermaid\b/im.test(markdown), liquidLike: [] };
  const seen = new Set<string>();
  const once = (list: string[], value: string) => {
    const key = `${list === findings.localImages ? 'i' : list === findings.badLinks ? 'l' : 'x'}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push(short(value));
  };

  // Inline images and links: ![alt](url "title") and [text](url "title"). The URL ends at whitespace or ).
  const imageTargets = new Set<number>();
  for (const match of text.matchAll(/!\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^\s)]*)/g)) {
    const url = match[1] ?? '';
    imageTargets.add(match.index + match[0].length - url.length);
    if (!judgeUrl(url).reachable) once(findings.localImages, url);
    else if (/^http:\/\//i.test(url)) once(findings.insecureImages, url);
  }
  // Every other ](target) is a link, including one that wraps an image: [![alt](img)](link).
  for (const match of text.matchAll(/\]\(\s*(<[^>]*>|[^\s)]*)/g)) {
    const url = match[1] ?? '';
    if (imageTargets.has(match.index + match[0].length - url.length)) continue;
    if (!judgeUrl(url).reachable) once(findings.badLinks, url);
  }
  // Reference definitions: [id]: url
  for (const match of text.matchAll(/^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/gm)) {
    const url = match[1] ?? '';
    const verdict = judgeUrl(url);
    if (!verdict.reachable) once(findings.badLinks, url);
  }
  // HTML images: <img src="...">
  for (const match of text.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']?([^"'\s>]+)/gi)) {
    const url = match[1] ?? '';
    if (!judgeUrl(url).reachable) once(findings.localImages, url);
    else if (/^http:\/\//i.test(url)) once(findings.insecureImages, url);
  }
  for (const match of text.matchAll(/<(script|iframe|style|object|embed|form|link|meta)\b/gi)) {
    const tag = `<${(match[1] ?? '').toLowerCase()}>`;
    if (!findings.unsupportedHtml.includes(tag)) findings.unsupportedHtml.push(tag);
  }
  for (const match of text.matchAll(/\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\}/g)) {
    if (findings.liquidLike.length < 5) findings.liquidLike.push(short(match[0].replace(/\s+/g, ' ')));
  }
  return findings;
}

const LIST_LIMIT = 6;
function listed(items: string[]): string[] {
  return items.length > LIST_LIMIT ? [...items.slice(0, LIST_LIMIT), `and ${items.length - LIST_LIMIT} more`] : items;
}

export interface PayloadLintOptions {
  /** The article has a cover image stored in this app, which cannot be sent. */
  hasLocalCover: boolean;
  maxBodyChars: number;
  platformName: string;
}

/** Platform-neutral problems in an adapted payload. Errors block approval; warnings are shown and allowed. */
export function lintPayload(payload: DraftPayload, options: PayloadLintOptions): LintIssue[] {
  const issues: LintIssue[] = [];
  if (!payload.title.trim()) {
    issues.push({ code: 'title_empty', severity: 'error', message: 'The title is empty. Give the article a title.' });
  }
  if (!payload.bodyMarkdown.trim()) {
    issues.push({ code: 'body_empty', severity: 'error', message: 'The article has no text.' });
  }
  if (payload.bodyMarkdown.length > options.maxBodyChars) {
    issues.push({
      code: 'body_too_long',
      severity: 'error',
      message: `The article is ${payload.bodyMarkdown.length.toLocaleString('en')} characters, over the ${options.maxBodyChars.toLocaleString('en')} that ${options.platformName} can take from this app.`,
    });
  }
  if (!payload.canonicalUrl) {
    issues.push({
      code: 'canonical_missing',
      severity: 'warning',
      message: `No canonical URL is set. Without it ${options.platformName} will not point readers or search engines back to your own site.`,
    });
  }
  if (payload.coverImageUrl) {
    const verdict = judgeUrl(payload.coverImageUrl);
    if (!verdict.reachable || !/^https:\/\//i.test(payload.coverImageUrl)) {
      issues.push({ code: 'cover_not_public', severity: 'error', message: 'The cover image must be a public https URL.', items: [payload.coverImageUrl] });
    }
  } else if (options.hasLocalCover) {
    issues.push({
      code: 'cover_local_only',
      severity: 'warning',
      message: 'The article’s cover image only exists in this app, so no cover will be sent. Add a public https URL for the cover to include one.',
    });
  }

  const found = analyzeBody(payload.bodyMarkdown);
  if (found.localImages.length > 0) {
    issues.push({
      code: 'image_local',
      severity: 'error',
      message: 'This image only exists on your machine; use a public URL.',
      items: listed(found.localImages),
    });
  }
  if (found.badLinks.length > 0) {
    issues.push({ code: 'link_not_public', severity: 'error', message: 'These links are not publicly reachable. Readers elsewhere cannot follow them.', items: listed(found.badLinks) });
  }
  if (found.insecureImages.length > 0) {
    issues.push({ code: 'image_insecure', severity: 'warning', message: 'These images use plain http, which browsers block on https pages. Prefer https.', items: listed(found.insecureImages) });
  }
  if (found.unsupportedHtml.length > 0) {
    issues.push({
      code: 'html_removed',
      severity: 'warning',
      message: `${options.platformName} removes or ignores some HTML. These elements will not work as written.`,
      items: found.unsupportedHtml,
    });
  }
  return issues;
}

export const hasErrors = (issues: readonly LintIssue[]): boolean => issues.some((issue) => issue.severity === 'error');
