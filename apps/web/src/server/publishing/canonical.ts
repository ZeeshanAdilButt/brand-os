import type { CanonicalState } from '../../lib/publishing';
import { fetchPage, UrlImportError, type UrlImportDeps } from '../import/url';

/**
 * Is the canonical page live? Copies on DEV.to, Hashnode and elsewhere point at it, so they should not go out
 * first. The check uses the same SSRF-safe fetcher as the article importer (public addresses only, redirects
 * re-checked, no cookies, capped size and time) and says what it found in words.
 *
 * Live means: the page answers 200 with an HTML or text body, has a <title>, and ends up on the host the owner
 * configured for their site (or, with no site configured, on the host of the canonical address itself, so a
 * redirect to somewhere else does not count).
 */

export interface CanonicalResult {
  state: CanonicalState;
  httpStatus: number | null;
  title: string | null;
  finalUrl: string | null;
  message: string;
}

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
};

export function titleOf(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return null;
  const text = match[1]!.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 200) : null;
}

export async function checkCanonicalPage(canonicalUrl: string, siteHost: string | null, deps: UrlImportDeps = {}): Promise<CanonicalResult> {
  const expected = siteHost ? siteHost.toLowerCase().replace(/^www\./, '') : hostOf(canonicalUrl);
  const own = hostOf(canonicalUrl);
  if (siteHost && own !== expected) {
    return {
      state: 'not_live',
      httpStatus: null,
      title: null,
      finalUrl: null,
      message: `The canonical URL is on ${own ?? 'another host'}, but your site is ${siteHost}. Copies should point to your own site.`,
    };
  }
  try {
    const page = await fetchPage(canonicalUrl, deps);
    const finalHost = hostOf(page.finalUrl.toString());
    const html = new TextDecoder('utf-8', { fatal: false }).decode(page.body.slice(0, 200_000));
    const title = titleOf(html);
    if (finalHost !== expected) {
      return { state: 'not_live', httpStatus: 200, title, finalUrl: page.finalUrl.toString(), message: `The page redirects to ${finalHost ?? 'another host'}, not ${expected}.` };
    }
    if (!title) {
      return { state: 'not_live', httpStatus: 200, title: null, finalUrl: page.finalUrl.toString(), message: 'The page answered but has no title, so it does not look like a finished post.' };
    }
    return { state: 'live', httpStatus: 200, title, finalUrl: page.finalUrl.toString(), message: `Live: “${title}”.` };
  } catch (err) {
    if (!(err instanceof UrlImportError)) return { state: 'unreachable', httpStatus: null, title: null, finalUrl: null, message: 'The page could not be checked.' };
    if (err.code === 'blocked' || err.code === 'invalid_url') {
      return { state: 'blocked', httpStatus: null, title: null, finalUrl: null, message: `The page was not fetched: ${err.message}` };
    }
    if (err.code === 'bad_status') {
      return { state: 'not_live', httpStatus: err.status ?? null, title: null, finalUrl: null, message: `The page answered ${err.status ?? 'an error'}, so it is not live yet.` };
    }
    if (err.code === 'bad_type') return { state: 'not_live', httpStatus: 200, title: null, finalUrl: null, message: err.message };
    return { state: 'unreachable', httpStatus: null, title: null, finalUrl: null, message: `The page could not be reached: ${err.message}` };
  }
}
