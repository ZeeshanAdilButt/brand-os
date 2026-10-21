import { PLATFORMS, type PlatformId, type PlatformInfo } from './catalog';

/**
 * Counting, splitting and adapting text for the destinations that are not long articles: short posts, a link
 * submission and a video description. Pure, so the server (adaptation, lint) and the browser (previews, live
 * counters) agree to the character. Where a platform's own counter differs from this one the preview says
 * "approximate": X's weighting is reproduced from its public description, not from its code.
 */

const URL_RE = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g;

/** X (and Mastodon) count every link as 23 characters, whatever its length. */
export const LINK_WEIGHT = 23;

let segmenter: Intl.Segmenter | null = null;
function graphemes(text: string): string[] {
  segmenter ??= new Intl.Segmenter('en', { granularity: 'grapheme' });
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

export function graphemeCount(text: string): number {
  return graphemes(text).length;
}

/** The addresses in a text, in order. */
export function linksIn(text: string): string[] {
  return text.match(URL_RE) ?? [];
}

/** Weight of one grapheme in X's counter: most Latin text is 1, CJK and emoji are 2. */
function xWeight(grapheme: string): number {
  const code = grapheme.codePointAt(0) ?? 0;
  if (grapheme.length > 2 || code > 0x1f000) return 2; // emoji and joined sequences
  if ((code >= 0 && code <= 4351) || (code >= 8192 && code <= 8205) || (code >= 8208 && code <= 8223) || (code >= 8242 && code <= 8247)) return 1;
  return 2;
}

/** Length as X would count it: links are 23 each, other graphemes by weight. */
export function xWeightedLength(text: string): number {
  let total = 0;
  let rest = text;
  for (const link of linksIn(text)) {
    const at = rest.indexOf(link);
    if (at === -1) continue;
    total += weightOf(rest.slice(0, at)) + LINK_WEIGHT;
    rest = rest.slice(at + link.length);
  }
  return total + weightOf(rest);
}

function weightOf(text: string): number {
  return graphemes(text).reduce((sum, g) => sum + xWeight(g), 0);
}

/** Mastodon counts every link as 23 characters. */
function linkWeightedCharacters(text: string): number {
  const links = linksIn(text);
  return [...text].length - links.reduce((sum, link) => sum + [...link].length, 0) + links.length * LINK_WEIGHT;
}

/** The length of one post as the platform counts it. */
export function countPost(platform: PlatformId, text: string): number {
  const unit = PLATFORMS[platform].limits.unit;
  if (platform === 'mastodon') return linkWeightedCharacters(text);
  if (unit === 'x_weighted') return xWeightedLength(text);
  if (unit === 'graphemes') return graphemeCount(text);
  return [...text].length;
}

/** A line that holds only `---` ends one post and starts the next. */
const SEPARATOR = /^\s*---\s*$/m;

export function hasExplicitSplit(text: string): boolean {
  return SEPARATOR.test(text);
}

/** Cut `text` at the last word boundary that fits `max` by `measure`. Returns [head, rest]. */
function cutToFit(text: string, max: number, measure: (t: string) => number): [string, string] {
  if (measure(text) <= max) return [text, ''];
  const words = text.split(/(\s+)/);
  let head = '';
  for (let i = 0; i < words.length; i++) {
    const next = head + words[i]!;
    if (measure(next.trimEnd()) > max) break;
    head = next;
  }
  head = head.trimEnd();
  if (head === '') {
    // One unbroken word longer than the limit: cut inside it, by grapheme.
    const parts = graphemes(text);
    let cut = '';
    for (const g of parts) {
      if (measure(cut + g) > max) break;
      cut += g;
    }
    return [cut, text.slice(cut.length).trimStart()];
  }
  return [head, text.slice(head.length).trimStart()];
}

/** Split into sentences when a paragraph is too long, keeping the punctuation. */
function sentences(paragraph: string): string[] {
  return paragraph.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [paragraph];
}

export interface PostPart {
  text: string;
  count: number;
  limit: number | null;
  over: boolean;
}

/**
 * The posts a text becomes on a platform. Explicit `---` lines are respected. Otherwise a platform that allows
 * threads splits what does not fit, at paragraph, then sentence, then word boundaries; one that does not keeps it
 * whole (and the lint says it is too long).
 */
export function splitPosts(platform: PlatformId, text: string): PostPart[] {
  const info = PLATFORMS[platform];
  const limit = info.limits.body;
  const measure = (t: string) => countPost(platform, t);
  const part = (t: string): PostPart => {
    const count = measure(t);
    return { text: t, count, limit, over: limit !== null && count > limit };
  };
  const trimmed = text.replace(/\r\n?/g, '\n').trim();
  if (trimmed === '') return [part('')];
  const chunks = SEPARATOR.test(trimmed) ? trimmed.split(/^\s*---\s*$/m).map((c) => c.trim()).filter(Boolean) : [trimmed];
  if (limit === null || !info.limits.thread) return chunks.map(part);

  const out: string[] = [];
  for (const chunk of chunks) {
    if (measure(chunk) <= limit) {
      out.push(chunk);
      continue;
    }
    let current = '';
    const flush = () => {
      if (current.trim()) out.push(current.trim());
      current = '';
    };
    for (const paragraph of chunk.split(/\n{2,}/)) {
      const pieces = measure(paragraph) <= limit ? [paragraph] : sentences(paragraph);
      for (const piece of pieces) {
        const joined = current ? `${current}\n\n${piece}` : piece;
        if (measure(joined) <= limit) {
          current = joined;
          continue;
        }
        flush();
        let rest = piece;
        while (measure(rest) > limit) {
          const [head, tail] = cutToFit(rest, limit, measure);
          if (head === '') break;
          out.push(head);
          rest = tail;
        }
        current = rest;
      }
    }
    flush();
  }
  return out.map(part);
}

/** Where a feed shows "see more": the text before the fold and the rest. Whole words are not split. */
export function foldText(text: string, fold: number | null): { shown: string; hidden: string } {
  if (fold === null || [...text].length <= fold) return { shown: text, hidden: '' };
  const [head, tail] = cutToFit(text, fold, (t) => [...t].length);
  return { shown: head, hidden: tail };
}

export function hashtagsIn(text: string): string[] {
  return text.match(/(?:^|\s)#[\p{L}\p{N}_]+/gu)?.map((t) => t.trim()) ?? [];
}

/** A tag as a hashtag: letters and digits joined, each word capitalized so screen readers read it. */
export function toHashtag(tag: string): string {
  const words = tag
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return '';
  const joined = words.length === 1 ? words[0]! : words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');
  return /^\d+$/.test(joined) ? '' : joined;
}

/** The first sentence of the article body, without Markdown. Used for a hook when there is no description. */
export function firstSentence(markdown: string): string {
  const prose = markdown
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm, ' ')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .find((p) => p && !/^(#|>|[-*+] |\d+\. |\||!\[|<)/.test(p));
  if (!prose) return '';
  const plain = prose
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const match = /^.{20,}?[.!?](?=\s|$)/.exec(plain);
  return (match ? match[0] : plain).slice(0, 300);
}

/** Up to `max` points for a short post: the article's section headings. */
export function keyPoints(markdown: string, max = 3): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const match = /^#{2,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const text = match[1]!.replace(/[*_`]/g, '').trim();
    if (text && text.length <= 90) out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

/** Shorten at a word boundary, ending with an ellipsis, to fit `max` as `platform` counts it. */
export function fitText(platform: PlatformId, text: string, max: number): string {
  if (max <= 1) return '';
  const measure = (t: string) => countPost(platform, t);
  if (measure(text) <= max) return text;
  const [head] = cutToFit(text, max - 1, measure);
  return `${head.replace(/[\s.,;:!?-]+$/, '')}…`;
}

export interface ShortFormInput {
  title: string;
  description: string;
  tags: string[];
  canonicalUrl: string | null;
  bodyMarkdown: string;
}

/**
 * The deterministic starting point for a short destination: a hook (the description, else the first sentence),
 * up to three key points from the headings, the canonical link and a few hashtags. The owner edits it; an AI
 * rewrite is optional and goes through the task inbox. No wording is invented: everything comes from the article.
 */
export function adaptShortText(platform: PlatformId, input: ShortFormInput): { text: string; hashtags: string[]; notes: string[] } {
  const info: PlatformInfo = PLATFORMS[platform];
  const limit = info.limits.body ?? 500;
  const notes: string[] = [];
  const hook = input.description.trim() || firstSentence(input.bodyMarkdown) || input.title.trim();
  const points = keyPoints(input.bodyMarkdown, 3);
  const tagLimit = info.limits.tagsMax ?? 3;
  const hashtags = input.tags.map(toHashtag).filter(Boolean).slice(0, tagLimit);
  const link = input.canonicalUrl;
  const tagLine = hashtags.map((t) => `#${t}`).join(' ');
  if (!link) notes.push('No canonical URL is set, so the post has no link back to your site.');
  if (input.tags.length > hashtags.length) notes.push(`Kept the first ${hashtags.length} of ${input.tags.length} tags as hashtags.`);

  if (platform === 'x') {
    const first = fitText('x', hook, 280);
    const second = points.length ? points.map((p) => `• ${p}`).join('\n') : '';
    const last = [link ? `Full write-up: ${link}` : '', tagLine].filter(Boolean).join('\n');
    const posts = [first, second ? fitText('x', second, 280) : '', last ? fitText('x', last, 280) : ''].filter(Boolean);
    return { text: posts.join('\n---\n'), hashtags, notes: [...notes, 'The link is in the last post only: a post with a link costs more through the API.'] };
  }
  if (platform === 'linkedin') {
    const title = input.title.trim();
    const parts = [title && title !== hook ? title : '', hook, points.length ? points.map((p) => `• ${p}`).join('\n') : '', link ? `Read the full post: ${link}` : '', tagLine].filter(Boolean);
    return { text: fitText('linkedin', parts.join('\n\n'), limit), hashtags, notes };
  }
  // Bluesky, Threads, Mastodon: one post that fits.
  const tail = [link ?? '', tagLine].filter(Boolean).join('\n');
  const reserve = tail ? countPost(platform, `\n\n${tail}`) : 0;
  const pointsText = points.length ? points.map((p) => `- ${p}`).join('\n') : '';
  let body = hook;
  if (pointsText && countPost(platform, `${hook}\n\n${pointsText}`) + reserve <= limit) body = `${hook}\n\n${pointsText}`;
  body = fitText(platform, body, Math.max(limit - reserve, 20));
  return { text: tail ? `${body}\n\n${tail}` : body, hashtags, notes };
}

/** A video description: hook, key points, link and a few hashtags. Chapters cannot be made without the video. */
export function adaptVideoDescription(input: ShortFormInput): string {
  const hook = input.description.trim() || firstSentence(input.bodyMarkdown) || input.title.trim();
  const points = keyPoints(input.bodyMarkdown, 5);
  const tags = input.tags.map(toHashtag).filter(Boolean).slice(0, 3).map((t) => `#${t}`).join(' ');
  return [hook, points.length ? `In this video:\n${points.map((p) => `- ${p}`).join('\n')}` : '', input.canonicalUrl ? `Written version: ${input.canonicalUrl}` : '', tags].filter(Boolean).join('\n\n');
}

/** Chapters as YouTube reads them: lines that start with a timestamp. */
export function chaptersIn(description: string): { seconds: number; label: string }[] {
  const out: { seconds: number; label: string }[] = [];
  for (const line of description.split(/\r?\n/)) {
    const match = /^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    out.push({ seconds: Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]), label: match[4]! });
  }
  return out;
}

/** Problems with chapters, or none. YouTube needs a first chapter at 0:00, three or more, each at least 10 seconds. */
export function chapterProblems(description: string): string[] {
  const chapters = chaptersIn(description);
  if (chapters.length === 0) return [];
  const problems: string[] = [];
  if (chapters[0]!.seconds !== 0) problems.push('The first chapter must start at 0:00.');
  if (chapters.length < 3) problems.push('YouTube needs at least three chapters.');
  for (let i = 1; i < chapters.length; i++) {
    if (chapters[i]!.seconds - chapters[i - 1]!.seconds < 10) {
      problems.push('Each chapter must be at least 10 seconds long.');
      break;
    }
  }
  return problems;
}
