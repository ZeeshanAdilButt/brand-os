import { createHash } from 'node:crypto';
import { parsePost } from './frontmatter.js';
import { lowerMdx } from './lower-mdx.js';
import { normalizeText } from './normalize.js';
import { parsePublishingNotes } from './notes.js';
import { canonicalUrlFor, coverPngUrl } from './urls.js';
import type { ContentItem } from './model.js';

export interface BuildContentItemInput {
  slug: string;
  /** The post file exactly as read from disk (BOM and CRLF are fine). */
  mdxRaw: string;
  /** The publishing-notes file, when the post has one. */
  notesRaw?: string;
  repoCommit: string;
  dirty: boolean;
  baseUrl: string;
}

// Hashed after normalisation, so the same post gives the same hash on a CRLF and an LF checkout.
const sha256 = (raw: string): string => createHash('sha256').update(normalizeText(raw), 'utf8').digest('hex');

/**
 * Build the canonical content model (spec 2.4) from a post and its optional notes.
 * `canonicalLiveAt` and `t0` are left unset: they come from the live check, not from the files.
 * Throws `PostParseError`, `NotesParseError` or the MDX parser's error.
 */
export function buildContentItem(input: BuildContentItemInput): ContentItem {
  const { slug, mdxRaw, notesRaw, repoCommit, dirty, baseUrl } = input;
  const { frontmatter, body } = parsePost(mdxRaw);
  const canonicalUrl = canonicalUrlFor(slug, baseUrl);
  const doc = lowerMdx(body, { baseUrl, canonicalUrl });
  const notes = notesRaw === undefined ? undefined : parsePublishingNotes(notesRaw);

  return {
    slug,
    canonicalUrl,
    frontmatter,
    coverPngUrl: coverPngUrl(frontmatter.coverImage, baseUrl),
    doc,
    ...(notes === undefined ? {} : { notes }),
    source: {
      repoCommit,
      mdxSha256: sha256(mdxRaw),
      ...(notesRaw === undefined ? {} : { notesSha256: sha256(notesRaw) }),
      dirty,
    },
  };
}
