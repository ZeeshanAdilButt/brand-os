import { countLinks, graphemeLength, stripUrls } from '../lint/text.js';
import { findUnsourcedNumbers } from '../lint/numbers.js';
import { withUtm } from '../urls.js';
import type { ContentItem, LintResult } from '../model.js';
import type { Transform } from './types.js';

/**
 * The LinkedIn post payload. `link` is the Buffer `linkAttachment` card. It is optional because it
 * is gated by config `platforms.linkedin.linkCard` (spec 5.3, spike S2(e)): when the card is off the
 * key is absent, so the approval hash never covers a field the route does not send.
 */
export interface LinkedinPayload {
  text: string;
  link?: { url: string; title: string; description: string; thumbnailUrl: string };
}

export interface LinkedinTransformOptions {
  /** `platforms.linkedin.linkCard` from config. Default false until S2(e) confirms the field. */
  linkCard: boolean;
}

/** UNVERIFIED (spec 5.3, 02 section 6): 3,000 characters is the widely reported post limit. */
export const LINKEDIN_MAX_GRAPHEMES = 3000;
export const LINKEDIN_MIN_TAKEAWAY_LINES = 3;
export const LINKEDIN_MIN_TAKEAWAY_GRAPHEMES = 400;
export const LINKEDIN_MAX_HASHTAGS = 5;
export const LINKEDIN_MAX_EMOJI = 3;

const HASHTAG = /(?<![\p{L}\p{N}_#])#[\p{L}\p{N}_]+/gu;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

function countEmoji(s: string): number {
  let count = 0;
  for (const { segment } of segmenter.segment(s)) if (PICTOGRAPH.test(segment)) count += 1;
  return count;
}

/** Every free-text field of the notes, as sources for numeric provenance. */
function noteSources(item: ContentItem): string[] {
  const n = item.notes;
  if (n === undefined) return [];
  const fields: (string | string[] | undefined)[] = [
    n.primaryTitle,
    n.alternateTitles,
    n.metaTitle,
    n.metaDescription,
    n.excerpt,
    n.ogText,
    n.socialVisualConcept,
    n.searchIntent,
    n.keyEntities,
    n.internalLinks,
    n.furtherReading,
    n.factLabels,
    n.verifyBeforePublishing,
  ];
  return fields.flatMap((field) => (field === undefined ? [] : Array.isArray(field) ? field : [field]));
}

const error = (rule: string, message: string): LintResult => ({ rule, severity: 'error', message });
const warning = (rule: string, message: string): LintResult => ({ rule, severity: 'warning', message });

export function createLinkedinTransform(options: LinkedinTransformOptions): Transform<LinkedinPayload> {
  const { linkCard } = options;
  const expectedLink = (item: ContentItem): string => withUtm(item.canonicalUrl, 'linkedin', item.slug);

  return {
    platform: 'linkedin',
    kind: 'post',

    skeleton(item: ContentItem): LinkedinPayload {
      const url = expectedLink(item);
      const lead = item.notes?.excerpt || item.frontmatter.description;
      const payload: LinkedinPayload = { text: `${lead}\n\n${url}` };
      if (!linkCard) return payload;
      return {
        ...payload,
        link: {
          url,
          title: item.notes?.primaryTitle || item.frontmatter.title,
          description: item.notes?.metaDescription || item.frontmatter.description,
          thumbnailUrl: item.coverPngUrl,
        },
      };
    },

    lint(p: LinkedinPayload, item: ContentItem): LintResult[] {
      const results: LintResult[] = [];
      const expected = expectedLink(item);
      const links = countLinks(p.text);

      const length = graphemeLength(p.text);
      if (length > LINKEDIN_MAX_GRAPHEMES) {
        results.push(
          error('li-length', `The post is ${length} characters; the LinkedIn limit is ${LINKEDIN_MAX_GRAPHEMES} (unverified).`),
        );
      }

      if (links.length !== 1) {
        results.push(error('li-one-link', `The post must contain exactly one link, found ${links.length}.`));
      } else if (links[0] !== expected) {
        results.push(error('li-one-link', `The link must be exactly ${expected}, got ${links[0]}.`));
      }
      if (!linkCard && p.link !== undefined) {
        results.push(
          error(
            'li-link-card-disabled',
            'platforms.linkedin.linkCard is off, so a link card must not be set: LinkedIn builds the preview from the page OG tags.',
          ),
        );
      }
      if (p.link !== undefined && p.link.url !== expected) {
        results.push(error('li-one-link', `link.url must be exactly ${expected}, got ${p.link.url}.`));
      }

      for (const url of links) {
        const params = safeParams(url);
        const ok =
          params?.get('utm_source') === 'linkedin' &&
          params.get('utm_medium') === 'social' &&
          params.get('utm_campaign') === item.slug;
        if (!ok) {
          results.push(
            error('li-utm', `${url} must carry utm_source=linkedin, utm_medium=social and utm_campaign=${item.slug}.`),
          );
        }
      }

      // The link (and its digits) is not takeaway: count lines and characters without URLs.
      const body = stripUrls(p.text);
      const lines = body.split(/\r?\n/).filter((line) => line.trim() !== '');
      const bodyLength = graphemeLength(body.trim());
      if (lines.length < LINKEDIN_MIN_TAKEAWAY_LINES || bodyLength < LINKEDIN_MIN_TAKEAWAY_GRAPHEMES) {
        results.push(
          error(
            'li-takeaway',
            `A complete takeaway needs at least ${LINKEDIN_MIN_TAKEAWAY_LINES} lines and ${LINKEDIN_MIN_TAKEAWAY_GRAPHEMES} characters besides the link; this has ${lines.length} lines and ${bodyLength} characters.`,
          ),
        );
      }

      const sources = [
        item.doc.plainText,
        item.frontmatter.title,
        item.frontmatter.description,
        ...noteSources(item),
      ];
      const unsourced = findUnsourcedNumbers(p.text, sources);
      if (unsourced.length > 0) {
        results.push(
          error('li-numbers', `Numbers not found in the article or its notes: ${unsourced.join(', ')}.`),
        );
      }

      const hashtags = stripUrls(p.text).match(HASHTAG) ?? [];
      if (hashtags.length > LINKEDIN_MAX_HASHTAGS) {
        results.push(
          warning('li-hashtag-wall', `${hashtags.length} hashtags; keep it to ${LINKEDIN_MAX_HASHTAGS} or fewer.`),
        );
      }

      const emoji = countEmoji(p.text);
      if (emoji > LINKEDIN_MAX_EMOJI) {
        results.push(warning('li-emoji-wall', `${emoji} emoji; keep it to ${LINKEDIN_MAX_EMOJI} or fewer.`));
      }

      return results;
    },
  };
}

function safeParams(url: string): URLSearchParams | undefined {
  try {
    return new URL(url).searchParams;
  } catch {
    return undefined;
  }
}

/** Default instance: no link card, because the `linkAttachment` fields are unconfirmed (spike S2(e)). */
export const linkedinTransform: Transform<LinkedinPayload> = createLinkedinTransform({ linkCard: false });
