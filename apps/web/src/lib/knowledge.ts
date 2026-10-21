/**
 * Knowledge vocabulary shared by the database schema, validation and the UI. Plain data with no
 * server imports, so client components can use it. Labels are user-facing copy.
 */

export const SOURCE_KINDS = ['manual', 'url', 'article', 'resume', 'github', 'owner_provided'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const ITEM_KINDS = ['fact', 'achievement', 'experience', 'project', 'reading', 'certification', 'note'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const VERIFICATION_STATUSES = ['verified', 'owner_claim_needs_review', 'unverified'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export const CONFIDENTIALITY_LEVELS = ['private', 'internal', 'public'] as const;
export type Confidentiality = (typeof CONFIDENTIALITY_LEVELS)[number];

export const KIND_LABELS: Record<ItemKind, string> = {
  fact: 'Fact',
  achievement: 'Achievement',
  experience: 'Experience',
  project: 'Project',
  reading: 'Reading',
  certification: 'Certification',
  note: 'Note',
};

export const VERIFICATION_LABELS: Record<VerificationStatus, string> = {
  verified: 'Verified',
  owner_claim_needs_review: 'Needs review',
  unverified: 'Unverified',
};

export const CONFIDENTIALITY_LABELS: Record<Confidentiality, string> = {
  private: 'Private',
  internal: 'Internal',
  public: 'Public',
};

export const CONFIDENCE_LABELS: Record<Confidence, string> = { low: 'Low', medium: 'Medium', high: 'High' };

export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  manual: 'Typed by hand',
  url: 'Web page',
  article: 'Article',
  resume: 'Resume',
  github: 'GitHub',
  owner_provided: 'Provided by the owner',
};

/** Control characters that cannot occur in normal text; the search layer wraps matches in them. */
export const MARK_START = '\u0001';
export const MARK_END = '\u0002';

export interface MarkedSegment {
  text: string;
  match: boolean;
}

/** Split text produced by the search layer into plain and matched segments. No HTML is involved. */
export function splitMarked(text: string): MarkedSegment[] {
  const segments: MarkedSegment[] = [];
  let match = false;
  let buffer = '';
  for (const char of text) {
    if (char === MARK_START || char === MARK_END) {
      if (buffer) segments.push({ text: buffer, match });
      buffer = '';
      match = char === MARK_START;
    } else {
      buffer += char;
    }
  }
  if (buffer) segments.push({ text: buffer, match });
  return segments;
}
