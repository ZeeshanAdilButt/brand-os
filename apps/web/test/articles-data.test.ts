import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError } from '../src/server/data/articles';
import { forOwner, NotFoundError, SlugTakenError } from '../src/server/data/tenant';
import type { DbHandle } from '../src/server/db/client';
import { articleVersions, users } from '../src/server/db/schema';
import { memoryDb } from './helpers';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
let handle: DbHandle;

const a = () => forOwner(A, handle.db);
const b = () => forOwner(B, handle.db);

beforeAll(async () => {
  handle = await memoryDb();
  await handle.db.insert(users).values([
    { id: A, kind: 'member', displayName: 'Author A' },
    { id: B, kind: 'member', displayName: 'Author B' },
  ]);
});

afterAll(async () => {
  await handle.close();
});

describe('article slugs', () => {
  it('are unique per owner, but two owners may share one', async () => {
    await a().articles.create({ title: 'Hello', slug: 'hello-world' });
    await expect(a().articles.create({ title: 'Again', slug: 'hello-world' })).rejects.toBeInstanceOf(SlugTakenError);
    const other = await b().articles.create({ title: 'Hello', slug: 'hello-world' });
    expect(other.ownerId).toBe(B);
  });

  it('freeSlug picks the next free suffix and slugTaken ignores the article itself', async () => {
    expect(await a().articles.freeSlug('hello-world')).toBe('hello-world-2');
    const second = await a().articles.create({ title: 'Hello 2', slug: 'hello-world-2' });
    expect(await a().articles.freeSlug('hello-world')).toBe('hello-world-3');
    expect(await a().articles.slugTaken('hello-world-2', second.id)).toBe(false);
    expect(await a().articles.slugTaken('hello-world-2')).toBe(true);
  });

  it('a save cannot take a slug another article of the same owner uses', async () => {
    const x = await a().articles.create({ title: 'X', slug: 'slug-x' });
    await expect(a().articles.save(x.id, x.revision, { slug: 'hello-world' }, 'manual')).rejects.toBeInstanceOf(SlugTakenError);
    const unchanged = await a().articles.get(x.id);
    expect(unchanged?.slug).toBe('slug-x');
    expect(unchanged?.revision).toBe(x.revision);
  });
});

describe('optimistic concurrency', () => {
  it('rejects a save made against a stale revision and leaves the newer content alone', async () => {
    const art = await a().articles.create({ title: 'Race', slug: 'race' });
    const first = await a().articles.save(art.id, art.revision, { bodyMarkdown: 'from tab one' }, 'autosave');
    expect(first.revision).toBe(art.revision + 1);
    await expect(a().articles.save(art.id, art.revision, { bodyMarkdown: 'from tab two' }, 'autosave')).rejects.toSatisfy(
      (err) => err instanceof ConflictError && err.current.bodyMarkdown === 'from tab one' && err.current.revision === first.revision,
    );
    expect((await a().articles.get(art.id))?.bodyMarkdown).toBe('from tab one');
  });

  it('a save that changes nothing keeps the revision and writes no history', async () => {
    const art = await a().articles.create({ title: 'Same', slug: 'same', bodyMarkdown: 'text' });
    const before = await a().articles.listVersions(art.id);
    const again = await a().articles.save(art.id, art.revision, { bodyMarkdown: 'text', title: 'Same' }, 'autosave');
    expect(again.revision).toBe(art.revision);
    expect(await a().articles.listVersions(art.id)).toHaveLength(before.length);
  });
});

describe('version history', () => {
  it('coalesces autosaves within one burst into one snapshot holding the latest state', async () => {
    const art = await a().articles.create({ title: 'Burst', slug: 'burst' });
    let rev = art.revision;
    for (const body of ['one', 'one two', 'one two three']) {
      rev = (await a().articles.save(art.id, rev, { bodyMarkdown: body }, 'autosave')).revision;
    }
    const versions = await a().articles.listVersions(art.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.reason).toBe('autosave');
    expect((await a().articles.getVersion(art.id, versions[0]!.versionNo))?.body).toBe('one two three');
  });

  it('starts a new autosave snapshot once the burst window has passed, and keeps manual saves', async () => {
    const art = await a().articles.create({ title: 'Window', slug: 'window' });
    let rev = (await a().articles.save(art.id, art.revision, { bodyMarkdown: 'first draft' }, 'autosave')).revision;
    // Age the burst by rewriting its start; the start is part of the snapshot's metadata.
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const [row] = await handle.db.select().from(articleVersions).where(eq(articleVersions.articleId, art.id));
    await handle.db
      .update(articleVersions)
      .set({ metadata: { ...(row!.metadata as object), burstStart: old } })
      .where(eq(articleVersions.id, row!.id));
    rev = (await a().articles.save(art.id, rev, { bodyMarkdown: 'second draft' }, 'autosave')).revision;
    rev = (await a().articles.save(art.id, rev, { bodyMarkdown: 'second draft, saved' }, 'manual')).revision;
    const versions = await a().articles.listVersions(art.id);
    expect(versions.map((v) => v.reason)).toEqual(['manual', 'autosave', 'autosave']);
    expect(rev).toBeGreaterThan(art.revision);
  });

  it('a manual save with nothing new adds no duplicate, and promotes an identical autosave', async () => {
    const art = await a().articles.create({ title: 'Manual', slug: 'manual' });
    const saved = await a().articles.save(art.id, art.revision, { bodyMarkdown: 'draft' }, 'autosave');
    await a().articles.save(art.id, saved.revision, {}, 'manual');
    expect((await a().articles.listVersions(art.id)).map((v) => v.reason)).toEqual(['manual']);
    await a().articles.save(art.id, saved.revision, {}, 'manual');
    expect(await a().articles.listVersions(art.id)).toHaveLength(1);
  });

  it('restore creates a new version, keeps history and leaves slug and status alone', async () => {
    const art = await a().articles.create({ title: 'Restore me', slug: 'restore-me', bodyMarkdown: 'original text' });
    let rev = (
      await a().articles.save(art.id, art.revision, { bodyMarkdown: 'rewritten', title: 'Changed', slug: 'restore-me-new', status: 'ready' }, 'manual')
    ).revision;
    const before = await a().articles.listVersions(art.id);
    const restored = await a().articles.restore(art.id, 1, rev);
    rev = restored.revision;
    expect(restored.bodyMarkdown).toBe('original text');
    expect(restored.title).toBe('Restore me');
    expect(restored.slug).toBe('restore-me-new');
    expect(restored.status).toBe('ready');
    const after = await a().articles.listVersions(art.id);
    expect(after).toHaveLength(before.length + 1);
    expect(after[0]?.reason).toBe('restore');
    expect((await a().articles.getVersion(art.id, 1))?.body).toBe('original text');
    await expect(a().articles.restore(art.id, 1, rev - 1)).rejects.toBeInstanceOf(ConflictError);
    await expect(a().articles.restore(art.id, 99, rev)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('search and lists', () => {
  it('ranks title matches first and hides archived articles unless asked', async () => {
    await a().articles.create({ title: 'Sharding strategies', slug: 'sharding', bodyMarkdown: 'Notes about partitioning.' });
    await a().articles.create({ title: 'Weekly log', slug: 'weekly', bodyMarkdown: 'We discussed sharding again.' });
    const arch = await a().articles.create({ title: 'Old sharding post', slug: 'old-sharding', status: 'archived' });
    const hits = await a().articles.search('sharding');
    expect(hits.map((h) => h.article.slug)).toEqual(['sharding', 'weekly']);
    expect((await a().articles.search('sharding', { status: 'all' })).map((h) => h.article.id)).toContain(arch.id);
    expect((await a().articles.list()).map((r) => r.id)).not.toContain(arch.id);
    expect((await a().articles.list({ status: 'archived' })).map((r) => r.id)).toEqual([arch.id]);
  });
});

describe('assets', () => {
  it('dedupes by sha256 per owner and lets two owners hold the same file', async () => {
    const input = { articleId: null, filename: 'a.png', mime: 'image/png', size: 3, sha256: 'a'.repeat(64), storageKey: `${A}/one.png` };
    const first = await a().assets.create(input);
    const again = await a().assets.create({ ...input, storageKey: `${A}/two.png` });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.asset.id).toBe(first.asset.id);
    const theirs = await b().assets.create({ ...input, storageKey: `${B}/one.png` });
    expect(theirs.created).toBe(true);
    expect(theirs.asset.ownerId).toBe(B);
  });
});
