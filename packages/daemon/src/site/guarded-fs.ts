/**
 * The ONLY module in the daemon that may import node:fs write APIs (the `site-read-only` source
 * rule enforces this). Every write goes through here, and every write first asserts that the
 * target is not the personal site repo or anywhere under it: that repo is read-only.
 *
 * Paths are compared after `path.resolve` and, when they exist, `realpath.native` (so `..`,
 * relative paths, junctions/symlinks and 8.3 short names all collapse to one spelling), and
 * case-insensitively on Windows.
 */
import {
  appendFileSync,
  copyFileSync,
  createWriteStream,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  type MakeDirectoryOptions,
  type PathLike,
  type RmOptions,
  type WriteStream,
} from 'node:fs';
import { appendFile, copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_REPO_PATH } from '../config.js';

export class SiteWriteBlocked extends Error {
  constructor(target: string, repoPath: string, why: string) {
    super(`refusing to modify ${target}: ${why} (the site repo ${repoPath} is read-only)`);
    this.name = 'SiteWriteBlocked';
  }
}

/** Collapses a path to one comparable spelling. Never throws. */
function canonical(input: string): string {
  const absolute = resolve(input);
  let existing = absolute;
  const tail: string[] = [];
  let spelled = absolute;
  for (;;) {
    try {
      spelled = join(realpathSync.native(existing), ...tail.reverse());
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const parent = dirname(existing);
      // Only "does not exist" walks up to the nearest existing parent (so a target that is not
      // created yet still resolves through links in its parents). Anything else: use as spelled.
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === existing) break;
      tail.push(basename(existing));
      existing = parent;
    }
  }
  // realpath.native can return the extended-length form; drop it so both sides match.
  spelled = spelled.replace(/^\\\\\?\\UNC\\/, '\\\\').replace(/^\\\\\?\\/, '');
  return process.platform === 'win32' ? spelled.toLowerCase() : spelled;
}

function isEqualOrUnder(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Throws `SiteWriteBlocked` when `target` is the site repo or anything under it.
 * With `mode: 'destroy'` (rm, and the source of a rename) a PARENT of the repo is blocked too,
 * because removing or moving the parent takes the site with it.
 */
export function assertNotUnderSite(target: string, repoPath: string, mode: 'write' | 'destroy' = 'write'): void {
  const t = canonical(target);
  const r = canonical(repoPath);
  if (isEqualOrUnder(t, r)) throw new SiteWriteBlocked(target, repoPath, 'the target is inside the site repo');
  if (mode === 'destroy' && isEqualOrUnder(r, t)) {
    throw new SiteWriteBlocked(target, repoPath, 'the target contains the site repo');
  }
}

function toPath(p: PathLike): string {
  if (typeof p === 'string') return p;
  if (p instanceof URL) return fileURLToPath(p);
  return p.toString('utf8');
}

type Mode = 'write' | 'destroy';

function makeGuardedFs(roots: () => Iterable<string>) {
  const check = (p: PathLike, mode: Mode = 'write'): string => {
    const target = toPath(p);
    for (const root of roots()) assertNotUnderSite(target, root, mode);
    return target;
  };
  return {
    // async
    async writeFile(path: PathLike, data: Parameters<typeof writeFile>[1], options?: Parameters<typeof writeFile>[2]) {
      return writeFile(check(path), data, options);
    },
    async appendFile(path: PathLike, data: Parameters<typeof appendFile>[1], options?: Parameters<typeof appendFile>[2]) {
      return appendFile(check(path), data, options);
    },
    async mkdir(path: PathLike, options?: MakeDirectoryOptions) {
      return mkdir(check(path), options);
    },
    async rm(path: PathLike, options?: RmOptions) {
      return rm(check(path, 'destroy'), options);
    },
    async rename(oldPath: PathLike, newPath: PathLike) {
      return rename(check(oldPath, 'destroy'), check(newPath));
    },
    /** Only the destination is a write; copying OUT of the site is a read. */
    async copyFile(src: PathLike, dest: PathLike, mode?: number) {
      return copyFile(toPath(src), check(dest), mode);
    },
    // sync (the database opens synchronously)
    writeFileSync(path: PathLike, data: Parameters<typeof writeFileSync>[1], options?: Parameters<typeof writeFileSync>[2]) {
      return writeFileSync(check(path), data, options);
    },
    appendFileSync(path: PathLike, data: Parameters<typeof appendFileSync>[1], options?: Parameters<typeof appendFileSync>[2]) {
      return appendFileSync(check(path), data, options);
    },
    mkdirSync(path: PathLike, options?: MakeDirectoryOptions) {
      return mkdirSync(check(path), options);
    },
    rmSync(path: PathLike, options?: RmOptions) {
      return rmSync(check(path, 'destroy'), options);
    },
    renameSync(oldPath: PathLike, newPath: PathLike) {
      return renameSync(check(oldPath, 'destroy'), check(newPath));
    },
    copyFileSync(src: PathLike, dest: PathLike, mode?: number) {
      return copyFileSync(toPath(src), check(dest), mode);
    },
    createWriteStream(path: PathLike, options?: Parameters<typeof createWriteStream>[1]): WriteStream {
      return createWriteStream(check(path), options);
    },
  };
}

export type GuardedFs = ReturnType<typeof makeGuardedFs>;

/** A guarded fs for exactly these site repos (tests; the daemon uses the default `guardedFs`). */
export function createGuardedFs(repoPaths: string | readonly string[]): GuardedFs {
  const roots = typeof repoPaths === 'string' ? [repoPaths] : [...repoPaths];
  return makeGuardedFs(() => roots);
}

// The default guard always covers the configured default site path. `configureSiteGuard` only
// ever ADDS a root, so a later call can never un-guard the site.
const defaultRoots = new Set<string>([DEFAULT_REPO_PATH]);

/** Call once at startup with `config.site.repoPath` so a non-default clone is guarded too. */
export function configureSiteGuard(repoPath: string): void {
  defaultRoots.add(repoPath);
}

/** All daemon code imports its fs writes from here. */
export const guardedFs: GuardedFs = makeGuardedFs(() => defaultRoots);
