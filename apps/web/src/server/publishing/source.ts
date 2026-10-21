import { createHash } from 'node:crypto';
import type { DraftExtras, DraftPayload, PlatformId } from '../../lib/publishing';

/** JSON with sorted keys, so equal values always hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The article fields a platform draft is built from. A change to any of them makes a draft stale. */
export interface ArticleSource {
  title: string;
  slug: string;
  description: string;
  tags: string[];
  canonicalUrl: string | null;
  coverAssetId: string | null;
  bodyMarkdown: string;
}

export function sourceHashOf(a: ArticleSource): string {
  return sha256(
    canonicalJson({
      title: a.title,
      slug: a.slug,
      description: a.description,
      tags: a.tags,
      canonicalUrl: a.canonicalUrl,
      coverAssetId: a.coverAssetId,
      bodyMarkdown: a.bodyMarkdown,
    }),
  );
}

/**
 * The hash an approval is bound to: the platform, the account it will be posted under, the exact payload and
 * any options bound to it (the personal site's path and file layout). Change any and the hash differs, so the
 * approval no longer applies.
 */
export function payloadHashOf(platform: PlatformId, account: string | null, payload: DraftPayload, extras: DraftExtras = {}): string {
  // Extras join the hash only when there are some, so every hash made before they existed stays the same.
  const hasExtras = Object.keys(extras).length > 0;
  return sha256(canonicalJson(hasExtras ? { platform, account, payload, extras } : { platform, account, payload }));
}
