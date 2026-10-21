import type { ContentItem } from '@cph/core';

/** The only host a canonical page may end up on. The apex redirects here, and must never be accepted. */
export const CANONICAL_HOST = 'www.example-blog.dev';

/** One hung connection must not stall a whole sync. */
export const LIVE_CHECK_TIMEOUT_MS = 15_000;

export interface LiveCheckResult {
  ok: boolean;
  /** HTTP status of the final response, or 0 when there was none (network failure, not published). */
  status: number;
  /** The URL after redirects (the requested URL when the response carries none). */
  finalUrl: string;
  reason?: 'not-published' | 'status' | 'host' | 'title-missing' | 'network';
}

// Named references a Next.js page (or any CMS) is likely to emit. An unknown name is left as typed:
// guessing would turn an unrelated page into a title match.
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  bull: '•',
  middot: '·',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  times: '×',
  divide: '÷',
  plusmn: '±',
  larr: '←',
  rarr: '→',
  harr: '↔',
  rArr: '⇒',
  minus: '−',
  le: '≤',
  ge: '≥',
  ne: '≠',
  asymp: '≈',
  rho: 'ρ',
  mu: 'μ',
  lambda: 'λ',
  sigma: 'σ',
  pi: 'π',
  alpha: 'α',
  beta: 'β',
  delta: 'δ',
  Delta: 'Δ',
  Sigma: 'Σ',
  Omega: 'Ω',
  omega: 'ω',
  infin: '∞',
  sum: '∑',
  shy: '­',
  thinsp: ' ',
  ensp: ' ',
  emsp: ' ',
};

const ENTITY = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));/g;

function fromCodePoint(code: number, original: string): string {
  // Zero, surrogates and anything past U+10FFFF are not characters: leave the text as written.
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return original;
  return String.fromCodePoint(code);
}

/** Decodes named, decimal and hex character references in ONE pass (so `&amp;#39;` stays `&#39;`). */
export function decodeHtmlEntities(text: string): string {
  return text.replace(ENTITY, (match, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (dec !== undefined) return fromCodePoint(Number.parseInt(dec, 10), match);
    if (hex !== undefined) return fromCodePoint(Number.parseInt(hex, 16), match);
    return (name !== undefined ? NAMED_ENTITIES[name] : undefined) ?? match;
  });
}

/**
 * The canonical-live gate (spec 2.3, Review Focus #3). A post "looks live" only when ALL hold:
 * the frontmatter says `published: true`; the redirect-followed URL is on `www.example-blog.dev`
 * (an apex redirect is a failure); the status is 200; and the page, with HTML entities decoded,
 * contains the RAW frontmatter title (a soft-404 returns 200 without it).
 *
 * The title is never escaped for the comparison: the response is decoded instead, because Next.js
 * may escape apostrophes and quotes differently from any escaper of ours. `fetchFn` is injected.
 * The request aborts after `timeoutMs` (default 15 s) and then reports `network`.
 */
export async function checkCanonicalLive(
  item: ContentItem,
  fetchFn: typeof fetch,
  timeoutMs: number = LIVE_CHECK_TIMEOUT_MS,
): Promise<LiveCheckResult> {
  const requested = item.canonicalUrl;
  if (!item.frontmatter.published) {
    return { ok: false, status: 0, finalUrl: requested, reason: 'not-published' };
  }

  // The signal covers the connection AND the body read, so a stalled response ends as `network`.
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetchFn(requested, { redirect: 'follow', signal });
  } catch {
    return { ok: false, status: 0, finalUrl: requested, reason: 'network' };
  }
  const status = response.status;
  const finalUrl = response.url !== '' ? response.url : requested;

  let host: string | undefined;
  try {
    host = new URL(finalUrl).host;
  } catch {
    host = undefined;
  }
  if (host !== CANONICAL_HOST) {
    await discard(response);
    return { ok: false, status, finalUrl, reason: 'host' };
  }
  if (status !== 200) {
    await discard(response);
    return { ok: false, status, finalUrl, reason: 'status' };
  }

  let html: string;
  try {
    html = await response.text();
  } catch {
    return { ok: false, status, finalUrl, reason: 'network' };
  }
  if (!decodeHtmlEntities(html).includes(item.frontmatter.title)) {
    return { ok: false, status, finalUrl, reason: 'title-missing' };
  }
  return { ok: true, status, finalUrl };
}

/** Frees the connection of a response whose body is not needed. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // nothing to free
  }
}
