import fs from 'node:fs/promises';
import path from 'node:path';
import { decodeText, MAX_IMPORT_BYTES } from './document';

/**
 * Read-only access to a folder of Markdown files, for import. Nothing here ever writes.
 *
 *  - a file is named by a relative path from the listing; absolute paths, `..`, drive letters and
 *    NUL bytes are refused before the disk is touched;
 *  - the resolved real path must still sit inside the folder's real path, so a link (symlink or
 *    Windows junction) that leads out of the folder cannot be used to read something else;
 *  - directory links are never followed while listing; a file link is listed only if it points
 *    inside the folder;
 *  - only .md, .mdx and .markdown files, up to 1 MB.
 */

export const FOLDER_EXTENSIONS = ['.md', '.mdx', '.markdown'] as const;
const MAX_FILES = 500;
const MAX_DEPTH = 8;
const SKIP_DIRS = new Set(['node_modules', '.git']);

export class FolderError extends Error {
  constructor(
    readonly code: 'not_configured' | 'not_found' | 'not_a_folder' | 'too_broad' | 'outside' | 'invalid_path' | 'not_markdown' | 'too_large',
    message: string,
  ) {
    super(message);
    this.name = 'FolderError';
  }
}

export interface FolderFile {
  /** Forward-slash path relative to the folder. This is what import takes. */
  path: string;
  size: number;
  modifiedAt: string;
}

export interface FolderListing {
  root: string;
  files: FolderFile[];
  /** Entries left out on purpose, so the page can say so instead of pretending they do not exist. */
  skipped: { links: number; unreadable: number; truncated: boolean };
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

const hasMarkdownExtension = (name: string) => FOLDER_EXTENSIONS.includes(path.extname(name).toLowerCase() as (typeof FOLDER_EXTENSIONS)[number]);

/** Validate a folder the owner typed in and return its real, absolute path. */
export async function resolveContentFolder(input: string): Promise<string> {
  const text = input.trim();
  if (!text || text.includes('\0')) throw new FolderError('invalid_path', 'Enter the full path of a folder.');
  if (!path.isAbsolute(text)) throw new FolderError('invalid_path', 'Enter the full path of the folder, starting from the drive or the root.');
  let real: string;
  try {
    real = await fs.realpath(text);
  } catch {
    throw new FolderError('not_found', 'That folder does not exist.');
  }
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) throw new FolderError('not_a_folder', 'That path is a file, not a folder.');
  if (path.parse(real).root === real) {
    throw new FolderError('too_broad', 'Pick the folder that holds your articles, not a whole drive.');
  }
  return real;
}

/** List Markdown files under the folder (recursively), newest first. */
export async function listMarkdownFiles(folder: string): Promise<FolderListing> {
  const root = await resolveContentFolder(folder).catch((err) => {
    if (err instanceof FolderError && err.code === 'not_found') {
      throw new FolderError('not_found', 'The configured folder no longer exists. Pick it again.');
    }
    throw err;
  });
  const files: FolderFile[] = [];
  const skipped = { links: 0, unreadable: 0, truncated: false };

  async function walk(dir: string, depth: number): Promise<void> {
    if (skipped.truncated) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      skipped.unreadable += 1;
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (skipped.truncated) return;
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        // Never follow a directory link. A file link counts only when it stays inside the folder.
        let real: string;
        try {
          real = await fs.realpath(full);
        } catch {
          skipped.links += 1;
          continue;
        }
        const stat = await fs.stat(real).catch(() => null);
        if (!stat?.isFile() || !isInside(root, real) || !hasMarkdownExtension(entry.name)) {
          if (stat?.isFile() ? hasMarkdownExtension(entry.name) : true) skipped.links += 1;
          continue;
        }
        files.push({ path: toPosix(path.relative(root, full)), size: stat.size, modifiedAt: stat.mtime.toISOString() });
      } else if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(full, depth + 1);
      } else if (entry.isFile() && hasMarkdownExtension(entry.name)) {
        const stat = await fs.stat(full).catch(() => null);
        if (!stat) {
          skipped.unreadable += 1;
          continue;
        }
        files.push({ path: toPosix(path.relative(root, full)), size: stat.size, modifiedAt: stat.mtime.toISOString() });
      }
      if (files.length >= MAX_FILES) skipped.truncated = true;
    }
  }

  await walk(root, 0);
  files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return { root, files, skipped };
}

const toPosix = (p: string) => p.split(path.sep).join('/');

/** Check a relative path from the client and return the real file path to read, or throw. */
async function locate(root: string, relativePath: string): Promise<{ real: string; relative: string }> {
  if (typeof relativePath !== 'string' || relativePath === '' || relativePath.length > 500 || relativePath.includes('\0')) {
    throw new FolderError('invalid_path', 'That file path is not valid.');
  }
  if (
    path.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    path.posix.isAbsolute(relativePath) ||
    /^[a-zA-Z]:/.test(relativePath) ||
    relativePath.startsWith('\\\\')
  ) {
    throw new FolderError('invalid_path', 'Use a path relative to the folder.');
  }
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0 || segments.some((s) => s === '..' || s === '.')) {
    throw new FolderError('invalid_path', 'That file path is not valid.');
  }
  if (!hasMarkdownExtension(segments[segments.length - 1]!)) {
    throw new FolderError('not_markdown', 'Only .md, .mdx and .markdown files can be imported from a folder.');
  }
  const candidate = path.resolve(root, ...segments);
  if (!isInside(root, candidate)) throw new FolderError('outside', 'That file is outside the folder.');
  let real: string;
  try {
    real = await fs.realpath(candidate);
  } catch {
    throw new FolderError('not_found', 'That file no longer exists.');
  }
  // The real location, after following every link on the way, must still be inside the folder.
  if (!isInside(root, real)) throw new FolderError('outside', 'That file is a link to somewhere outside the folder, so it was not read.');
  return { real, relative: segments.join('/') };
}

/** Read one Markdown file from the folder as text. */
export async function readMarkdownFile(folder: string, relativePath: string): Promise<{ path: string; text: string; size: number }> {
  const root = await resolveContentFolder(folder);
  const { real, relative } = await locate(root, relativePath);
  const handle = await fs.open(real, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new FolderError('invalid_path', 'That path is not a file.');
    if (stat.size > MAX_IMPORT_BYTES) throw new FolderError('too_large', `That file is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`);
    const buffer = await handle.readFile();
    return { path: relative, text: decodeText(new Uint8Array(buffer)), size: stat.size };
  } finally {
    await handle.close();
  }
}
