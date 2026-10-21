import type { Authorship, DraftKind, DraftStatus, PlatformId, RouteKind } from './ids.js';
import type { PortableDoc } from './portable-doc.js';

export const CATEGORIES = ['engineering', 'case-study', 'productivity', 'community'] as const;
export type Category = (typeof CATEGORIES)[number];

/** Post frontmatter, validated by `parsePost`. `date` is an ISO calendar date (YYYY-MM-DD). */
export interface Frontmatter {
  title: string;
  date: string;
  category: Category;
  tags: string[];
  description: string;
  published: boolean;
  coverImage: string;
}

/** The "Publishing package" notes that sit next to a post (spec 2.4). */
export interface PublishingPackage {
  primaryTitle?: string;
  alternateTitles: string[];
  metaTitle?: string;
  metaDescription: string;
  excerpt: string;
  ogText?: string;
  socialVisualConcept?: string;
  searchIntent?: string;
  keyEntities: string[];
  internalLinks?: string;
  furtherReading?: string;
  factLabels: string[];
  /** Shown as a checklist that blocks approval. */
  verifyBeforePublishing: string[];
}

export type Slug = string;

export interface ContentItem {
  slug: Slug;
  /** https://www.example-blog.dev/blog/<slug>, never with UTM. */
  canonicalUrl: string;
  frontmatter: Frontmatter;
  /** Absolute URL of the .png twin of the cover; the SVG is never uploaded. */
  coverPngUrl: string;
  /** MDX lowered to a neutral AST. */
  doc: PortableDoc;
  notes?: PublishingPackage;
  source: { repoCommit: string; mdxSha256: string; notesSha256?: string; dirty: boolean };
  /** ISO time the live check first passed (install day for old posts). */
  canonicalLiveAt?: string;
  /** Launch reference time, per the T0 rule in spec 2.3. */
  t0?: string;
}

export interface LintResult {
  rule: string;
  severity: 'error' | 'warning';
  message: string;
}

/**
 * One row of the drafts table: one per (content, platform, account, variant), spec 2.4.
 * `payloadSha256` is the payloadHash of the platform, account, route, payload, media hashes and
 * scheduledAt, so an approval bound to it cannot outlive an edit.
 */
export interface Draft<P = unknown> {
  id: string;
  slug: Slug;
  platform: PlatformId;
  account: string;
  route: RouteKind;
  kind: DraftKind;
  status: DraftStatus;
  payload: P;
  payloadSha256: string;
  authorship: Authorship;
  lint: LintResult[];
  /** SEO delay (spec section 5), computed from the content t0. ISO time. */
  notBefore?: string;
  /** ISO time the post is meant to go out, when scheduled. */
  scheduledAt?: string;
  /** Private remote draft id (dev.to article id, Buffer draft id). */
  remoteRef?: string;
  /** Set when a platform scheduler holds the post (Buffer customScheduled, YouTube publishAt). */
  remoteScheduledId?: string;
  createdAt: string;
  updatedAt: string;
  failureReason?: string;
  /** The post's mdx hash when the draft was built (the content row's `mdxSha256` at create time). */
  sourceMdxSha256?: string;
  /** The notes hash when the draft was built; absent when the post had no notes. */
  sourceNotesSha256?: string;
}
