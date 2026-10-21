import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Draft } from '@cph/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_REPO_PATH, loadConfig } from '../src/config.js';
import { openDb, type Db } from '../src/db/open.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import { createRepos, dryRunKey, type NewDraft, type Repos } from '../src/db/repos.js';
import { configPath, dbPath, stateDir } from '../src/paths.js';

let dir: string;

beforeEach(() => {
  // A space in the name: every Windows path in this project may contain one.
  dir = mkdtempSync(join(tmpdir(), 'cph daemon '));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const T0 = '2026-10-19T10:00:00.000Z';

function fixedClock(start = T0): { now: () => string; set: (iso: string) => void } {
  let current = start;
  return { now: () => current, set: (iso) => void (current = iso) };
}

function seed(repos: Repos, slug = 'prometheus-cardinality-explained'): void {
  repos.content.upsert({
    slug,
    canonicalUrl: `https://www.example-blog.dev/blog/${slug}`,
    title: 'Cardinality',
    date: '2026-09-01',
    mdxSha256: 'a'.repeat(64),
    repoCommit: 'abc1234',
    dirty: false,
    published: true,
  });
}

function newDraft(overrides: Partial<NewDraft> = {}): NewDraft {
  return {
    id: 'd1',
    slug: 'prometheus-cardinality-explained',
    platform: 'devto',
    account: 'default',
    route: 'direct',
    kind: 'article',
    status: 'draft',
    payload: { title: 'T', tags: ['a'] },
    payloadSha256: 'f'.repeat(64),
    authorship: 'reformatted',
    lint: [],
    ...overrides,
  };
}

function open(): { db: Db; repos: Repos; clock: ReturnType<typeof fixedClock> } {
  const db = openDb(':memory:');
  const clock = fixedClock();
  return { db, repos: createRepos(db, { now: clock.now }), clock };
}

describe('paths', () => {
  it('honours CPH_STATE_DIR', () => {
    expect(stateDir({ CPH_STATE_DIR: dir })).toBe(dir);
  });

  it('falls back to %LOCALAPPDATA%\\content-powerhouse', () => {
    expect(stateDir({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' })).toBe(
      join('C:\\Users\\x\\AppData\\Local', 'content-powerhouse'),
    );
  });

  it('puts cph.db and config.json inside the state dir', () => {
    expect(dbPath(dir)).toBe(join(dir, 'cph.db'));
    expect(configPath(dir)).toBe(join(dir, 'config.json'));
  });

  it('reads CPH_STATE_DIR from the process env by default', () => {
    const before = process.env['CPH_STATE_DIR'];
    process.env['CPH_STATE_DIR'] = dir;
    try {
      expect(stateDir()).toBe(dir);
    } finally {
      if (before === undefined) delete process.env['CPH_STATE_DIR'];
      else process.env['CPH_STATE_DIR'] = before;
    }
  });
});

describe('loadConfig', () => {
  it('returns defaults when config.json is missing and does not write it', () => {
    const cfg = loadConfig({ stateDir: dir });
    expect(cfg.site.repoPath).toBe(DEFAULT_REPO_PATH);
    expect(cfg.site.repoPath).toBe('C:\\path\\to\\your-site');
    expect(cfg.site.baseUrl).toBe('https://www.example-blog.dev');
    expect(cfg.site.timeZone).toEqual(expect.any(String));
    expect(cfg.daemon.port).toBe(4646);
    expect(cfg.claude.askOnPublish).toBe(true);
    expect(cfg.approval).toEqual({ mode: 'click' });
    expect(cfg.platforms).toEqual({});
    expect(existsSync(join(dir, 'config.json'))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('merges a partial file over the defaults, tolerating a BOM', () => {
    writeFileSync(
      join(dir, 'config.json'),
      '\uFEFF' +
        JSON.stringify({
          site: { timeZone: 'Asia/Karachi' },
          claude: { askOnPublish: false },
          platforms: { linkedin: { route: 'buffer', bufferChannelId: 'ch1' }, devto: { tagPreference: ['sre'] } },
        }),
    );
    const cfg = loadConfig({ stateDir: dir });
    expect(cfg.site.timeZone).toBe('Asia/Karachi');
    expect(cfg.site.repoPath).toBe(DEFAULT_REPO_PATH);
    expect(cfg.claude.askOnPublish).toBe(false);
    expect(cfg.platforms.linkedin).toEqual({ route: 'buffer', bufferChannelId: 'ch1', linkCard: false });
    expect(cfg.platforms.devto).toEqual({ tagPreference: ['sre'] });
  });

  it('reads approval.mode (hello or click) and rejects anything else', () => {
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ approval: { mode: 'hello' } }));
    expect(loadConfig({ stateDir: dir }).approval.mode).toBe('hello');
    writeFileSync(file, JSON.stringify({ approval: { mode: 'none' } }));
    expect(() => loadConfig({ stateDir: dir })).toThrow(/approval.mode/);
  });

  it('accepts an explicit file path', () => {
    const file = join(dir, 'other.json');
    writeFileSync(file, JSON.stringify({ site: { repoPath: 'E:\\a b\\site' } }));
    expect(loadConfig({ path: file }).site.repoPath).toBe('E:\\a b\\site');
  });

  it('rejects a bad route and names the file', () => {
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ platforms: { linkedin: { route: 'direct' } } }));
    expect(() => loadConfig({ stateDir: dir })).toThrow(/config\.json/);
  });

  it('rejects invalid JSON and names the file', () => {
    writeFileSync(join(dir, 'config.json'), '{ nope');
    expect(() => loadConfig({ stateDir: dir })).toThrow(/config\.json/);
  });
});

describe('openDb / migrations', () => {
  it('is idempotent: opening the same file twice keeps data and version', () => {
    const file = join(dir, 'cph.db');
    const first = openDb(file);
    createRepos(first, { now: () => T0 }).settings.set('x', '1');
    expect(first.pragma('user_version', { simple: true })).toBe(3);
    first.close();

    const second = openDb(file);
    expect(second.pragma('user_version', { simple: true })).toBe(3);
    expect(createRepos(second, { now: () => T0 }).settings.get('x')).toBe('1');
    expect(createRepos(second, { now: () => T0 }).settings.get('publishing_enabled')).toBe('false');
    second.close();
  });

  it('applies WAL on a file database and creates the parent directory', () => {
    const file = join(dir, 'nested', 'cph.db');
    const db = openDb(file);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('syncs every commit to disk (synchronous = FULL), so a consumed approval survives a power loss', () => {
    // Under WAL, NORMAL can lose the last commits on power loss: the approval would be unconsumed
    // again after a reboot, and one approval could give two posts.
    const db = openDb(join(dir, 'cph.db'));
    expect(db.pragma('synchronous', { simple: true })).toBe(2);
    db.close();
  });

  it('refuses a database written by a newer schema', () => {
    const file = join(dir, 'cph.db');
    mkdirSync(dir, { recursive: true });
    const db = openDb(file);
    db.pragma('user_version = 99');
    db.close();
    expect(() => openDb(file)).toThrow(/newer/);
  });

  it('upgrades a v1 database to v2: drafts gain nullable source hash columns, old rows keep working', () => {
    const file = join(dir, 'cph.db');
    const v1 = openDb(file, MIGRATIONS.filter((m) => m.version === 1));
    seed(createRepos(v1, { now: () => T0 }));
    // A row as the v1 build wrote it (its repos know nothing of the source columns).
    v1.prepare(
      `INSERT INTO drafts (id, slug, platform, account, route, kind, payload_json, payload_sha256, authorship, status, created_at, updated_at)
       VALUES ('old', 'prometheus-cardinality-explained', 'devto', 'default', 'direct', 'article', '{}', ?, 'reformatted', 'draft', ?, ?)`,
    ).run('f'.repeat(64), T0, T0);
    v1.close();

    const v2 = openDb(file);
    expect(v2.pragma('user_version', { simple: true })).toBe(3);
    const repos = createRepos(v2, { now: () => T0 });
    const legacy = repos.drafts.get('old');
    expect(legacy).toBeDefined();
    expect(legacy && 'sourceMdxSha256' in legacy).toBe(false);
    repos.drafts.insert(newDraft({ id: 'new', sourceMdxSha256: 'b'.repeat(64), sourceNotesSha256: 'c'.repeat(64) }));
    expect(repos.drafts.get('new')).toMatchObject({ sourceMdxSha256: 'b'.repeat(64), sourceNotesSha256: 'c'.repeat(64) });
    v2.close();
  });

  it('upgrades a v2 database to v3: approvals and the jobs that reference them survive, and the two new channels are accepted', () => {
    const file = join(dir, 'cph.db');
    const v2 = openDb(file, MIGRATIONS.filter((m) => m.version <= 2));
    const before = createRepos(v2, { now: () => T0 });
    seed(before);
    before.drafts.insert(newDraft());
    before.approvals.insert({ id: 'ap-old', draftId: 'd1', payloadSha256: 'f'.repeat(64), channel: 'dashboard_hello', mode: 'approve_only', status: 'approved', presenceVerifiedAt: T0, expiresAt: T0 });
    v2.prepare("INSERT INTO jobs (id, draft_id, approval_id, run_at, status) VALUES ('j1', 'd1', 'ap-old', ?, 'pending')").run(T0);
    expect(() => before.approvals.insert({ id: 'ap-x', draftId: 'd1', payloadSha256: 'f'.repeat(64), channel: 'dashboard_click', mode: 'approve_only', status: 'pending', expiresAt: T0 })).toThrow();
    v2.close();

    const v3 = openDb(file);
    expect(v3.pragma('user_version', { simple: true })).toBe(3);
    expect(v3.pragma('foreign_key_check')).toEqual([]);
    const repos = createRepos(v3, { now: () => T0 });
    expect(repos.approvals.get('ap-old')).toMatchObject({ channel: 'dashboard_hello', mode: 'approve_only', status: 'approved', presenceVerifiedAt: T0 });
    expect(v3.prepare("SELECT approval_id FROM jobs WHERE id = 'j1'").get()).toEqual({ approval_id: 'ap-old' });
    for (const channel of ['dashboard_click', 'chat_elicitation'] as const) {
      repos.approvals.insert({ id: `ap-${channel}`, draftId: 'd1', payloadSha256: 'f'.repeat(64), channel, mode: 'approve_only', status: 'pending', expiresAt: T0 });
      expect(repos.approvals.get(`ap-${channel}`)?.channel).toBe(channel);
    }
    expect(() => repos.approvals.insert({ id: 'ap-bad', draftId: 'd1', payloadSha256: 'f'.repeat(64), channel: 'telepathy' as never, mode: 'approve_only', status: 'pending', expiresAt: T0 })).toThrow();
    v3.close();
  });

  it('creates the spec 2.7 tables', () => {
    const { db } = open();
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const t of [
      'content',
      'assets',
      'drafts',
      'approvals',
      'api_budget',
      'settings',
      'jobs',
      'publications',
      'connections',
      'credentials',
      'spend',
      'audit_log',
    ]) {
      expect(names).toContain(t);
    }
  });
});

describe('settings', () => {
  it("seeds publishing_enabled='false' on a fresh DB", () => {
    const { repos } = open();
    expect(repos.settings.get('publishing_enabled')).toBe('false');
  });

  it('round-trips values, overwrites, and returns undefined for unknown keys', () => {
    const { repos } = open();
    expect(repos.settings.get('nope')).toBeUndefined();
    repos.settings.set(dryRunKey('linkedin'), 'true');
    expect(repos.settings.get('dry_run:linkedin')).toBe('true');
    repos.settings.set('dry_run:linkedin', 'false');
    expect(repos.settings.get('dry_run:linkedin')).toBe('false');
  });
});

describe('content', () => {
  it('upserts, gets and lists with the injected clock', () => {
    const { repos, clock } = open();
    seed(repos);
    const got = repos.content.get('prometheus-cardinality-explained');
    expect(got).toMatchObject({ title: 'Cardinality', dirty: false, published: true, syncedAt: T0 });
    expect(got?.notesSha256).toBeUndefined();

    clock.set('2026-10-20T00:00:00.000Z');
    repos.content.upsert({
      ...got!,
      title: 'Cardinality 2',
      dirty: true,
      notesSha256: 'b'.repeat(64),
      canonicalLiveAt: '2026-10-19T12:00:00.000Z',
      t0: '2026-10-19T12:00:00.000Z',
    });
    expect(repos.content.list()).toHaveLength(1);
    expect(repos.content.get('prometheus-cardinality-explained')).toMatchObject({
      title: 'Cardinality 2',
      dirty: true,
      notesSha256: 'b'.repeat(64),
      t0: '2026-10-19T12:00:00.000Z',
      syncedAt: '2026-10-20T00:00:00.000Z',
    });
    expect(repos.content.get('missing')).toBeUndefined();
  });
});

describe('drafts', () => {
  it('inserts and reads back a full Draft', () => {
    const { repos } = open();
    seed(repos);
    const inserted = repos.drafts.insert(newDraft({ notBefore: '2026-10-21T00:00:00.000Z' }));
    const expected: Draft = {
      ...newDraft({ notBefore: '2026-10-21T00:00:00.000Z' }),
      createdAt: T0,
      updatedAt: T0,
    };
    expect(inserted).toEqual(expected);
    expect(repos.drafts.get('d1')).toEqual(expected);
    expect(repos.drafts.get('nope')).toBeUndefined();
  });

  it('lists with filters', () => {
    const { repos } = open();
    seed(repos);
    seed(repos, 'other');
    repos.drafts.insert(newDraft({ id: 'a' }));
    repos.drafts.insert(newDraft({ id: 'b', platform: 'linkedin', route: 'buffer', kind: 'post' }));
    repos.drafts.insert(newDraft({ id: 'c', slug: 'other', status: 'staged' }));
    expect(repos.drafts.list().map((d) => d.id)).toEqual(['a', 'b', 'c']);
    expect(repos.drafts.list({ slug: 'other' }).map((d) => d.id)).toEqual(['c']);
    expect(repos.drafts.list({ platform: 'linkedin' }).map((d) => d.id)).toEqual(['b']);
    expect(repos.drafts.list({ status: 'staged' }).map((d) => d.id)).toEqual(['c']);
  });

  it('updates, bumps updatedAt, and clears optional fields with null', () => {
    const { repos, clock } = open();
    seed(repos);
    repos.drafts.insert(newDraft({ remoteScheduledId: 'rs1' }));
    clock.set('2026-10-19T11:00:00.000Z');
    expect(
      repos.drafts.update('d1', { status: 'staged', remoteRef: 'art1', remoteScheduledId: null, payload: { title: 'T2' } }),
    ).toBe(true);
    const d = repos.drafts.get('d1')!;
    expect(d).toMatchObject({ status: 'staged', remoteRef: 'art1', payload: { title: 'T2' }, createdAt: T0 });
    expect(d.updatedAt).toBe('2026-10-19T11:00:00.000Z');
    expect(d.remoteScheduledId).toBeUndefined();
    expect(repos.drafts.update('missing', { status: 'failed' })).toBe(false);
  });

  it('refuses an update when expectedSha does not match the stored hash', () => {
    const { repos } = open();
    seed(repos);
    repos.drafts.insert(newDraft());
    expect(repos.drafts.update('d1', { status: 'approved' }, '0'.repeat(64))).toBe(false);
    expect(repos.drafts.get('d1')?.status).toBe('draft');
    expect(repos.drafts.update('d1', { status: 'approved' }, 'f'.repeat(64))).toBe(true);
    expect(repos.drafts.get('d1')?.status).toBe('approved');
  });

  it('rejects an unknown status at the database level', () => {
    const { repos } = open();
    seed(repos);
    expect(() => repos.drafts.insert(newDraft({ status: 'bogus' as never }))).toThrow();
  });

  it('rejects a draft for an unsynced slug', () => {
    const { repos } = open();
    expect(() => repos.drafts.insert(newDraft())).toThrow();
  });
});

describe('approvals', () => {
  function withApproval(): { repos: Repos; clock: ReturnType<typeof fixedClock> } {
    const o = open();
    seed(o.repos);
    o.repos.drafts.insert(newDraft());
    o.repos.approvals.insert({
      id: 'ap1',
      draftId: 'd1',
      payloadSha256: 'f'.repeat(64),
      channel: 'dashboard_hello',
      mode: 'publish_now',
      status: 'pending',
      expiresAt: '2026-10-19T10:30:00.000Z',
    });
    return o;
  }

  it('inserts pending, then setStatus records the decision and presence', () => {
    const { repos, clock } = withApproval();
    expect(repos.approvals.get('ap1')).toMatchObject({ status: 'pending', mode: 'publish_now' });
    expect(repos.approvals.get('ap1')?.usedAt).toBeUndefined();
    clock.set('2026-10-19T10:05:00.000Z');
    repos.approvals.setStatus('ap1', 'approved', { presenceVerifiedAt: '2026-10-19T10:04:59.000Z' });
    expect(repos.approvals.get('ap1')).toMatchObject({
      status: 'approved',
      decidedAt: '2026-10-19T10:05:00.000Z',
      presenceVerifiedAt: '2026-10-19T10:04:59.000Z',
    });
  });

  it('setStatus with from is a guarded compare-and-set and records channel, mode and expiry', () => {
    const { repos } = withApproval();
    repos.approvals.setStatus('ap1', 'denied');
    expect(repos.approvals.setStatus('ap1', 'approved', { from: 'pending' })).toBe(false);
    expect(repos.approvals.get('ap1')?.status).toBe('denied');

    const other = withApproval().repos;
    expect(
      other.approvals.setStatus('ap1', 'approved', {
        from: 'pending',
        channel: 'elicitation',
        mode: 'schedule',
        expiresAt: '2026-10-19T12:15:00.000Z',
      }),
    ).toBe(true);
    expect(other.approvals.get('ap1')).toMatchObject({
      status: 'approved',
      channel: 'elicitation',
      mode: 'schedule',
      expiresAt: '2026-10-19T12:15:00.000Z',
    });
  });

  it('consume returns true once and then false', () => {
    const { repos } = withApproval();
    repos.approvals.setStatus('ap1', 'approved');
    expect(repos.approvals.consume('ap1')).toBe(true);
    expect(repos.approvals.consume('ap1')).toBe(false);
    expect(repos.approvals.get('ap1')?.usedAt).toBe(T0);
  });

  it('consume is false for a pending, denied or unknown approval', () => {
    const { repos } = withApproval();
    expect(repos.approvals.consume('ap1')).toBe(false);
    repos.approvals.setStatus('ap1', 'denied');
    expect(repos.approvals.consume('ap1')).toBe(false);
    expect(repos.approvals.consume('nope')).toBe(false);
    expect(repos.approvals.get('ap1')?.usedAt).toBeUndefined();
  });

  it('two concurrent consume calls give exactly one true', async () => {
    const { repos } = withApproval();
    repos.approvals.setStatus('ap1', 'approved');
    const results = await Promise.all([
      Promise.resolve().then(() => repos.approvals.consume('ap1')),
      Promise.resolve().then(() => repos.approvals.consume('ap1')),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.sort()).toEqual([false, true]);
  });

  it('two connections to one file also yield exactly one true', () => {
    const file = join(dir, 'cph.db');
    const a = openDb(file);
    const repoA = createRepos(a, { now: () => T0 });
    seed(repoA);
    repoA.drafts.insert(newDraft());
    repoA.approvals.insert({
      id: 'ap1',
      draftId: 'd1',
      payloadSha256: 'f'.repeat(64),
      channel: 'dashboard_hello',
      mode: 'approve_only',
      status: 'approved',
      expiresAt: '2026-10-19T10:30:00.000Z',
    });
    const b = openDb(file);
    const repoB = createRepos(b, { now: () => T0 });
    expect([repoA.approvals.consume('ap1'), repoB.approvals.consume('ap1')].sort()).toEqual([false, true]);
    a.close();
    b.close();
  });

  it('transaction rolls back the consume when the callback throws', () => {
    const { repos } = withApproval();
    repos.approvals.setStatus('ap1', 'approved');
    expect(() =>
      repos.transaction(() => {
        expect(repos.approvals.consume('ap1')).toBe(true);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(repos.approvals.consume('ap1')).toBe(true);
  });
});

describe('publications', () => {
  it('finds a publication by platform and payload hash', () => {
    const { repos } = open();
    seed(repos);
    repos.drafts.insert(newDraft());
    repos.publications.insert({
      id: 'p1',
      draftId: 'd1',
      platform: 'devto',
      account: 'default',
      payloadSha256: 'f'.repeat(64),
      remoteId: '123',
      remoteUrl: 'https://dev.to/x/y',
      publishedAt: '2026-10-19T10:10:00.000Z',
      costUsd: 0,
    });
    expect(repos.publications.findByHash('devto', 'f'.repeat(64))).toMatchObject({ id: 'p1', remoteId: '123', costUsd: 0 });
    expect(repos.publications.findByHash('linkedin', 'f'.repeat(64))).toBeUndefined();
    expect(repos.publications.findByHash('devto', '0'.repeat(64))).toBeUndefined();
  });
});

describe('connections', () => {
  it('upserts by (platform, account), gets and lists', () => {
    const { repos } = open();
    repos.connections.upsert({ platform: 'devto', account: 'default', route: 'direct', status: 'connected' });
    repos.connections.upsert({
      platform: 'devto',
      account: 'default',
      route: 'direct',
      status: 'degraded',
      lastHealthAt: T0,
      lastHealthDetail: '429',
    });
    repos.connections.upsert({ platform: 'linkedin', account: 'me', route: 'buffer', status: 'connected', expiresAt: T0 });
    expect(repos.connections.get('devto', 'default')).toEqual({
      platform: 'devto',
      account: 'default',
      route: 'direct',
      status: 'degraded',
      lastHealthAt: T0,
      lastHealthDetail: '429',
    });
    expect(repos.connections.list().map((c) => c.platform)).toEqual(['devto', 'linkedin']);
    expect(repos.connections.get('x', 'y')).toBeUndefined();
  });
});

describe('credentials', () => {
  it('puts, gets, overwrites and deletes ciphertext', () => {
    const { repos } = open();
    const row = { platform: 'devto' as const, account: 'default', ciphertext: Buffer.from([1, 2, 3]), iv: Buffer.alloc(12, 7), tag: Buffer.alloc(16, 9) };
    repos.credentials.put(row);
    expect(repos.credentials.get('devto', 'default')).toEqual({ ...row, updatedAt: T0 });
    repos.credentials.put({ ...row, ciphertext: Buffer.from([4]) });
    expect(repos.credentials.get('devto', 'default')?.ciphertext).toEqual(Buffer.from([4]));
    expect(repos.credentials.delete('devto', 'default')).toBe(true);
    expect(repos.credentials.delete('devto', 'default')).toBe(false);
    expect(repos.credentials.get('devto', 'default')).toBeUndefined();
  });
});

describe('audit', () => {
  it('exposes append and list only', () => {
    const { repos } = open();
    expect(Object.keys(repos.audit)).toEqual(['append', 'list']);
  });

  it('appends with the injected clock and lists newest first', () => {
    const { repos, clock } = open();
    repos.audit.append({ actorChannel: 'dashboard_hello', action: 'approve', draftId: 'd1', approvalId: 'ap1', hash: 'f'.repeat(64), platform: 'devto', detail: { a: 1 } });
    clock.set('2026-10-19T10:01:00.000Z');
    repos.audit.append({ actorChannel: 'system', action: 'sweep' });
    const rows = repos.audit.list();
    expect(rows.map((r) => r.action)).toEqual(['sweep', 'approve']);
    expect(rows[1]).toMatchObject({ ts: T0, draftId: 'd1', approvalId: 'ap1', platform: 'devto', detail: { a: 1 } });
    expect(rows[0]?.detail).toBeUndefined();
    expect(repos.audit.list({ limit: 1 })).toHaveLength(1);
    expect(repos.audit.list({ draftId: 'd1' }).map((r) => r.action)).toEqual(['approve']);
  });

  it('the database itself refuses UPDATE and DELETE on audit_log', () => {
    const { db, repos } = open();
    repos.audit.append({ actorChannel: 'system', action: 'x' });
    expect(() => db.prepare("UPDATE audit_log SET action='y'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM audit_log').run()).toThrow(/append-only/);
    expect(repos.audit.list()).toHaveLength(1);
  });
});

describe('apiBudget', () => {
  it('records per window, replaces on repeat, and gets all windows for a provider', () => {
    const { repos, clock } = open();
    repos.apiBudget.record('buffer', '15m', 100, 90, '2026-10-19T10:15:00.000Z');
    repos.apiBudget.record('buffer', '24h', 250, 240, '2026-10-20T10:00:00.000Z');
    clock.set('2026-10-19T10:02:00.000Z');
    repos.apiBudget.record('buffer', '15m', 100, 80, '2026-10-19T10:15:00.000Z');
    repos.apiBudget.record('other', '30d', 10, 10, '2026-11-19T00:00:00.000Z');
    expect(repos.apiBudget.get('buffer')).toEqual([
      { provider: 'buffer', window: '15m', limit: 100, remaining: 80, resetsAt: '2026-10-19T10:15:00.000Z', observedAt: '2026-10-19T10:02:00.000Z' },
      { provider: 'buffer', window: '24h', limit: 250, remaining: 240, resetsAt: '2026-10-20T10:00:00.000Z', observedAt: T0 },
    ]);
    expect(repos.apiBudget.get('nobody')).toEqual([]);
  });
});
