const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Length in user-perceived characters (grapheme clusters), which is how platforms count. */
export function graphemeLength(s: string): number {
  let count = 0;
  for (const _ of segmenter.segment(s)) count += 1;
  return count;
}

// Stops at whitespace, quotes, angle brackets and closing brackets, so `[x](url)` and `(url)` work.
const URL_PATTERN = /https?:\/\/[^\s<>"'\])]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/** Every http(s) URL in the text, in order, duplicates kept, without trailing sentence punctuation. */
export function countLinks(s: string): string[] {
  return (s.match(URL_PATTERN) ?? []).map((url) => url.replace(TRAILING_PUNCTUATION, ''));
}

/** The text with every URL replaced by a space (used so URL digits never count as numbers). */
export function stripUrls(s: string): string {
  return s.replace(URL_PATTERN, ' ');
}
