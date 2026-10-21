import { stringify } from 'yaml';

/**
 * The personal-site destination: turning a draft into one Markdown file with front matter, and the rules for
 * where that file goes. Pure (no I/O, no server imports) so the same code builds the downloadable export, the
 * file a pull request commits and the preview in the composer.
 */

export const SITE_PRESETS = ['generic', 'hugo', 'jekyll', 'mdx'] as const;
export type SitePreset = (typeof SITE_PRESETS)[number];

export const SITE_PRESET_LABELS: Record<SitePreset, string> = {
  generic: 'Generic (YAML front matter)',
  hugo: 'Hugo-style',
  jekyll: 'Jekyll-style',
  mdx: 'MDX-style',
};

export const DATE_FORMATS = ['date', 'iso', 'jekyll'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export const DATE_FORMAT_LABELS: Record<DateFormat, string> = {
  date: '2026-10-21',
  iso: '2026-10-21T09:30:00Z',
  jekyll: '2026-10-21 09:30:00 +0000',
};

/** Front matter keys for each piece of the post. An empty name leaves that piece out. */
export interface SiteFieldNames {
  title: string;
  description: string;
  date: string;
  tags: string;
  canonical: string;
  cover: string;
  slug: string;
  series: string;
  /** When named, `false` is written there (the post is not a draft). */
  draft: string;
}

export const SITE_FIELD_KEYS = ['title', 'description', 'date', 'tags', 'canonical', 'cover', 'slug', 'series', 'draft'] as const satisfies readonly (keyof SiteFieldNames)[];

export interface SiteMapping {
  preset: SitePreset;
  fields: SiteFieldNames;
  dateFormat: DateFormat;
  /** `.md` or `.mdx`: the extension `{ext}` expands to in the path template. */
  extension: 'md' | 'mdx';
  /** Fixed keys added to every file, for example `layout: post`. Values are text or true/false. */
  fixed: { key: string; value: string | boolean }[];
}

export const SITE_LIMITS = {
  fieldName: 40,
  fixedKeys: 10,
  fixedValue: 200,
  pathTemplate: 200,
  repo: 140,
  branch: 100,
} as const;

export const DEFAULT_PATH_TEMPLATE = 'content/posts/{slug}.md';

const FIELDS: Record<SitePreset, SiteFieldNames> = {
  generic: { title: 'title', description: 'description', date: 'date', tags: 'tags', canonical: 'canonical_url', cover: 'cover_image', slug: 'slug', series: 'series', draft: '' },
  hugo: { title: 'title', description: 'description', date: 'date', tags: 'tags', canonical: 'canonicalURL', cover: 'image', slug: 'slug', series: 'series', draft: 'draft' },
  jekyll: { title: 'title', description: 'description', date: 'date', tags: 'tags', canonical: 'canonical_url', cover: 'image', slug: '', series: '', draft: '' },
  mdx: { title: 'title', description: 'description', date: 'date', tags: 'tags', canonical: 'canonical', cover: 'image', slug: 'slug', series: 'series', draft: '' },
};

/** The starting mapping for a preset. Every part can be edited afterwards. */
export function presetMapping(preset: SitePreset): SiteMapping {
  return {
    preset,
    fields: { ...FIELDS[preset] },
    dateFormat: preset === 'hugo' ? 'iso' : preset === 'jekyll' ? 'jekyll' : 'date',
    extension: preset === 'mdx' ? 'mdx' : 'md',
    fixed: preset === 'jekyll' ? [{ key: 'layout', value: 'post' }] : [],
  };
}

export function defaultPathTemplate(preset: SitePreset): string {
  return preset === 'mdx' ? 'content/posts/{slug}.mdx' : preset === 'jekyll' ? '_posts/{year}-{month}-{day}-{slug}.md' : DEFAULT_PATH_TEMPLATE;
}

/** The Markdown-relevant part of a draft, as the export needs it. */
export interface SiteContent {
  title: string;
  description: string;
  tags: string[];
  canonicalUrl: string | null;
  coverImageUrl: string | null;
  series: string | null;
  bodyMarkdown: string;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Format an ISO timestamp (always in UTC, so the same draft gives the same file on every machine). */
export function formatDate(iso: string, format: DateFormat): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const day = `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
  const time = `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`;
  if (format === 'date') return day;
  if (format === 'iso') return `${day}T${time}Z`;
  return `${day} ${time} +0000`;
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Normalize line endings: files from Windows editors carry CRLF, and the repository should not. */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export interface SiteFile {
  /** The front matter block only, including the --- lines. */
  frontMatter: string;
  /** Front matter, a blank line and the body, ending with one newline. */
  content: string;
}

/** Build the file: front matter from the mapping, then the body exactly as written (LF line endings). */
export function renderSiteFile(content: SiteContent, mapping: SiteMapping, dateIso: string, slug: string): SiteFile {
  const f = mapping.fields;
  const data: Record<string, unknown> = {};
  const put = (name: string, value: unknown) => {
    if (name.trim() && value !== undefined && value !== null && value !== '') data[name.trim()] = value;
  };
  for (const fixed of mapping.fixed) put(fixed.key, fixed.value);
  put(f.title, oneLine(content.title));
  put(f.description, oneLine(content.description));
  put(f.date, formatDate(dateIso, mapping.dateFormat));
  if (content.tags.length > 0) put(f.tags, content.tags);
  put(f.canonical, content.canonicalUrl);
  put(f.cover, content.coverImageUrl);
  put(f.slug, slug);
  put(f.series, content.series?.trim() ? content.series.trim() : null);
  if (f.draft.trim()) data[f.draft.trim()] = false;

  const yaml = stringify(data, { lineWidth: 0, defaultStringType: 'PLAIN', defaultKeyType: 'PLAIN' }).replace(/\s+$/, '');
  const frontMatter = `---\n${yaml}\n---`;
  const body = normalizeEol(content.bodyMarkdown).replace(/^\n+/, '').replace(/\s+$/, '');
  return { frontMatter, content: `${frontMatter}\n\n${body}\n` };
}

/** Lower-case words joined by hyphens, the form a slug takes in a file name. */
export function slugForPath(slug: string): string {
  return slug
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

export type PathResult = { ok: true; path: string } | { ok: false; reason: string };

/** Fill `{slug}`, `{year}`, `{month}`, `{day}` and `{ext}` and refuse anything that could leave the repository folder. */
export function resolvePathTemplate(template: string, vars: { slug: string; dateIso: string; extension: 'md' | 'mdx' }): PathResult {
  const text = template.trim();
  if (!text) return { ok: false, reason: 'The path template is empty.' };
  if (text.length > SITE_LIMITS.pathTemplate) return { ok: false, reason: `The path template is longer than ${SITE_LIMITS.pathTemplate} characters.` };
  const at = new Date(vars.dateIso);
  const stamp = Number.isNaN(at.getTime()) ? new Date(0) : at;
  const unknown = [...text.matchAll(/\{([^}]*)\}/g)].map((m) => m[1] ?? '').filter((name) => !['slug', 'year', 'month', 'day', 'ext'].includes(name));
  if (unknown.length > 0) return { ok: false, reason: `Unknown placeholder {${unknown[0]}}. Use {slug}, {year}, {month}, {day} or {ext}.` };
  if (!vars.slug) return { ok: false, reason: 'The article has no usable slug for the file name.' };
  const path = text
    .replace(/\{slug\}/g, vars.slug)
    .replace(/\{year\}/g, String(stamp.getUTCFullYear()))
    .replace(/\{month\}/g, pad(stamp.getUTCMonth() + 1))
    .replace(/\{day\}/g, pad(stamp.getUTCDate()))
    .replace(/\{ext\}/g, vars.extension);
  return validateRepoPath(path);
}

/** Refuse a path that could leave the repository folder or name something that is not a post file. */
export function validateRepoPath(path: string): PathResult {
  if (!path || path.length > 300) return { ok: false, reason: 'The path is empty or too long.' };
  if (path.startsWith('/') || path.includes('\\') || /(^|\/)\.\.?(\/|$)/.test(path) || /[\0-\x1f:*?"<>|]/.test(path) || path.includes('//')) {
    return { ok: false, reason: 'The path must be a relative path inside the repository, with no "..", backslashes or special characters.' };
  }
  if (/(^|\/)\.git(\/|$)/i.test(path)) return { ok: false, reason: 'The path cannot point into .git.' };
  if (path.endsWith('/')) return { ok: false, reason: 'The path must end in a file name.' };
  if (!/\.(md|mdx|markdown)$/i.test(path)) return { ok: false, reason: 'The file name must end in .md, .mdx or .markdown.' };
  return { ok: true, path };
}

/** A repository as "owner/name". */
export function parseRepo(text: string): { owner: string; name: string } | null {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(text.trim());
  if (!match) return null;
  const name = match[2]!;
  if (name === '.' || name === '..' || name.endsWith('.git')) return null;
  return { owner: match[1]!, name };
}

/** A branch name git would accept, kept to the safe subset the app uses. */
export function isSafeBranch(name: string): boolean {
  if (!name || name.length > SITE_LIMITS.branch) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) return false;
  if (name.startsWith('/') || name.endsWith('/') || name.startsWith('-') || name.endsWith('.') || name.endsWith('.lock')) return false;
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false;
  return true;
}

/** The branch a pull request for this payload uses: brand-os/<slug>-<first 8 hex of the payload hash>. */
export function branchNameFor(slug: string, payloadSha256: string): string {
  const base = slugForPath(slug) || 'post';
  return `brand-os/${base}-${payloadSha256.slice(0, 8).toLowerCase()}`;
}

/** Things that will break or surprise when this body lands in a site built with MDX. Warnings, not errors. */
export function mdxHazards(markdown: string): string[] {
  const prose = markdown
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm, ' ')
    .replace(/`[^`\n]*`/g, ' ');
  const found: string[] = [];
  if (/\{[^}\n]*\}/.test(prose)) found.push('Curly braces { } outside code are read as JavaScript expressions in MDX.');
  if (/<[A-Za-z][^>]*>/.test(prose)) found.push('HTML or angle-bracket text outside code is read as JSX in MDX and must be well formed.');
  if (/<!--/.test(prose)) found.push('HTML comments are not valid in MDX.');
  return found;
}

/** The persisted settings of the personal site, as the browser and the export see them. */
export interface SiteSettingsDTO {
  siteUrl: string | null;
  repo: string | null;
  baseBranch: string;
  pathTemplate: string;
  mapping: SiteMapping;
  updatedAt: string | null;
}

export function defaultSiteSettings(): SiteSettingsDTO {
  return { siteUrl: null, repo: null, baseBranch: 'main', pathTemplate: DEFAULT_PATH_TEMPLATE, mapping: presetMapping('generic'), updatedAt: null };
}

/** What the pull-request destination keeps with a draft, so a later change to the settings never alters an approved file. */
export interface SiteDraftOptions {
  slug: string;
  /** Fixed when the draft is built, so the file is the same every time it is rendered. */
  dateIso: string;
  /** The path after the template was filled. */
  path: string;
  repo: string | null;
  baseBranch: string;
  mapping: SiteMapping;
  /** The owner said the file already exists and may be replaced. */
  updateExisting: boolean;
  /** The blob sha of that file when the owner looked. A replace is refused if it is different now. */
  expectedSha: string | null;
}

export interface DraftExtras {
  site?: SiteDraftOptions;
  /** Small per-destination choices that belong to the post: a subreddit, a Mastodon instance. Hashed with the payload. */
  options?: Record<string, string>;
}

export const OPTION_KEYS = ['subreddit', 'instance'] as const;
export type OptionKey = (typeof OPTION_KEYS)[number];
