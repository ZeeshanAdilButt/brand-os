/**
 * Article vocabulary and small pure helpers shared by the schema, validation, the studio UI and
 * the import code. No server imports, so client components can use it. Labels are user-facing copy.
 */

export const ARTICLE_STATUSES = ['draft', 'ready', 'archived'] as const;
export type ArticleStatus = (typeof ARTICLE_STATUSES)[number];

export const ARTICLE_SOURCE_KINDS = ['manual', 'file', 'url', 'folder'] as const;
export type ArticleSourceKind = (typeof ARTICLE_SOURCE_KINDS)[number];

export const VERSION_REASONS = ['autosave', 'manual', 'import', 'restore', 'agent', 'ai_accept'] as const;
export type VersionReason = (typeof VERSION_REASONS)[number];

export const STATUS_LABELS: Record<ArticleStatus, string> = {
  draft: 'Draft',
  ready: 'Ready',
  archived: 'Archived',
};

export const STATUS_HINTS: Record<ArticleStatus, string> = {
  draft: 'Still being written.',
  ready: 'Finished and waiting to be published.',
  archived: 'Kept for reference, hidden from the default list.',
};

export const SOURCE_KIND_LABELS: Record<ArticleSourceKind, string> = {
  manual: 'Written here',
  file: 'Imported from a file',
  url: 'Imported from a web page',
  folder: 'Imported from a folder',
};

export const REASON_LABELS: Record<VersionReason, string> = {
  autosave: 'Autosave',
  manual: 'Saved by you',
  import: 'Import',
  restore: 'Restored',
  agent: 'Saved by an agent',
  ai_accept: 'AI change you accepted',
};

/** Hard limits, enforced by the action layer and mirrored in the editor. */
export const LIMITS = {
  title: 200,
  slug: 100,
  description: 500,
  tags: 20,
  tag: 40,
  canonicalUrl: 2000,
  body: 300_000,
  /** A search query. */
  query: 200,
} as const;

/** Largest image the studio accepts. Enforced by the server; mirrored in the editor so a big file is refused before it is sent. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Autosaves closer together than this belong to one burst of editing and share one history entry. */
export const AUTOSAVE_BURST_MS = 10 * 60 * 1000;

/** Lower-case, hyphen-separated, ASCII-only slug. Never empty: falls back to "untitled". */
export function slugify(input: string): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LIMITS.slug)
    .replace(/-+$/g, '');
  return slug || 'untitled';
}

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Words in a Markdown body, ignoring fenced code markers, for the word count and reading time. */
export function countWords(markdown: string): number {
  const text = markdown
    .replace(/^```.*$/gm, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~|-]+/g, ' ');
  const matches = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’]*/gu);
  return matches ? matches.length : 0;
}

/** Whole minutes at 220 words per minute, at least 1 for any non-empty text. */
export function readingMinutes(words: number): number {
  return words === 0 ? 0 : Math.max(1, Math.round(words / 220));
}

/** An article as the browser sees it (dates arrive as ISO strings). */
export interface ArticleDTO {
  id: string;
  title: string;
  slug: string;
  description: string;
  tags: string[];
  canonicalUrl: string | null;
  coverAssetId: string | null;
  status: ArticleStatus;
  bodyMarkdown: string;
  sourceKind: ArticleSourceKind;
  sourceRef: string | null;
  extraMetadata: Record<string, unknown>;
  revision: number;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

export interface VersionSummaryDTO {
  id: string;
  versionNo: number;
  title: string;
  reason: VersionReason;
  createdAt: string;
  chars: number;
}

export interface VersionDTO {
  versionNo: number;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  reason: VersionReason;
  createdAt: string;
}

export interface AssetDTO {
  id: string;
  filename: string;
  mime: string;
  size: number;
  alt: string;
  url: string;
  markdown: string;
  createdAt: string;
}

/** Roughly how many minutes a body of this many characters takes to read (the list never loads bodies). */
export function approxReadingMinutes(chars: number): number {
  return chars === 0 ? 0 : Math.max(1, Math.round(chars / 6 / 220));
}
