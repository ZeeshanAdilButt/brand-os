import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createGit, type Git, type GitRunner } from './git.js';

// A slug is a file name stem: no separators, no dots, so it can never leave the folder.
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function assertSlug(slug: string): void {
  if (!SLUG.test(slug)) throw new Error(`invalid slug: ${JSON.stringify(slug)}`);
}

/**
 * Read-only view of the personal site repo. This is the only class that holds the repo path
 * (plus the write guard, which refuses to write there). Posts are `content/posts/<slug>.mdx`,
 * publishing notes `content/publishing-notes/<slug>.md`. Contents are returned raw (BOM and CRLF
 * intact); the parsers in @cph/core deal with them.
 */
export class SiteReader {
  readonly #repoPath: string;
  readonly #git: Git;

  constructor(repoPath: string, run?: GitRunner) {
    this.#repoPath = repoPath;
    this.#git = createGit(repoPath, run);
  }

  /** Slugs of every post, sorted. */
  async listPosts(): Promise<string[]> {
    const names = await readdir(join(this.#repoPath, 'content', 'posts'));
    return names
      .filter((name) => name.endsWith('.mdx'))
      .map((name) => name.slice(0, -'.mdx'.length))
      .filter((slug) => SLUG.test(slug))
      .sort();
  }

  async readPost(slug: string): Promise<string> {
    assertSlug(slug);
    return readFile(join(this.#repoPath, 'content', 'posts', `${slug}.mdx`), 'utf8');
  }

  /** The publishing-notes file, or `null` when the post has none (most do not). */
  async readNotes(slug: string): Promise<string | null> {
    assertSlug(slug);
    try {
      return await readFile(join(this.#repoPath, 'content', 'publishing-notes', `${slug}.md`), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * The same read, synchronously: the approval gate's "source unchanged since sync" check reads the
   * post fresh inside a transaction, where it cannot await.
   */
  readPostSync(slug: string): string {
    assertSlug(slug);
    return readFileSync(join(this.#repoPath, 'content', 'posts', `${slug}.mdx`), 'utf8');
  }

  /** `readNotes`, synchronously; `null` when the post has no notes file. */
  readNotesSync(slug: string): string | null {
    assertSlug(slug);
    try {
      return readFileSync(join(this.#repoPath, 'content', 'publishing-notes', `${slug}.md`), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async gitHead(): Promise<string> {
    return (await this.#git(['rev-parse', 'HEAD'])).trim();
  }

  /** True when `git status --porcelain -- <relPath>` reports anything. `relPath` is inside the repo. */
  async isDirty(relPath: string): Promise<boolean> {
    const segments = relPath.split(/[\\/]/);
    if (
      relPath === '' ||
      relPath.includes('\0') ||
      isAbsolute(relPath) ||
      /^[A-Za-z]:/.test(relPath) ||
      segments.includes('..')
    ) {
      throw new Error(`isDirty needs a relative path inside the repo, got ${JSON.stringify(relPath)}`);
    }
    return (await this.#git(['status', '--porcelain', '--', relPath])).trim() !== '';
  }
}
