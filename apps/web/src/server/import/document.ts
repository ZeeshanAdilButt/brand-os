import YAML from 'yaml';

/**
 * Turn the text of a Markdown or MDX file into the parts an article stores. Pure: no I/O.
 *
 * Nothing is thrown away. Front matter keys that have no home of their own are kept in
 * `extraMetadata`; MDX imports and components stay in the body as literal text and are reported;
 * a front matter block that cannot be parsed stays in the body and is reported.
 */
export interface ParsedDocument {
  title: string;
  description: string;
  tags: string[];
  canonicalUrl: string | null;
  body: string;
  extraMetadata: Record<string, unknown>;
  /** Things the writer should know about: something was kept as text, skipped or needs a look. */
  warnings: string[];
  /** Neutral facts about what the importer did (for example, where the title came from). */
  notes: string[];
}

export class DocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentError';
  }
}

export const IMPORT_EXTENSIONS = ['.md', '.mdx', '.markdown', '.txt'] as const;
export const MAX_IMPORT_BYTES = 1024 * 1024;

const TITLE_KEYS = ['title'];
const DESCRIPTION_KEYS = ['description', 'summary', 'excerpt', 'subtitle', 'abstract'];
const TAG_KEYS = ['tags', 'tag', 'keywords'];
const CANONICAL_KEYS = ['canonical', 'canonical_url', 'canonicalurl', 'canonical-url', 'canonicallink'];
const DATE_KEYS = ['date', 'published', 'publishedat', 'published_at', 'pubdate', 'publish_date', 'created'];
const COVER_KEYS = ['cover', 'coverimage', 'cover_image', 'cover-image', 'image', 'thumbnail', 'banner', 'hero'];

/** Decode upload bytes as UTF-8 text, refusing binary content. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length > MAX_IMPORT_BYTES) throw new DocumentError(`The file is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`);
  if (bytes.includes(0)) throw new DocumentError('This looks like a binary file, not text.');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new DocumentError('The file is not valid UTF-8 text. Save it as UTF-8 and try again.');
  }
}

export function extensionOf(filename: string): string {
  const match = /\.[A-Za-z0-9]+$/.exec(filename);
  return match ? match[0].toLowerCase() : '';
}

/** "my-first_post.md" -> "My first post". */
export function titleFromFilename(filename: string): string {
  const base = (filename.split(/[\\/]/).pop() ?? '').replace(/\.[A-Za-z0-9]+$/, '');
  const words = base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Untitled';
}

function normalizeNewlines(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/** Lines of `body` that sit outside fenced code, with their index. */
function proseLines(body: string): { line: string; index: number }[] {
  const out: { line: string; index: number }[] = [];
  let fence: string | null = null;
  body.split('\n').forEach((line, index) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return;
    }
    if (fence === null) out.push({ line, index });
  });
  return out;
}

function pick(data: Record<string, unknown>, keys: string[]): { key: string; value: unknown } | null {
  for (const [key, value] of Object.entries(data)) {
    if (keys.includes(key.toLowerCase()) && value !== null && value !== undefined && value !== '') return { key, value };
  }
  return null;
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return '';
}

function asTags(value: unknown): string[] {
  const parts: string[] = [];
  if (Array.isArray(value)) parts.push(...value.map(asString));
  else if (typeof value === 'string') parts.push(...value.replace(/^\[|\]$/g, '').split(','));
  const seen = new Set<string>();
  return parts
    .map((t) => t.trim().replace(/^['"]|['"]$/g, ''))
    .filter((t) => {
      if (!t || seen.has(t.toLowerCase())) return false;
      seen.add(t.toLowerCase());
      return true;
    });
}

/** Count MDX-only constructs outside code fences. */
function mdxFindings(body: string): { imports: number; exports: number; components: string[] } {
  let imports = 0;
  let exports = 0;
  const components = new Set<string>();
  for (const { line } of proseLines(body)) {
    if (/^\s*import\s+[\w*{][^\n]*\sfrom\s+['"]/.test(line) || /^\s*import\s+['"]/.test(line)) imports += 1;
    else if (/^\s*export\s+(const|let|var|function|default|async|class)\b/.test(line)) exports += 1;
    // Strip inline code first so `<Component>` mentioned in prose is not counted.
    const withoutCode = line.replace(/`[^`]*`/g, '');
    for (const m of withoutCode.matchAll(/<([A-Z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*)(?=[\s/>])/g)) components.add(m[1]!);
    if (/<>|<\/>/.test(withoutCode)) components.add('Fragment');
  }
  return { imports, exports, components: [...components] };
}

export function parseMarkdownDocument(raw: string, filename: string): ParsedDocument {
  const text = normalizeNewlines(raw);
  const warnings: string[] = [];
  const notes: string[] = [];
  const extra: Record<string, unknown> = {};
  let body = text;
  let title = '';
  let description = '';
  let tags: string[] = [];
  let canonicalUrl: string | null = null;

  const block = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(text);
  if (block) {
    let data: unknown;
    try {
      data = YAML.parse(block[1] ?? '', { schema: 'core', maxAliasCount: 50 });
    } catch (err) {
      warnings.push(
        `The front matter at the top could not be read (${(err as Error).message.split('\n')[0]}). It was kept as text at the start of the article.`,
      );
      data = undefined;
    }
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      body = text.slice(block[0].length);
      const fm = data as Record<string, unknown>;
      const used = new Set<string>();
      const take = (keys: string[]) => {
        const hit = pick(fm, keys);
        if (hit) used.add(hit.key);
        return hit?.value;
      };
      title = asString(take(TITLE_KEYS));
      description = asString(take(DESCRIPTION_KEYS));
      tags = asTags(take(TAG_KEYS));
      const canonical = asString(take(CANONICAL_KEYS));
      if (canonical) {
        try {
          const url = new URL(canonical);
          if (url.protocol === 'http:' || url.protocol === 'https:') canonicalUrl = url.toString();
          else throw new Error('scheme');
        } catch {
          extra.canonical = canonical;
          warnings.push(`The canonical value "${canonical.slice(0, 80)}" is not a web address, so it was kept as metadata only.`);
        }
      }
      const date = asString(take(DATE_KEYS));
      if (date) extra.date = date;
      const cover = asString(take(COVER_KEYS));
      if (cover) {
        extra.cover = cover;
        warnings.push(`The cover image "${cover.slice(0, 80)}" was kept as metadata. Images are not fetched on import; upload it and pick it as the cover.`);
      }
      for (const [key, value] of Object.entries(fm)) {
        if (!used.has(key) && !(key in extra)) extra[key] = value;
      }
      if (Object.keys(fm).length > 0 && Object.keys(extra).length > 0) {
        const kept = Object.keys(extra).filter((k) => !['date', 'cover', 'canonical'].includes(k));
        if (kept.length > 0) notes.push(`Kept ${kept.length} other front matter ${kept.length === 1 ? 'field' : 'fields'} as metadata: ${kept.slice(0, 8).join(', ')}.`);
      }
    } else if (data !== undefined) {
      warnings.push('The block at the top between "---" lines is not a set of key: value fields, so it was kept as text.');
    }
  }

  if (!title) {
    // First level-1 heading outside code becomes the title and leaves the body (it is moved, not lost).
    const lines = body.split('\n');
    const found = proseLines(body).find(({ line }) => /^#\s+\S/.test(line));
    const first = proseLines(body).find(({ line }) => line.trim() !== '');
    if (found && first && found.index === first.index) {
      title = found.line.replace(/^#\s+/, '').replace(/\s+#+\s*$/, '').trim();
      lines.splice(found.index, 1);
      while (lines[found.index] === '') lines.splice(found.index, 1);
      body = lines.join('\n');
      notes.push('Used the first heading as the title and moved it out of the body.');
    }
  }
  if (!title) {
    title = titleFromFilename(filename);
    notes.push('No title was found, so the file name was used.');
  }

  const ext = extensionOf(filename);
  const mdx = mdxFindings(body);
  const found: string[] = [];
  if (mdx.imports) found.push(`${mdx.imports} import ${mdx.imports === 1 ? 'statement' : 'statements'}`);
  if (mdx.exports) found.push(`${mdx.exports} export ${mdx.exports === 1 ? 'statement' : 'statements'}`);
  if (mdx.components.length) found.push(`${mdx.components.length} ${mdx.components.length === 1 ? 'component' : 'components'} (${mdx.components.slice(0, 6).map((c) => `<${c}>`).join(', ')})`);
  if (found.length > 0) {
    warnings.push(
      `${ext === '.mdx' ? 'This MDX file' : 'This file'} uses MDX features: ${found.join(', ')}. They are kept in the text as written and do not run here; the preview lists components it cannot render.`,
    );
  }

  return {
    title,
    description,
    tags,
    canonicalUrl,
    body: body.replace(/^\n+/, '').replace(/\s+$/, '') + (body.trim() ? '\n' : ''),
    extraMetadata: JSON.parse(JSON.stringify(extra)) as Record<string, unknown>,
    warnings,
    notes,
  };
}
