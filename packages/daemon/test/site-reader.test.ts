import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePost } from '@cph/core';
import { DEFAULT_REPO_PATH } from '../src/config.js';
import { openDb } from '../src/db/open.js';
import { createRepos } from '../src/db/repos.js';
import { GitCommandBlocked, createGit, defaultGitRunner, type GitRunner } from '../src/site/git.js';
import {
  SiteWriteBlocked,
  assertNotUnderSite,
  configureSiteGuard,
  createGuardedFs,
  guardedFs,
} from '../src/site/guarded-fs.js';
import { SiteReader } from '../src/site/site-reader.js';
import { syncContent } from '../src/sync.js';

const FIXTURES = fileURLToPath(new URL('../../core/test/fixtures/', import.meta.url));

let root: string;
let repo: string;

beforeEach(() => {
  // A space in the name: every Windows path in this project may contain one.
  root = mkdtempSync(join(tmpdir(), 'cph site '));
  repo = join(root, 'example-blog-site');
  mkdirSync(join(repo, 'content', 'posts'), { recursive: true });
  mkdirSync(join(repo, 'content', 'publishing-notes'), { recursive: true });
  // A temp COPY of the fixtures laid out like the real site.
  for (const file of ['sample-post.mdx', 'crlf-bom-post.mdx', 'unknown-jsx.mdx']) {
    copyFileSync(join(FIXTURES, file), join(repo, 'content', 'posts', file));
  }
  copyFileSync(join(FIXTURES, 'sample-notes.md'), join(repo, 'content', 'publishing-notes', 'sample-post.md'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Call {
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
}

function fakeGit(stdout = ''): { run: GitRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: GitRunner = (args, opts) => {
    calls.push({ args, env: opts.env });
    return Promise.resolve({ stdout });
  };
  return { run, calls };
}

describe('SiteReader', () => {
  it('listPosts returns the slugs, sorted', async () => {
    const reader = new SiteReader(repo, fakeGit().run);
    expect(await reader.listPosts()).toEqual(['crlf-bom-post', 'sample-post', 'unknown-jsx']);
  });

  it('listPosts ignores non-mdx files and odd names', async () => {
    writeFileSync(join(repo, 'content', 'posts', 'README.md'), 'x');
    writeFileSync(join(repo, 'content', 'posts', 'draft.mdx.bak'), 'x');
    writeFileSync(join(repo, 'content', 'posts', 'bad slug.mdx'), 'x');
    const reader = new SiteReader(repo, fakeGit().run);
    expect(await reader.listPosts()).toEqual(['crlf-bom-post', 'sample-post', 'unknown-jsx']);
  });

  it('readPost returns the raw file text, BOM and CRLF intact', async () => {
    const reader = new SiteReader(repo, fakeGit().run);
    expect(await reader.readPost('crlf-bom-post')).toBe(readFileSync(join(FIXTURES, 'crlf-bom-post.mdx'), 'utf8'));
  });

  it('readPost rejects a slug that could escape the posts folder, and a missing post throws', async () => {
    const reader = new SiteReader(repo, fakeGit().run);
    await expect(reader.readPost('..\\..\\secret')).rejects.toThrow(/invalid slug/);
    await expect(reader.readPost('../x')).rejects.toThrow(/invalid slug/);
    await expect(reader.readPost('nope')).rejects.toThrow();
  });

  it('readNotes returns the notes, and null when there is no notes file', async () => {
    const reader = new SiteReader(repo, fakeGit().run);
    expect(await reader.readNotes('sample-post')).toBe(readFileSync(join(FIXTURES, 'sample-notes.md'), 'utf8'));
    expect(await reader.readNotes('missing')).toBeNull();
    await expect(reader.readNotes('../posts/sample-post')).rejects.toThrow(/invalid slug/);
  });

  it('gitHead and isDirty run only allowlisted git commands, each with --no-optional-locks and GIT_OPTIONAL_LOCKS=0', async () => {
    const head = fakeGit('0123456789abcdef0123456789abcdef01234567\n');
    const reader = new SiteReader(repo, head.run);
    expect(await reader.gitHead()).toBe('0123456789abcdef0123456789abcdef01234567');
    expect(head.calls[0]?.args).toEqual(['--no-optional-locks', '-C', repo, 'rev-parse', 'HEAD']);

    const dirty = fakeGit(' M content/posts/sample-post.mdx\n');
    const dirtyReader = new SiteReader(repo, dirty.run);
    expect(await dirtyReader.isDirty('content/posts/sample-post.mdx')).toBe(true);
    expect(dirty.calls[0]?.args).toEqual([
      '--no-optional-locks',
      '-C',
      repo,
      'status',
      '--porcelain',
      '--',
      'content/posts/sample-post.mdx',
    ]);

    const clean = fakeGit('');
    expect(await new SiteReader(repo, clean.run).isDirty('content/posts/sample-post.mdx')).toBe(false);

    for (const call of [...head.calls, ...dirty.calls, ...clean.calls]) {
      expect(call.args[0]).toBe('--no-optional-locks');
      expect(call.env?.['GIT_OPTIONAL_LOCKS']).toBe('0');
    }
  });

  it('isDirty refuses a path outside the repo', async () => {
    const fake = fakeGit();
    const reader = new SiteReader(repo, fake.run);
    await expect(reader.isDirty('../elsewhere')).rejects.toThrow(/relative path inside the repo/);
    await expect(reader.isDirty('C:\\Windows')).rejects.toThrow(/relative path inside the repo/);
    await expect(reader.isDirty('')).rejects.toThrow(/relative path inside the repo/);
    expect(fake.calls).toEqual([]);
  });
});

describe('git allowlist', () => {
  it('blocks everything except rev-parse HEAD, status --porcelain -- <path> and log -1 --format=%H', async () => {
    const fake = fakeGit('ok');
    const git = createGit(repo, fake.run);
    const blocked: string[][] = [
      ['commit'],
      ['commit', '-m', 'x'],
      ['add', '.'],
      ['status'],
      ['status', '--porcelain'],
      ['status', '--porcelain', '--'],
      ['status', '--porcelain', 'content'],
      ['status', '--porcelain', '--', 'a', 'b'],
      ['rev-parse', '--git-dir'],
      ['rev-parse'],
      ['log'],
      ['log', '-1'],
      ['log', '-2', '--format=%H'],
      ['fetch'],
      ['checkout', '--', 'x'],
      ['-c', 'core.hooksPath=x', 'status'],
      [],
    ];
    for (const args of blocked) {
      await expect(git(args), JSON.stringify(args)).rejects.toBeInstanceOf(GitCommandBlocked);
    }
    expect(fake.calls).toEqual([]);
  });

  it('allows the three shapes', async () => {
    const fake = fakeGit('ok');
    const git = createGit(repo, fake.run);
    await git(['rev-parse', 'HEAD']);
    await git(['status', '--porcelain', '--', 'content/posts/x.mdx']);
    await git(['log', '-1', '--format=%H']);
    expect(fake.calls.map((c) => c.args.slice(3))).toEqual([
      ['rev-parse', 'HEAD'],
      ['status', '--porcelain', '--', 'content/posts/x.mdx'],
      ['log', '-1', '--format=%H'],
    ]);
    for (const call of fake.calls) {
      expect(call.args.slice(0, 3)).toEqual(['--no-optional-locks', '-C', repo]);
      expect(call.env?.['GIT_OPTIONAL_LOCKS']).toBe('0');
    }
  });

  it('the default runner refuses to run without --no-optional-locks first', async () => {
    await expect(defaultGitRunner(['status'], { env: {} })).rejects.toBeInstanceOf(GitCommandBlocked);
  });
});

describe('site write guard', () => {
  it('guardedFs blocks writes into the site repo, every operation', async () => {
    const fs = createGuardedFs(repo);
    const inside = join(repo, 'x');
    await expect(fs.writeFile(inside, 'x')).rejects.toBeInstanceOf(SiteWriteBlocked);
    await expect(fs.appendFile(inside, 'x')).rejects.toBeInstanceOf(SiteWriteBlocked);
    await expect(fs.mkdir(join(repo, 'new'), { recursive: true })).rejects.toBeInstanceOf(SiteWriteBlocked);
    await expect(fs.rm(join(repo, 'content'), { recursive: true })).rejects.toBeInstanceOf(SiteWriteBlocked);
    await expect(
      fs.rename(join(repo, 'content', 'posts', 'sample-post.mdx'), join(root, 'out')),
    ).rejects.toBeInstanceOf(SiteWriteBlocked);
    await expect(fs.rename(join(root, 'a'), join(repo, 'b'))).rejects.toBeInstanceOf(SiteWriteBlocked);
    await expect(fs.copyFile(join(root, 'a'), join(repo, 'b'))).rejects.toBeInstanceOf(SiteWriteBlocked);
    expect(() => fs.writeFileSync(inside, 'x')).toThrow(SiteWriteBlocked);
    expect(() => fs.mkdirSync(join(repo, 'new'))).toThrow(SiteWriteBlocked);
    expect(() => fs.rmSync(inside, { force: true })).toThrow(SiteWriteBlocked);
    expect(() => fs.createWriteStream(inside)).toThrow(SiteWriteBlocked);
    expect(existsSync(inside)).toBe(false);
    expect(existsSync(join(repo, 'new'))).toBe(false);
    expect(existsSync(join(repo, 'content', 'posts', 'sample-post.mdx'))).toBe(true);
  });

  it('allows copying OUT of the site (a read), but not into it', async () => {
    const fs = createGuardedFs(repo);
    const out = join(root, 'copy.mdx');
    await fs.copyFile(join(repo, 'content', 'posts', 'sample-post.mdx'), out);
    expect(existsSync(out)).toBe(true);
  });

  it('allows writes outside the site, including a sibling that merely shares the prefix', async () => {
    const fs = createGuardedFs(repo);
    const sibling = `${repo}-other`;
    await fs.mkdir(sibling, { recursive: true });
    await fs.writeFile(join(sibling, 'x.txt'), 'hello');
    expect(readFileSync(join(sibling, 'x.txt'), 'utf8')).toBe('hello');
    await fs.writeFile(join(root, 'plain.txt'), 'hi');
    await fs.rm(join(root, 'plain.txt'));
    expect(existsSync(join(root, 'plain.txt'))).toBe(false);
  });

  it('blocks removing or renaming a parent of the site, which would take the site with it', async () => {
    const fs = createGuardedFs(repo);
    await expect(fs.rm(root, { recursive: true })).rejects.toBeInstanceOf(SiteWriteBlocked);
    await expect(fs.rename(root, `${root}-moved`)).rejects.toBeInstanceOf(SiteWriteBlocked);
    expect(existsSync(join(repo, 'content'))).toBe(true);
    // creating a directory that already is a parent is harmless and stays allowed
    await fs.mkdir(root, { recursive: true });
  });

  it('blocks ".." traversal into the site', async () => {
    const fs = createGuardedFs(repo);
    const sneaky = join(root, 'elsewhere', '..', basename(repo), 'x');
    await expect(fs.writeFile(sneaky, 'x')).rejects.toBeInstanceOf(SiteWriteBlocked);
    await expect(fs.writeFile(join(repo, 'content', '..', '..', basename(repo), 'y'), 'x')).rejects.toBeInstanceOf(
      SiteWriteBlocked,
    );
    // a raw string, not normalised by path.join
    expect(() => assertNotUnderSite(`${repo}\\content\\..\\z`, repo)).toThrow(SiteWriteBlocked);
    expect(() => assertNotUnderSite(`${repo}/content/../z`, repo)).toThrow(SiteWriteBlocked);
    expect(existsSync(join(repo, 'x'))).toBe(false);
  });

  it('blocks a relative path that resolves into the site', async () => {
    const fs = createGuardedFs(repo);
    const original = process.cwd();
    process.chdir(repo);
    try {
      await expect(fs.writeFile('rel.txt', 'x')).rejects.toBeInstanceOf(SiteWriteBlocked);
    } finally {
      process.chdir(original);
    }
  });

  it.runIf(process.platform === 'win32')('compares case-insensitively on Windows', async () => {
    const fs = createGuardedFs(repo);
    const shouted = join(repo.toUpperCase(), 'X');
    await expect(fs.writeFile(shouted, 'x')).rejects.toBeInstanceOf(SiteWriteBlocked);
    await expect(fs.writeFile(join(repo.toLowerCase(), 'Content', 'X'), 'x')).rejects.toBeInstanceOf(SiteWriteBlocked);
    expect(() => assertNotUnderSite(shouted, repo.toLowerCase())).toThrow(SiteWriteBlocked);
    // the configured default path, with the casing from the task brief
    expect(() =>
      assertNotUnderSite('C:\\PATH\\to\\your-site\\x', DEFAULT_REPO_PATH),
    ).toThrow(SiteWriteBlocked);
    expect(existsSync(join(repo, 'x'))).toBe(false);
  });

  it('blocks a path spelled through the real (long) name of the repo', async () => {
    const fs = createGuardedFs(repo);
    const real = realpathSync.native(repo);
    await expect(fs.writeFile(join(real, 'x'), 'x')).rejects.toBeInstanceOf(SiteWriteBlocked);
  });

  it('blocks a symlink or junction that points into the site', async () => {
    const link = join(root, 'link');
    try {
      symlinkSync(repo, link, 'junction');
    } catch {
      return; // links not permitted on this machine
    }
    const fs = createGuardedFs(repo);
    await expect(fs.writeFile(join(link, 'x'), 'x')).rejects.toBeInstanceOf(SiteWriteBlocked);
    await expect(fs.writeFile(join(link, 'not-yet', 'x'), 'x')).rejects.toBeInstanceOf(SiteWriteBlocked);
    expect(existsSync(join(repo, 'x'))).toBe(false);
  });

  it('the guard covers the configured default site path (asserted without any write call)', () => {
    // No write function is ever called with a path under the REAL site repo, not even one the
    // guard would refuse: if the guard regressed, that call would write into the real repo.
    expect(() => assertNotUnderSite(join(DEFAULT_REPO_PATH, 'x'), DEFAULT_REPO_PATH)).toThrow(SiteWriteBlocked);
    expect(() => assertNotUnderSite(join(DEFAULT_REPO_PATH, 'content', 'nope.txt'), DEFAULT_REPO_PATH)).toThrow(
      SiteWriteBlocked,
    );
  });

  it('configureSiteGuard adds a repo to the default guardedFs and never removes one', async () => {
    configureSiteGuard(repo);
    await expect(guardedFs.writeFile(join(repo, 'x'), 'x')).rejects.toBeInstanceOf(SiteWriteBlocked);
    expect(() => guardedFs.mkdirSync(join(repo, 'dir'))).toThrow(SiteWriteBlocked);
    expect(existsSync(join(repo, 'x'))).toBe(false);
    // The default path stays guarded (checked via the pure assertion, never via a write call).
    expect(() => assertNotUnderSite(join(DEFAULT_REPO_PATH, 'x'), DEFAULT_REPO_PATH)).toThrow(SiteWriteBlocked);
  });

  it('SiteWriteBlocked is a named error that says the site is read-only', () => {
    try {
      assertNotUnderSite(join(repo, 'x'), repo);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SiteWriteBlocked);
      expect((err as Error).name).toBe('SiteWriteBlocked');
      expect((err as Error).message).toContain('read-only');
    }
  });
});

// Optional: reads the REAL clone, read-only. Skipped unless CPH_SITE_REPO is set.
const realRepo = process.env['CPH_SITE_REPO'];
describe.runIf(realRepo !== undefined && realRepo !== '')('real site repo (read-only)', () => {
  function indexProof(repoPath: string): { mtimeMs: number; sha256: string } {
    const index = join(repoPath, '.git', 'index');
    return {
      mtimeMs: statSync(index).mtimeMs,
      sha256: createHash('sha256').update(readFileSync(index)).digest('hex'),
    };
  }

  it('a full sync leaves git status and .git/index untouched', async () => {
    const repoPath = realRepo as string;
    const git = createGit(repoPath);
    const reader = new SiteReader(repoPath);
    const statusBefore = await git(['status', '--porcelain', '--', '.']);
    const indexBefore = indexProof(repoPath);

    const slugs = await reader.listPosts();
    expect(slugs).toContain('prometheus-cardinality-explained');
    // Every post "is live": the fake fetch answers with its own title, so no request leaves the machine.
    const titles = new Map<string, string>();
    for (const slug of slugs) titles.set(slug, parsePost(await reader.readPost(slug)).frontmatter.title);
    const fetchFn = ((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const res = new Response(`<html><head><title>${titles.get(url.split('/').pop() ?? '') ?? ''}</title></head></html>`, {
        status: 200,
      });
      Object.defineProperty(res, 'url', { value: url });
      return Promise.resolve(res);
    }) as typeof fetch;

    const db = openDb(':memory:');
    try {
      const repos = createRepos(db, { now: () => new Date().toISOString() });
      const result = await syncContent({ reader, repos, fetchFn, now: () => new Date() });
      expect(result.errors).toEqual([]);
      expect(result.upserted).toBe(slugs.length);
      expect(repos.content.list()).toHaveLength(slugs.length);
    } finally {
      db.close();
    }

    expect(await git(['status', '--porcelain', '--', '.'])).toBe(statusBefore);
    expect(indexProof(repoPath)).toEqual(indexBefore);
  });
});
