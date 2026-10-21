import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as importFilePost } from '../src/app/api/articles/import/file/route';
import { GET as folderGet, POST as folderPost, PUT as folderPut } from '../src/app/api/articles/import/folder/route';
import { handleFolderGet, handleFolderImport, handleFolderSet, handleImportFile } from '../src/server/http/import-handlers';
import { FolderError, listMarkdownFiles, readMarkdownFile, resolveContentFolder } from '../src/server/import/folder';
import { forOwner } from '../src/server/data/tenant';
import { LOCAL_OWNER_ID } from '../src/server/data/users';
import type { AppContext } from '../src/server/context';
import type { DbHandle } from '../src/server/db/client';
import { hostedHarness, HOSTED_URL, type HostedHarness } from './hosted-harness';
import { memoryDb, testConfig } from './helpers';

let base: string;
let content: string;
let outside: string;

/** Whether this machine lets the test create a link of the given kind (Windows file links need a privilege). */
function canLink(kind: 'file' | 'dir'): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cph link probe '));
  try {
    fs.mkdirSync(path.join(dir, 'target'));
    fs.writeFileSync(path.join(dir, 'target.md'), 'x');
    if (kind === 'file') fs.symlinkSync(path.join(dir, 'target.md'), path.join(dir, 'link.md'), 'file');
    else fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const linksSupported = canLink('dir');
const fileLinksSupported = canLink('file');

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof FolderError) return err.code;
    throw err;
  }
  return 'ok';
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'cph folder test '));
  content = path.join(base, 'content');
  outside = path.join(base, 'outside');
  write(path.join(content, 'first-post.md'), '---\ntitle: First post\ntags: [one]\n---\n\nHello.\n');
  write(path.join(content, 'guides', 'second.mdx'), "import X from './x'\n\n# Second\n\n<X />\n");
  write(path.join(content, 'notes.markdown'), 'plain\n');
  write(path.join(content, 'readme.txt'), 'not listed: wrong extension\n');
  write(path.join(content, '.hidden', 'secret.md'), 'hidden\n');
  write(path.join(content, 'node_modules', 'pkg', 'README.md'), 'dependency\n');
  write(path.join(outside, 'private.md'), '# Outside secret\n');
  write(path.join(outside, 'deep', 'more.md'), 'more secret\n');
  if (linksSupported) fs.symlinkSync(outside, path.join(content, 'escape-dir'), process.platform === 'win32' ? 'junction' : 'dir');
  if (fileLinksSupported) {
    fs.symlinkSync(path.join(outside, 'private.md'), path.join(content, 'escape-file.md'), 'file');
    fs.symlinkSync(path.join(content, 'notes.markdown'), path.join(content, 'inside-link.md'), 'file');
  }
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('folder listing', () => {
  it('lists Markdown and MDX files recursively, skipping hidden folders, dependencies and other extensions', async () => {
    const listing = await listMarkdownFiles(content);
    const paths = listing.files.map((f) => f.path).sort();
    expect(paths).toEqual(expect.arrayContaining(['first-post.md', 'guides/second.mdx', 'notes.markdown']));
    expect(paths).not.toContain('readme.txt');
    expect(paths.some((p) => p.includes('.hidden') || p.includes('node_modules'))).toBe(false);
    expect(listing.files.every((f) => f.size > 0 && !Number.isNaN(Date.parse(f.modifiedAt)))).toBe(true);
  });

  it('never lists anything reached through a link that leaves the folder, and counts what it skipped', async () => {
    const listing = await listMarkdownFiles(content);
    const paths = listing.files.map((f) => f.path);
    expect(paths.some((p) => p.startsWith('escape-dir'))).toBe(false);
    expect(paths).not.toContain('escape-file.md');
    expect(paths.some((p) => p.includes('private.md') || p.includes('more.md'))).toBe(false);
    if (linksSupported || fileLinksSupported) expect(listing.skipped.links).toBeGreaterThan(0);
  });

  it('refuses to use a drive root or a missing folder', async () => {
    expect(await codeOf(resolveContentFolder(path.parse(content).root))).toBe('too_broad');
    expect(await codeOf(resolveContentFolder(path.join(base, 'nope')))).toBe('not_found');
    expect(await codeOf(resolveContentFolder('relative/folder'))).toBe('invalid_path');
    expect(await codeOf(resolveContentFolder(path.join(content, 'first-post.md')))).toBe('not_a_folder');
    expect(await codeOf(resolveContentFolder(''))).toBe('invalid_path');
  });
});

describe('reading a file from the folder', () => {
  it('reads a listed file', async () => {
    const file = await readMarkdownFile(content, 'guides/second.mdx');
    expect(file.path).toBe('guides/second.mdx');
    expect(file.text).toContain('# Second');
  });

  it.each([
    '../outside/private.md',
    '..\\outside\\private.md',
    'guides/../../outside/private.md',
    'guides/../../../etc/passwd.md',
    '/etc/passwd.md',
    'C:\\Windows\\win.ini.md',
    'C:/Windows/win.ini.md',
    '\\\\server\\share\\x.md',
    'first-post.md\0.png',
    './first-post.md',
    '',
  ])('refuses the path %j', async (rel) => {
    const code = await codeOf(readMarkdownFile(content, rel));
    expect(['invalid_path', 'outside', 'not_found']).toContain(code);
  });

  it('refuses absolute paths even when they point inside the folder', async () => {
    expect(await codeOf(readMarkdownFile(content, path.join(content, 'first-post.md')))).toBe('invalid_path');
  });

  it('refuses other file types and missing files', async () => {
    expect(await codeOf(readMarkdownFile(content, 'readme.txt'))).toBe('not_markdown');
    expect(await codeOf(readMarkdownFile(content, 'missing.md'))).toBe('not_found');
    expect(await codeOf(readMarkdownFile(content, 'guides'))).toBe('not_markdown');
  });

  it.skipIf(!fileLinksSupported)('refuses a file that is a link to somewhere outside the folder', async () => {
    expect(await codeOf(readMarkdownFile(content, 'escape-file.md'))).toBe('outside');
  });

  it.skipIf(!linksSupported)('refuses a path that goes through a directory link to outside the folder', async () => {
    expect(await codeOf(readMarkdownFile(content, 'escape-dir/private.md'))).toBe('outside');
    expect(await codeOf(readMarkdownFile(content, 'escape-dir/deep/more.md'))).toBe('outside');
  });

  it.skipIf(!fileLinksSupported)('allows a link whose target stays inside the folder', async () => {
    const file = await readMarkdownFile(content, 'inside-link.md');
    expect(file.text).toBe('plain\n');
  });

  it('refuses a file that is too large', async () => {
    write(path.join(content, 'huge.md'), 'x'.repeat(1024 * 1024 + 10));
    expect(await codeOf(readMarkdownFile(content, 'huge.md'))).toBe('too_large');
  });
});

describe('folder import through the routes (local mode)', () => {
  let handle: DbHandle;
  let ctx: AppContext;

  const req = (method: string, urlPath: string, body?: unknown) =>
    new Request(`http://localhost:3100${urlPath}`, {
      method,
      headers: { host: 'localhost:3100', ...(method === 'GET' ? {} : { origin: 'http://localhost:3100', 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = async (res: Response) => (await res.json()) as Record<string, any>;

  beforeAll(async () => {
    handle = await memoryDb();
    ctx = { config: testConfig(), db: handle.db, auth: null };
  });
  afterAll(async () => {
    await handle.close();
  });

  it('shows no folder until one is chosen, then lists files and marks imported ones', async () => {
    const empty = await json(await handleFolderGet(req('GET', '/api/articles/import/folder'), { ctx }));
    expect(empty).toMatchObject({ available: true, folder: null, files: [] });

    const set = await json(await handleFolderSet(req('PUT', '/api/articles/import/folder', { path: content }), { ctx }));
    expect(set.folder).toBe(fs.realpathSync(content));
    expect(set.files.map((f: { path: string }) => f.path)).toContain('first-post.md');
    expect(set.files.every((f: { importedAs: unknown }) => f.importedAs === null)).toBe(true);

    const imported = await handleFolderImport(req('POST', '/api/articles/import/folder', { path: 'first-post.md' }), { ctx });
    expect(imported.status).toBe(201);
    const body = await json(imported);
    expect(body.article).toMatchObject({ title: 'First post', sourceKind: 'folder', sourceRef: 'first-post.md', status: 'draft', tags: ['one'] });
    const versions = await forOwner(LOCAL_OWNER_ID, handle.db).articles.listVersions(body.article.id);
    expect(versions.map((v) => v.reason)).toEqual(['import']);

    const after = await json(await handleFolderGet(req('GET', '/api/articles/import/folder'), { ctx }));
    const entry = after.files.find((f: { path: string }) => f.path === 'first-post.md');
    expect(entry.importedAs).toMatchObject({ id: body.article.id });
  });

  it('handles a slug collision by choosing the next free slug', async () => {
    const again = await json(await handleFolderImport(req('POST', '/api/articles/import/folder', { path: 'first-post.md' }), { ctx }));
    expect(again.article.slug).toBe('first-post-2');
  });

  it('keeps MDX components as text and returns the warning', async () => {
    const res = await json(await handleFolderImport(req('POST', '/api/articles/import/folder', { path: 'guides/second.mdx' }), { ctx }));
    expect(res.article.bodyMarkdown).toContain('<X />');
    expect(res.warnings.join(' ')).toContain('MDX');
  });

  it('refuses traversal, absolute paths and escaping links over the route', async () => {
    for (const bad of ['../outside/private.md', '/etc/passwd.md', 'escape-dir/private.md', 'escape-file.md']) {
      if ((bad.startsWith('escape-dir') && !linksSupported) || (bad === 'escape-file.md' && !fileLinksSupported)) continue;
      const res = await handleFolderImport(req('POST', '/api/articles/import/folder', { path: bad }), { ctx });
      expect([400, 404], bad).toContain(res.status);
    }
    const all = JSON.stringify(await forOwner(LOCAL_OWNER_ID, handle.db).articles.list({ status: 'all' }));
    expect(all).not.toContain('Outside secret');
  });

  it('refuses a folder that does not exist', async () => {
    const res = await handleFolderSet(req('PUT', '/api/articles/import/folder', { path: path.join(base, 'does-not-exist') }), { ctx });
    expect(res.status).toBe(404);
  });

  it('routes exist for the app (they go through the same handlers)', () => {
    expect(typeof folderGet).toBe('function');
    expect(typeof folderPut).toBe('function');
    expect(typeof folderPost).toBe('function');
  });
});

describe('folder import is unavailable when hosted', () => {
  let h: HostedHarness;
  beforeAll(async () => {
    h = await hostedHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('never reads the server disk for a signed-in user', async () => {
    const user = await h.signUp('folder.user@example.test', 'F');
    const status = await (await folderGet(h.request(user, 'GET', '/api/articles/import/folder'))).json();
    expect(status).toMatchObject({ available: false, files: [] });
    const set = await folderPut(h.request(user, 'PUT', '/api/articles/import/folder', { path: content }));
    expect(set.status).toBe(400);
    const imp = await folderPost(h.request(user, 'POST', '/api/articles/import/folder', { path: 'first-post.md' }));
    expect(imp.status).toBe(400);
    expect(await forOwner(user.userId, h.ctx.db).studioSettings.get()).toEqual({ contentFolder: null });
  });
});

describe('file import through the route', () => {
  let h: HostedHarness;
  beforeAll(async () => {
    h = await hostedHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const upload = async (user: Awaited<ReturnType<HostedHarness['signUp']>> | null, name: string, bytes: Uint8Array | string) => {
    const form = new FormData();
    form.set('file', new File([typeof bytes === 'string' ? bytes : (bytes as BlobPart)], name));
    return handleImportFile(
      new Request(`${HOSTED_URL}/api/articles/import/file`, {
        method: 'POST',
        headers: { host: new URL(HOSTED_URL).host, origin: HOSTED_URL, ...(user ? { cookie: user.cookie } : {}) },
        body: form,
      }),
      {},
    );
  };

  it('imports front matter, CRLF and a byte order mark, and files it under the signed-in user', async () => {
    const user = await h.signUp('file.user@example.test', 'F');
    const other = await h.signUp('file.other@example.test', 'O');
    const text = '\uFEFF---\r\ntitle: Uploaded post\r\ndescription: From a file\r\ntags: [a, b]\r\n---\r\n\r\nBody line\r\n';
    const res = await upload(user, 'post.md', text);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { article: { id: string; title: string; ownerId: string; bodyMarkdown: string; sourceKind: string } };
    expect(body.article).toMatchObject({ title: 'Uploaded post', sourceKind: 'file', bodyMarkdown: 'Body line\n', ownerId: user.userId });
    expect(await forOwner(other.userId, h.ctx.db).articles.get(body.article.id)).toBeNull();
    expect((await importFilePost(h.request(null, 'POST', '/api/articles/import/file', {}))).status).toBe(401);
  });

  it('refuses the wrong extension, binary content and oversized files', async () => {
    const user = await h.signUp('file.user2@example.test', 'F2');
    expect((await upload(user, 'photo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1]))).status).toBe(400);
    expect((await upload(user, 'binary.md', new Uint8Array([0x41, 0, 0x42]))).status).toBe(400);
    expect((await upload(user, 'big.md', 'x'.repeat(1024 * 1024 + 1))).status).toBe(413);
    expect((await upload(user, 'ok.txt', 'plain text file')).status).toBe(201);
  });
});
