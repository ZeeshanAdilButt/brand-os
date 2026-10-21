import { stripUrls } from './text.js';

// Either a thousands-grouped number (1,234 / 1,234,567.5) or a plain integer/decimal.
// Letters may touch the digits (p99.9, x12, 12%, 95th).
const NUMBER = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

function normalize(token: string): string {
  const [whole = '', fraction] = token.replace(/,/g, '').split('.');
  const integer = whole.replace(/^0+(?=\d)/, '');
  const trimmed = fraction?.replace(/0+$/, '');
  return trimmed ? `${integer}.${trimmed}` : integer;
}

/**
 * Numbers in the text, normalised (`1,000` -> `1000`, `p99.9` -> `99.9`, `12%` -> `12`,
 * `45.0` -> `45`, `95th` -> `95`), in order of appearance. Anything inside a URL is ignored.
 * Ordinals count as numbers: "the 95th percentile" must not pass as "the 99th percentile".
 */
export function extractNumbers(s: string): string[] {
  const text = stripUrls(s);
  const found: string[] = [];
  for (const match of text.matchAll(NUMBER)) found.push(normalize(match[0]));
  return found;
}

/**
 * Numbers in `text` that appear in none of the `sources`, each reported once in order of first
 * appearance. Single digits 0-9 are allowed without a source (counts like "3 points").
 */
export function findUnsourcedNumbers(text: string, sources: string[]): string[] {
  const sourced = new Set(sources.flatMap(extractNumbers));
  const unsourced: string[] = [];
  for (const n of extractNumbers(text)) {
    if (/^\d$/.test(n) || sourced.has(n) || unsourced.includes(n)) continue;
    unsourced.push(n);
  }
  return unsourced;
}
