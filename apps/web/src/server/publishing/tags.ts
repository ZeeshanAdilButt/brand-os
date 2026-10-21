import type { TagReport } from '../../lib/publishing';

/** Lower-case letters and digits only: the form DEV.to tags take. "C++" becomes "c", "node.js" becomes "nodejs". */
export function devtoTag(raw: string, maxChars: number): string {
  return raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, maxChars);
}

/** A Hashnode tag slug: lower-case words joined by single hyphens. */
export function hashnodeSlug(raw: string, maxChars: number): string {
  return raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxChars)
    .replace(/-+$/g, '');
}

/**
 * Turn the article's tags into what a platform takes, and say what changed. Nothing is dropped silently:
 * a tag that changes form, vanishes or repeats gets a line in the report, and a list that is still too
 * long is left long so the lint can refuse it, instead of quietly losing tags.
 */
export function sanitizeTags(original: string[], convert: (raw: string) => string): TagReport {
  const sent: string[] = [];
  const changes: string[] = [];
  for (const raw of original) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const next = convert(trimmed);
    if (!next) {
      changes.push(`“${trimmed}” has no usable characters and was dropped.`);
      continue;
    }
    if (sent.includes(next)) {
      changes.push(`“${trimmed}” became “${next}”, which is already in the list, so it was dropped.`);
      continue;
    }
    if (next !== trimmed) changes.push(`“${trimmed}” became “${next}”.`);
    sent.push(next);
  }
  return { original: [...original], sent, changes };
}
