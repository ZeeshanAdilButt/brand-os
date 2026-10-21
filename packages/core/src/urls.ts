import type { PlatformId } from './ids.js';

export const DEFAULT_BASE_URL = 'https://www.example-blog.dev';

const trimTrailingSlashes = (url: string): string => url.replace(/\/+$/, '');

/** `${base}/blog/${slug}`. Never carries UTM parameters. */
export function canonicalUrlFor(slug: string, baseUrl: string = DEFAULT_BASE_URL): string {
  return `${trimTrailingSlashes(baseUrl)}/blog/${slug}`;
}

/** Site-relative paths become absolute; URLs that already have a scheme are unchanged. */
export function absolutize(src: string, baseUrl: string = DEFAULT_BASE_URL): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return src;
  if (src.startsWith('//')) return `https:${src}`;
  return `${trimTrailingSlashes(baseUrl)}/${src.replace(/^\/+/, '')}`;
}

/** Absolute URL of the cover's `.png` twin. The SVG itself is never used. */
export function coverPngUrl(coverImage: string, baseUrl: string = DEFAULT_BASE_URL): string {
  return absolutize(coverImage, baseUrl).replace(/\.svg(?=$|[?#])/i, '.png');
}

/** Adds `utm_source=<platform>&utm_medium=social&utm_campaign=<slug>`, replacing any existing utm_* values. */
export function withUtm(url: string, platform: PlatformId, slug: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('utm_source', platform);
  parsed.searchParams.set('utm_medium', 'social');
  parsed.searchParams.set('utm_campaign', slug);
  return parsed.toString();
}
