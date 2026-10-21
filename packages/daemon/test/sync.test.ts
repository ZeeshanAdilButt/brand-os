import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.js';
import { createRepos, type NewDraft, type Repos } from '../src/db/repos.js';
import { SiteReader } from '../src/site/site-reader.js';
import type { GitRunner } from '../src/site/git.js';
import { LIVE_DRAFT_STATUSES } from '../src/gate/statuses.js';
import { syncContent, type SyncDeps } from '../src/sync.js';

const FIXTURES = fileURLToPath(new URL('../../core/test/fixtures/', import.meta.url));
const SAMPLE = 'sample-post';
const OTHER = 'unknown-jsx';
const TITLES: Record<string, string> = {
  [SAMPLE]: 'How High Cardinality Hurts Prometheus',
  [OTHER]: 'A Post With An Unknown Component',
};

let root: string;
let repo: string;
let db: Db;
let repos: Repos;
let clock: Date;

const postPath = (slug: string): string => join(repo, 'content', 'posts', `${slug}.mdx`);
const notesPath = (slug: string): string => join(repo, 'content', 'publishing-notes', `${slug}.md`);

beforeEach(() => {
  // A space in the name: every Windows path in this project may contain one.
  root = mkdtempSync(join(tmpdir(), 'cph sync '));
  repo = join(root, 'example-blog-site');
  mkdirSync(join(repo, 'content', 'posts'), { recursive: true });
  mkdirSync(join(repo, 'content', 'publishing-notes'), { recursive: true });
  copyFileSync(join(FIXTURES, 'sample-post.mdx'), postPath(SAMPLE));
  copyFileSync(join(FIXTURES, 'unknown-jsx.mdx'), postPath(OTHER));
  copyFileSync(join(FIXTURES, 'sample-notes.md'), notesPath(SAMPLE));
  db = openDb(':memory:');
  clock = new Date('2026-10-19T10:00:00.000Z');
  repos = createRepos(db, { now: () => clock.toISOString() });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** A git that always reports commit abc1234 and a clean tree. */
const fakeGit: GitRunner = (args) => Promise.resolve({ stdout: args.includes('rev-parse') ? 'abc1234\n' : '' });

interface FetchLog {
  fetchFn: typeof fetch;
  urls: string[];
}

/** Every known post is live with its title, unless `override` answers differently. */
function fakeFetch(override?: (url: string) => Response | undefined): FetchLog {
  const urls: string[] = [];
  const fetchFn = ((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    const custom = override?.(url);
    if (custom !== undefined) return Promise.resolve(custom);
    const slug = url.split('/').pop() ?? '';
    const res = new Response(`<html><head><title>${TITLES[slug] ?? 'Not Found'}</title></head></html>`, { status: 200 });
    Object.defineProperty(res, 'url', { value: url });
    return Promise.resolve(res);
  }) as typeof fetch;
  return { fetchFn, urls };
}

function deps(log: FetchLog, extra: Partial<SyncDeps> = {}): SyncDeps {
  return {
    reader: new SiteReader(repo, fakeGit),
    repos,
    fetchFn: log.fetchFn,
    now: () => clock,
    timeZone: 'UTC',
    ...extra,
  };
}

function addDraft(id: string, slug: string, status: NewDraft['status'], extra: Partial<NewDraft> = {}): void {
  repos.drafts.insert({
    id,
    slug,
    platform: 'devto',
    account: 'default',
    route: 'direct',
    kind: 'article',
    status,
    payload: { title: 'T' },
    payloadSha256: 'f'.repeat(64),
    authorship: 'reformatted',
    lint: [],
    ...extra,
  });
}

function addApproval(id: string, draftId: string, status: 'pending' | 'approved' | 'denied' | 'expired'): void {
  repos.approvals.insert({
    id,
    draftId,
    payloadSha256: 'f'.repeat(64),
    channel: 'dashboard_hello',
    mode: 'publish_now',
    status,
    expiresAt: '2026-10-19T10:30:00.000Z',
  });
}

const editPost = (slug: string): void =>
  writeFileSync(postPath(slug), readFileSync(postPath(slug), 'utf8').replace('Body', 'Body') + '\nOne more paragraph.\n');

describe('syncContent: ingestion', () => {
  it('upserts every post with hashes, commit, dirty flag and frontmatter fields', async () => {
    const result = await syncContent(deps(fakeFetch()));
    expect(result).toMatchObject({ upserted: 2, changed: [], invalidatedApprovals: 0, errors: [] });
    const row = repos.content.get(SAMPLE);
    expect(row).toMatchObject({
      slug: SAMPLE,
      canonicalUrl: `https://www.example-blog.dev/blog/${SAMPLE}`,
      title: TITLES[SAMPLE],
      date: '2026-07-19',
      published: true,
      repoCommit: 'abc1234',
      dirty: false,
    });
    expect(row?.mdxSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.notesSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(repos.content.get(OTHER)?.notesSha256).toBeUndefined();
  });

  it('records dirty when git status reports the file', async () => {
    const dirtyGit: GitRunner = (args) =>
      Promise.resolve({ stdout: args.includes('rev-parse') ? 'abc1234\n' : ' M content/posts/sample-post.mdx\n' });
    await syncContent(deps(fakeFetch(), { reader: new SiteReader(repo, dirtyGit) }));
    expect(repos.content.get(SAMPLE)?.dirty).toBe(true);
  });

  it('sync twice with no change gives changed: [] and no audit entries', async () => {
    const log = fakeFetch();
    await syncContent(deps(log));
    const second = await syncContent(deps(log));
    expect(second).toMatchObject({ upserted: 2, changed: [], invalidatedApprovals: 0 });
    expect(repos.audit.list()).toEqual([]);
  });

  it('a CRLF + BOM rewrite of the same text is not a change (hashes are over normalised text)', async () => {
    await syncContent(deps(fakeFetch()));
    const before = repos.content.get(SAMPLE)?.mdxSha256;
    const lf = readFileSync(postPath(SAMPLE), 'utf8');
    writeFileSync(postPath(SAMPLE), '﻿' + lf.replace(/\r?\n/g, '\r\n'));
    const notes = readFileSync(notesPath(SAMPLE), 'utf8');
    writeFileSync(notesPath(SAMPLE), '﻿' + notes.replace(/\r?\n/g, '\r\n'));
    const result = await syncContent(deps(fakeFetch()));
    expect(result.changed).toEqual([]);
    expect(repos.content.get(SAMPLE)?.mdxSha256).toBe(before);
  });

  it('one unparseable post is reported and does not stop the others', async () => {
    writeFileSync(postPath('broken'), '---\ntitle: "No other fields"\n---\n\nBody\n');
    const result = await syncContent(deps(fakeFetch()));
    expect(result.upserted).toBe(2);
    expect(result.errors).toEqual([{ slug: 'broken', message: expect.any(String) }]);
    expect(repos.content.get('broken')).toBeUndefined();
  });
});

describe('syncContent: canonical-live gate and T0', () => {
  it('first pass records canonical_live_at (now) and t0 for a post that is live', async () => {
    await syncContent(deps(fakeFetch()));
    const row = repos.content.get(SAMPLE);
    expect(row?.canonicalLiveAt).toBe('2026-10-19T10:00:00.000Z');
    // dated 2026-07-19, first seen months later: T0 is the frontmatter date at 00:00 (UTC here)
    expect(row?.t0).toBe('2026-07-19T00:00:00.000Z');
  });

  it('uses the configured time zone for the frontmatter midnight', async () => {
    await syncContent(deps(fakeFetch(), { timeZone: 'Asia/Karachi' }));
    expect(repos.content.get(SAMPLE)?.t0).toBe('2026-07-18T19:00:00.000Z');
  });

  it('does not re-check, and never moves canonical_live_at, once a post has passed', async () => {
    const log = fakeFetch();
    await syncContent(deps(log));
    expect(log.urls).toHaveLength(2);
    clock = new Date('2026-10-20T10:00:00.000Z');
    await syncContent(deps(log));
    expect(log.urls).toHaveLength(2);
    const row = repos.content.get(SAMPLE);
    expect(row?.canonicalLiveAt).toBe('2026-10-19T10:00:00.000Z');
    expect(row?.t0).toBe('2026-07-19T00:00:00.000Z');
  });

  it('a post that is not live yet gets no canonical_live_at or t0, and is retried next sync', async () => {
    const notYet = (url: string): Response | undefined =>
      url.endsWith(SAMPLE) ? new Response('<h1>404</h1>', { status: 404 }) : undefined;
    const first = fakeFetch(notYet);
    await syncContent(deps(first));
    expect(repos.content.get(SAMPLE)).toMatchObject({ published: true });
    expect(repos.content.get(SAMPLE)?.canonicalLiveAt).toBeUndefined();
    expect(repos.content.get(SAMPLE)?.t0).toBeUndefined();
    expect(repos.content.get(OTHER)?.canonicalLiveAt).toBeDefined();

    clock = new Date('2026-10-22T09:00:00.000Z');
    const second = fakeFetch();
    await syncContent(deps(second));
    expect(second.urls.map((u) => u.split('/').pop())).toEqual([SAMPLE]);
    expect(repos.content.get(SAMPLE)?.canonicalLiveAt).toBe('2026-10-22T09:00:00.000Z');
  });

  it('a late deploy sets t0 to canonical_live_at', async () => {
    writeFileSync(
      postPath(SAMPLE),
      readFileSync(postPath(SAMPLE), 'utf8').replace('date: "2026-07-19"', 'date: "2026-10-19"'),
    );
    clock = new Date('2026-10-22T09:00:00.000Z');
    await syncContent(deps(fakeFetch()));
    expect(repos.content.get(SAMPLE)?.t0).toBe('2026-10-22T09:00:00.000Z');
  });

  it('published: false is never fetched', async () => {
    writeFileSync(
      postPath(SAMPLE),
      readFileSync(postPath(SAMPLE), 'utf8').replace('published: true', 'published: false'),
    );
    const log = fakeFetch();
    await syncContent(deps(log));
    expect(log.urls.map((u) => u.split('/').pop())).toEqual([OTHER]);
    expect(repos.content.get(SAMPLE)).toMatchObject({ published: false });
    expect(repos.content.get(SAMPLE)?.canonicalLiveAt).toBeUndefined();
  });

  it('a network failure on the live check leaves the post not-live and does not fail the sync', async () => {
    const down = { fetchFn: (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch, urls: [] };
    const result = await syncContent(deps(down));
    expect(result.upserted).toBe(2);
    expect(repos.content.get(SAMPLE)?.canonicalLiveAt).toBeUndefined();
  });
});

describe('syncContent: source changes (Review Focus #1)', () => {
  it('after editing the MDX: an approved approval becomes invalidated and the draft becomes source_changed', async () => {
    const log = fakeFetch();
    await syncContent(deps(log));
    addDraft('d1', SAMPLE, 'approved');
    addApproval('a1', 'd1', 'approved');

    editPost(SAMPLE);
    clock = new Date('2026-10-19T11:00:00.000Z');
    const result = await syncContent(deps(log));

    expect(result.changed).toEqual([SAMPLE]);
    expect(result.invalidatedApprovals).toBe(1);
    expect(repos.drafts.get('d1')?.status).toBe('source_changed');
    expect(repos.approvals.get('a1')?.status).toBe('invalidated');
    // an invalidated approval can never be consumed
    expect(repos.approvals.consume('a1')).toBe(false);
    const audit = repos.audit.list({ draftId: 'd1' });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'source_changed', draftId: 'd1', platform: 'devto' });
    expect(audit[0]?.detail).toMatchObject({ slug: SAMPLE, from: 'approved', invalidatedApprovals: ['a1'] });
  });

  it('flags every draft of the slug in draft|staged|pending_approval|approved|scheduled|failed|held, and only those', async () => {
    const log = fakeFetch();
    await syncContent(deps(log));
    const flagged = ['draft', 'staged', 'pending_approval', 'approved', 'scheduled', 'failed', 'held'] as const;
    const untouched = ['publishing', 'unknown', 'published', 'handed_off', 'source_changed'] as const;
    // The flagged list is exactly the gate's allowlist, so the gate never accepts a draft sync would not stop.
    expect([...LIVE_DRAFT_STATUSES].sort()).toEqual([...flagged].sort());
    for (const status of [...flagged, ...untouched]) addDraft(`s-${status}`, SAMPLE, status);
    addDraft('other-slug', OTHER, 'approved');
    addApproval('a-other', 'other-slug', 'approved');

    editPost(SAMPLE);
    await syncContent(deps(log));

    for (const status of flagged) expect(repos.drafts.get(`s-${status}`)?.status).toBe('source_changed');
    for (const status of untouched) expect(repos.drafts.get(`s-${status}`)?.status).toBe(status);
    expect(repos.drafts.get('other-slug')?.status).toBe('approved');
    expect(repos.approvals.get('a-other')?.status).toBe('approved');
  });

  it.each(['failed', 'held'] as const)('a %s draft that a human re-approved is flagged and its approvals invalidated', async (status) => {
    const log = fakeFetch();
    await syncContent(deps(log));
    addDraft('d1', SAMPLE, status);
    addApproval('a-pending', 'd1', 'pending');
    addApproval('a-approved', 'd1', 'approved');

    editPost(SAMPLE);
    const result = await syncContent(deps(log));

    expect(result.invalidatedApprovals).toBe(2);
    expect(repos.drafts.get('d1')?.status).toBe('source_changed');
    expect(repos.approvals.get('a-pending')?.status).toBe('invalidated');
    expect(repos.approvals.get('a-approved')?.status).toBe('invalidated');
  });

  it('invalidates pending and approved approvals only (denied and expired stay as they were)', async () => {
    const log = fakeFetch();
    await syncContent(deps(log));
    addDraft('d1', SAMPLE, 'pending_approval');
    addApproval('a-pending', 'd1', 'pending');
    addApproval('a-approved', 'd1', 'approved');
    addApproval('a-denied', 'd1', 'denied');
    addApproval('a-expired', 'd1', 'expired');

    editPost(SAMPLE);
    const result = await syncContent(deps(log));

    expect(result.invalidatedApprovals).toBe(2);
    expect(repos.approvals.get('a-pending')?.status).toBe('invalidated');
    expect(repos.approvals.get('a-approved')?.status).toBe('invalidated');
    expect(repos.approvals.get('a-denied')?.status).toBe('denied');
    expect(repos.approvals.get('a-expired')?.status).toBe('expired');
  });

  it('a change to the publishing notes alone also flags the drafts', async () => {
    const log = fakeFetch();
    await syncContent(deps(log));
    addDraft('d1', SAMPLE, 'approved');
    addApproval('a1', 'd1', 'approved');

    writeFileSync(notesPath(SAMPLE), readFileSync(notesPath(SAMPLE), 'utf8') + '\n- one more thing to verify\n');
    const result = await syncContent(deps(log));

    expect(result.changed).toEqual([SAMPLE]);
    expect(repos.drafts.get('d1')?.status).toBe('source_changed');
    expect(repos.approvals.get('a1')?.status).toBe('invalidated');
    expect(repos.audit.list({ draftId: 'd1' })[0]?.detail).toMatchObject({ mdxChanged: false, notesChanged: true });
  });

  it('adding or removing the notes file counts as a change', async () => {
    const log = fakeFetch();
    await syncContent(deps(log));
    addDraft('d1', OTHER, 'staged');

    copyFileSync(join(FIXTURES, 'sample-notes.md'), notesPath(OTHER));
    expect((await syncContent(deps(log))).changed).toEqual([OTHER]);
    expect(repos.drafts.get('d1')?.status).toBe('source_changed');

    addDraft('d2', OTHER, 'staged');
    rmSync(notesPath(OTHER));
    expect((await syncContent(deps(log))).changed).toEqual([OTHER]);
    expect(repos.drafts.get('d2')?.status).toBe('source_changed');
    expect(repos.content.get(OTHER)?.notesSha256).toBeUndefined();
  });

  it('keeps canonical_live_at and t0 across a source change', async () => {
    const log = fakeFetch();
    await syncContent(deps(log));
    const before = repos.content.get(SAMPLE);
    editPost(SAMPLE);
    clock = new Date('2026-10-25T00:00:00.000Z');
    await syncContent(deps(log));
    const after = repos.content.get(SAMPLE);
    expect(after?.mdxSha256).not.toBe(before?.mdxSha256);
    expect(after?.canonicalLiveAt).toBe(before?.canonicalLiveAt);
    expect(after?.t0).toBe(before?.t0);
  });

  it('a second sync after the change does not flag again (the new hash is stored)', async () => {
    const log = fakeFetch();
    await syncContent(deps(log));
    addDraft('d1', SAMPLE, 'approved');
    editPost(SAMPLE);
    await syncContent(deps(log));
    const again = await syncContent(deps(log));
    expect(again.changed).toEqual([]);
    expect(repos.audit.list({ draftId: 'd1' })).toHaveLength(1);
  });

  it('calls onInvalidated once, with only the drafts that hold a remote scheduled post', async () => {
    const log = fakeFetch();
    await syncContent(deps(log));
    addDraft('local', SAMPLE, 'approved');
    addDraft('remote', SAMPLE, 'scheduled', { remoteScheduledId: 'buf-123' });
    const calls: string[][] = [];

    editPost(SAMPLE);
    await syncContent(
      deps(log, {
        onInvalidated: (ids) => {
          calls.push(ids);
          return Promise.resolve();
        },
      }),
    );
    expect(calls).toEqual([['remote']]);
    // the remote id is kept so a failed cancellation can still be retried
    expect(repos.drafts.get('remote')?.remoteScheduledId).toBe('buf-123');
  });

  it('does not call onInvalidated when no draft holds a remote scheduled post', async () => {
    const log = fakeFetch();
    await syncContent(deps(log));
    addDraft('local', SAMPLE, 'approved');
    let called = false;
    editPost(SAMPLE);
    await syncContent(
      deps(log, {
        onInvalidated: () => {
          called = true;
          return Promise.resolve();
        },
      }),
    );
    expect(called).toBe(false);
  });

  it('if remote cancellation fails the local flags stay, the failure is audited, and the error surfaces', async () => {
    const log = fakeFetch();
    await syncContent(deps(log));
    addDraft('remote', SAMPLE, 'scheduled', { remoteScheduledId: 'buf-123' });
    addApproval('a1', 'remote', 'approved');
    editPost(SAMPLE);

    await expect(
      syncContent(deps(log, { onInvalidated: () => Promise.reject(new Error('buffer is down')) })),
    ).rejects.toThrow('buffer is down');
    expect(repos.drafts.get('remote')?.status).toBe('source_changed');
    expect(repos.approvals.get('a1')?.status).toBe('invalidated');
    const actions = repos.audit.list({ draftId: 'remote' }).map((e) => e.action);
    expect(actions).toContain('source_changed');
    expect(actions).toContain('remote_cancel_failed');
  });

  describe('a known post that becomes unreadable or vanishes still stops its drafts', () => {
    async function approvedDraftOnSample(): Promise<FetchLog> {
      const log = fakeFetch();
      await syncContent(deps(log));
      addDraft('d1', SAMPLE, 'approved');
      addApproval('a1', 'd1', 'approved');
      return log;
    }

    function expectStopped(reason: string): void {
      expect(repos.drafts.get('d1')?.status).toBe('source_changed');
      expect(repos.approvals.get('a1')?.status).toBe('invalidated');
      expect(repos.approvals.consume('a1')).toBe(false);
      const audit = repos.audit.list({ draftId: 'd1' });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ action: 'source_changed', draftId: 'd1' });
      expect(audit[0]?.detail).toMatchObject({ slug: SAMPLE, from: 'approved', reason, invalidatedApprovals: ['a1'] });
    }

    it('(a) broken frontmatter: invalidated, and the error is still reported', async () => {
      const log = await approvedDraftOnSample();
      writeFileSync(postPath(SAMPLE), '---\ntitle: "Only a title"\n---\n\nBody\n');
      const result = await syncContent(deps(log));
      expect(result.errors).toEqual([{ slug: SAMPLE, message: expect.any(String) }]);
      expect(result.invalidatedApprovals).toBe(1);
      expect(result.changed).toEqual([SAMPLE]);
      expectStopped('unparseable');
    });

    it('(b) file removed: invalidated, content row kept', async () => {
      const log = await approvedDraftOnSample();
      rmSync(postPath(SAMPLE));
      const result = await syncContent(deps(log));
      expect(result.invalidatedApprovals).toBe(1);
      expect(result.changed).toEqual([SAMPLE]);
      expect(result.upserted).toBe(1);
      expectStopped('removed');
      expect(repos.content.get(SAMPLE)).toBeDefined();
    });

    it('(c) bad date: invalidated', async () => {
      const log = await approvedDraftOnSample();
      writeFileSync(
        postPath(SAMPLE),
        readFileSync(postPath(SAMPLE), 'utf8').replace('date: "2026-07-19"', 'date: "2026-02-30"'),
      );
      const result = await syncContent(deps(log));
      expect(result.errors).toHaveLength(1);
      expect(result.invalidatedApprovals).toBe(1);
      expectStopped('unparseable');
    });

    it('is quiet on the next sync: nothing is flagged or audited twice', async () => {
      const log = await approvedDraftOnSample();
      rmSync(postPath(SAMPLE));
      await syncContent(deps(log));
      const again = await syncContent(deps(log));
      expect(again.changed).toEqual([]);
      expect(again.invalidatedApprovals).toBe(0);
      expect(repos.audit.list({ draftId: 'd1' })).toHaveLength(1);
    });

    it('a post that was never ingested has nothing to invalidate; it is only an error', async () => {
      writeFileSync(postPath('broken'), '---\ntitle: "x"\n---\n');
      const result = await syncContent(deps(fakeFetch()));
      expect(result.errors).toHaveLength(1);
      expect(result.changed).toEqual([]);
      expect(repos.audit.list()).toEqual([]);
    });

    it('calls onInvalidated for drafts that hold a remote scheduled post', async () => {
      const log = await approvedDraftOnSample();
      addDraft('remote', SAMPLE, 'scheduled', { remoteScheduledId: 'buf-9' });
      writeFileSync(postPath(SAMPLE), 'not frontmatter at all');
      const calls: string[][] = [];
      await syncContent(
        deps(log, {
          onInvalidated: (ids) => {
            calls.push(ids);
            return Promise.resolve();
          },
        }),
      );
      expect(calls).toEqual([['remote']]);
      expect(repos.drafts.get('remote')?.status).toBe('source_changed');
    });

    it('a git failure is an error but does not invalidate anything (the source itself is fine)', async () => {
      const log = await approvedDraftOnSample();
      const brokenGit: GitRunner = (args) =>
        args.includes('rev-parse') ? Promise.resolve({ stdout: 'abc1234\n' }) : Promise.reject(new Error('git exploded'));
      const result = await syncContent(deps(log, { reader: new SiteReader(repo, brokenGit) }));
      expect(result.errors.map((e) => e.message)).toEqual(['git exploded', 'git exploded']);
      expect(repos.drafts.get('d1')?.status).toBe('approved');
      expect(repos.approvals.get('a1')?.status).toBe('approved');
    });
  });

  it('never writes to the site repo', async () => {
    const files = (): string[] => [postPath(SAMPLE), postPath(OTHER), notesPath(SAMPLE)].map((p) => readFileSync(p, 'utf8'));
    const before = files();
    await syncContent(deps(fakeFetch()));
    expect(files()).toEqual(before);
  });
});
