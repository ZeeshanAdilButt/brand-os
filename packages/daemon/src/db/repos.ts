import type { Authorship, Draft, DraftKind, DraftStatus, LintResult, PlatformId, RouteKind } from '@cph/core';
import type { Db } from './open.js';

/**
 * Typed access to the state store. Every method is synchronous (better-sqlite3), which is what
 * makes `approvals.consume` an atomic compare-and-set: the UPDATE is one statement, and a second
 * caller sees `used_at` already set.
 *
 * Time never comes from `Date`: timestamps are either passed in by the caller or produced by the
 * injected `now()`. Optional fields read back as absent (not `null`).
 */
export interface RepoDeps {
  /** Returns the current time as an ISO-8601 UTC string. */
  now: () => string;
}

// ---- row shapes ------------------------------------------------------------------------------

export interface ContentRow {
  slug: string;
  canonicalUrl: string;
  title: string;
  /** Calendar date from frontmatter (YYYY-MM-DD). */
  date: string;
  mdxSha256: string;
  notesSha256?: string;
  repoCommit: string;
  dirty: boolean;
  published: boolean;
  canonicalLiveAt?: string;
  t0?: string;
  /** Set by the repo from the clock. */
  syncedAt: string;
}
export type ContentInput = Omit<ContentRow, 'syncedAt'>;

export type NewDraft<P = unknown> = Omit<Draft<P>, 'createdAt' | 'updatedAt'>;

/** Fields `drafts.update` may change. `null` clears an optional field. */
export interface DraftPatch<P = unknown> {
  status?: DraftStatus;
  payload?: P;
  payloadSha256?: string;
  authorship?: Authorship;
  lint?: LintResult[];
  notBefore?: string | null;
  scheduledAt?: string | null;
  remoteRef?: string | null;
  remoteScheduledId?: string | null;
  failureReason?: string | null;
}

export interface DraftFilter {
  slug?: string;
  platform?: PlatformId;
  status?: DraftStatus;
}

export type ApprovalChannel = 'dashboard_hello' | 'dashboard_click' | 'elicitation' | 'chat_elicitation';
export type ApprovalMode = 'publish_now' | 'approve_only' | 'schedule';
/** Not constrained in SQL: the gate (T0.13) owns the lifecycle. `consume` requires 'approved'. */
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'invalidated';

export interface Approval {
  id: string;
  draftId: string;
  payloadSha256: string;
  channel: ApprovalChannel;
  mode: ApprovalMode;
  status: ApprovalStatus;
  presenceVerifiedAt?: string;
  expiresAt: string;
  decidedAt?: string;
  usedAt?: string;
}
export type NewApproval = Omit<Approval, 'decidedAt' | 'usedAt'>;

/** Optional parts of an approval decision; absent fields keep their stored value. */
export interface ApprovalDecision {
  presenceVerifiedAt?: string;
  channel?: ApprovalChannel;
  mode?: ApprovalMode;
  expiresAt?: string;
  /** Change the row only if its current status is this one. */
  from?: ApprovalStatus;
}

export interface Publication {
  id: string;
  draftId: string;
  platform: PlatformId;
  account: string;
  payloadSha256: string;
  remoteId?: string;
  remoteUrl?: string;
  publishedAt: string;
  costUsd: number;
}

export interface Connection {
  platform: PlatformId;
  account: string;
  route: RouteKind;
  /** Free-form for now; the connections service (T0.16) defines the vocabulary. */
  status: string;
  expiresAt?: string;
  lastHealthAt?: string;
  lastHealthDetail?: string;
}

export interface Credential {
  platform: PlatformId;
  account: string;
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  updatedAt: string;
}
export type CredentialInput = Omit<Credential, 'updatedAt'>;

export interface AuditEntry {
  actorChannel: string;
  action: string;
  draftId?: string;
  approvalId?: string;
  hash?: string;
  platform?: string;
  detail?: unknown;
}
export interface AuditRow extends AuditEntry {
  id: number;
  ts: string;
}
export interface AuditListOptions {
  /** Default 100. */
  limit?: number;
  draftId?: string;
}

export type BudgetWindow = '15m' | '24h' | '30d';
export interface ApiBudgetRow {
  provider: string;
  window: BudgetWindow;
  limit: number;
  remaining: number;
  resetsAt: string;
  observedAt: string;
}

/** Settings key for a platform's dry-run switch (render and log, send nothing). */
export function dryRunKey(platform: PlatformId): string {
  return `dry_run:${platform}`;
}

export interface Repos {
  /** Runs `fn` in one SQLite transaction (rolls back if it throws). Nested calls join it. */
  transaction<T>(fn: () => T): T;
  content: {
    upsert(row: ContentInput): void;
    get(slug: string): ContentRow | undefined;
    list(): ContentRow[];
  };
  drafts: {
    insert<P>(draft: NewDraft<P>): Draft<P>;
    get(id: string): Draft | undefined;
    list(filter?: DraftFilter): Draft[];
    /**
     * Applies `patch` and bumps `updatedAt`. When `expectedSha` is given, the update happens only
     * if the stored `payloadSha256` still equals it (optimistic concurrency). Returns whether a
     * row was changed.
     */
    update(id: string, patch: DraftPatch, expectedSha?: string): boolean;
  };
  approvals: {
    insert(approval: NewApproval): void;
    get(id: string): Approval | undefined;
    /** Every approval of a draft, oldest first. */
    listByDraft(draftId: string): Approval[];
    /**
     * Records a decision. With `extra.from`, the row changes only if its status is still `from`
     * (a guarded compare-and-set, so a denied or expired approval cannot be revived). Only
     * gate/approval-gate.ts may set 'approved', and only after the presence check (T0.13b rule).
     */
    setStatus(id: string, status: ApprovalStatus, extra?: ApprovalDecision): boolean;
    /** Single-use: true exactly once, and only for an 'approved' approval that was never used. */
    consume(id: string): boolean;
  };
  publications: {
    insert(publication: Publication): void;
    findByHash(platform: PlatformId, payloadSha256: string): Publication | undefined;
  };
  connections: {
    upsert(connection: Connection): void;
    get(platform: PlatformId, account: string): Connection | undefined;
    list(): Connection[];
  };
  credentials: {
    put(credential: CredentialInput): void;
    get(platform: PlatformId, account: string): Credential | undefined;
    delete(platform: PlatformId, account: string): boolean;
    /** Removes every credential row (`cph revoke-all`); returns how many were removed. */
    deleteAll(): number;
  };
  settings: {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
  };
  /** Append-only by construction: no update or delete path exists (and the schema forbids both). */
  audit: {
    append(entry: AuditEntry): number;
    list(options?: AuditListOptions): AuditRow[];
  };
  apiBudget: {
    record(provider: string, window: BudgetWindow, limit: number, remaining: number, resetsAt: string): void;
    get(provider: string): ApiBudgetRow[];
  };
}

// ---- raw rows ----------------------------------------------------------------------------------

type Raw = Record<string, unknown>;

/** Copies a nullable column onto an object only when present (exactOptionalPropertyTypes). */
function opt<T extends object, K extends string>(target: T, key: K, value: unknown): T & Partial<Record<K, string>> {
  if (value !== null && value !== undefined) (target as Raw)[key] = value;
  return target as T & Partial<Record<K, string>>;
}

function contentFromRow(r: Raw): ContentRow {
  const row: ContentRow = {
    slug: r['slug'] as string,
    canonicalUrl: r['canonical_url'] as string,
    title: r['title'] as string,
    date: r['date'] as string,
    mdxSha256: r['mdx_sha256'] as string,
    repoCommit: r['repo_commit'] as string,
    dirty: r['dirty'] === 1,
    published: r['published'] === 1,
    syncedAt: r['synced_at'] as string,
  };
  opt(row, 'notesSha256', r['notes_sha256']);
  opt(row, 'canonicalLiveAt', r['canonical_live_at']);
  opt(row, 't0', r['t0']);
  return row;
}

function draftFromRow(r: Raw): Draft {
  const draft: Draft = {
    id: r['id'] as string,
    slug: r['slug'] as string,
    platform: r['platform'] as PlatformId,
    account: r['account'] as string,
    route: r['route'] as RouteKind,
    kind: r['kind'] as DraftKind,
    status: r['status'] as DraftStatus,
    payload: JSON.parse(r['payload_json'] as string) as unknown,
    payloadSha256: r['payload_sha256'] as string,
    authorship: r['authorship'] as Authorship,
    lint: JSON.parse(r['lint_json'] as string) as LintResult[],
    createdAt: r['created_at'] as string,
    updatedAt: r['updated_at'] as string,
  };
  opt(draft, 'notBefore', r['not_before']);
  opt(draft, 'scheduledAt', r['scheduled_at']);
  opt(draft, 'remoteRef', r['remote_ref']);
  opt(draft, 'remoteScheduledId', r['remote_scheduled_id']);
  opt(draft, 'failureReason', r['failure_reason']);
  opt(draft, 'sourceMdxSha256', r['source_mdx_sha256']);
  opt(draft, 'sourceNotesSha256', r['source_notes_sha256']);
  return draft;
}

function approvalFromRow(r: Raw): Approval {
  const approval: Approval = {
    id: r['id'] as string,
    draftId: r['draft_id'] as string,
    payloadSha256: r['payload_sha256'] as string,
    channel: r['channel'] as ApprovalChannel,
    mode: r['mode'] as ApprovalMode,
    status: r['status'] as ApprovalStatus,
    expiresAt: r['expires_at'] as string,
  };
  opt(approval, 'presenceVerifiedAt', r['presence_verified_at']);
  opt(approval, 'decidedAt', r['decided_at']);
  opt(approval, 'usedAt', r['used_at']);
  return approval;
}

function publicationFromRow(r: Raw): Publication {
  const pub: Publication = {
    id: r['id'] as string,
    draftId: r['draft_id'] as string,
    platform: r['platform'] as PlatformId,
    account: r['account'] as string,
    payloadSha256: r['payload_sha256'] as string,
    publishedAt: r['published_at'] as string,
    costUsd: r['cost_usd'] as number,
  };
  opt(pub, 'remoteId', r['remote_id']);
  opt(pub, 'remoteUrl', r['remote_url']);
  return pub;
}

function connectionFromRow(r: Raw): Connection {
  const c: Connection = {
    platform: r['platform'] as PlatformId,
    account: r['account'] as string,
    route: r['route'] as RouteKind,
    status: r['status'] as string,
  };
  opt(c, 'expiresAt', r['expires_at']);
  opt(c, 'lastHealthAt', r['last_health_at']);
  opt(c, 'lastHealthDetail', r['last_health_detail']);
  return c;
}

function auditFromRow(r: Raw): AuditRow {
  const row: AuditRow = {
    id: r['id'] as number,
    ts: r['ts'] as string,
    actorChannel: r['actor_channel'] as string,
    action: r['action'] as string,
  };
  opt(row, 'draftId', r['draft_id']);
  opt(row, 'approvalId', r['approval_id']);
  opt(row, 'hash', r['hash']);
  opt(row, 'platform', r['platform']);
  if (typeof r['detail_json'] === 'string') row.detail = JSON.parse(r['detail_json']) as unknown;
  return row;
}

/** Column and value converters for each patchable draft field. */
const DRAFT_PATCH_COLUMNS: Record<keyof DraftPatch, { column: string; encode: (v: never) => unknown }> = {
  status: { column: 'status', encode: (v) => v },
  payload: { column: 'payload_json', encode: (v) => JSON.stringify(v) },
  payloadSha256: { column: 'payload_sha256', encode: (v) => v },
  authorship: { column: 'authorship', encode: (v) => v },
  lint: { column: 'lint_json', encode: (v) => JSON.stringify(v) },
  notBefore: { column: 'not_before', encode: (v) => v },
  scheduledAt: { column: 'scheduled_at', encode: (v) => v },
  remoteRef: { column: 'remote_ref', encode: (v) => v },
  remoteScheduledId: { column: 'remote_scheduled_id', encode: (v) => v },
  failureReason: { column: 'failure_reason', encode: (v) => v },
};

// ---- factory -----------------------------------------------------------------------------------

export function createRepos(db: Db, deps: RepoDeps): Repos {
  const { now } = deps;
  const all = (sql: string, ...params: unknown[]): Raw[] => db.prepare(sql).all(...params) as Raw[];
  const one = (sql: string, ...params: unknown[]): Raw | undefined => db.prepare(sql).get(...params) as Raw | undefined;
  const run = (sql: string, ...params: unknown[]): number => db.prepare(sql).run(...params).changes;
  const bool = (b: boolean | undefined): number => (b ? 1 : 0);
  const nul = (v: string | undefined): string | null => v ?? null;

  const repos: Repos = {
    transaction: (fn) => db.transaction(fn)(),

    content: {
      upsert(row) {
        run(
          `INSERT INTO content (slug, canonical_url, title, date, mdx_sha256, notes_sha256, repo_commit,
                                dirty, published, canonical_live_at, t0, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(slug) DO UPDATE SET
             canonical_url = excluded.canonical_url, title = excluded.title, date = excluded.date,
             mdx_sha256 = excluded.mdx_sha256, notes_sha256 = excluded.notes_sha256,
             repo_commit = excluded.repo_commit, dirty = excluded.dirty, published = excluded.published,
             canonical_live_at = excluded.canonical_live_at, t0 = excluded.t0, synced_at = excluded.synced_at`,
          row.slug,
          row.canonicalUrl,
          row.title,
          row.date,
          row.mdxSha256,
          nul(row.notesSha256),
          row.repoCommit,
          bool(row.dirty),
          bool(row.published),
          nul(row.canonicalLiveAt),
          nul(row.t0),
          now(),
        );
      },
      get(slug) {
        const r = one('SELECT * FROM content WHERE slug = ?', slug);
        return r && contentFromRow(r);
      },
      list() {
        return all('SELECT * FROM content ORDER BY date DESC, slug').map(contentFromRow);
      },
    },

    drafts: {
      insert<P>(draft: NewDraft<P>): Draft<P> {
        const ts = now();
        run(
          `INSERT INTO drafts (id, slug, platform, account, route, kind, payload_json, payload_sha256, authorship,
                               lint_json, not_before, scheduled_at, status, remote_ref, remote_scheduled_id,
                               failure_reason, source_mdx_sha256, source_notes_sha256, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          draft.id,
          draft.slug,
          draft.platform,
          draft.account,
          draft.route,
          draft.kind,
          JSON.stringify(draft.payload),
          draft.payloadSha256,
          draft.authorship,
          JSON.stringify(draft.lint),
          nul(draft.notBefore),
          nul(draft.scheduledAt),
          draft.status,
          nul(draft.remoteRef),
          nul(draft.remoteScheduledId),
          nul(draft.failureReason),
          nul(draft.sourceMdxSha256),
          nul(draft.sourceNotesSha256),
          ts,
          ts,
        );
        return { ...draft, createdAt: ts, updatedAt: ts };
      },
      get(id) {
        const r = one('SELECT * FROM drafts WHERE id = ?', id);
        return r && draftFromRow(r);
      },
      list(filter = {}) {
        const where: string[] = [];
        const params: unknown[] = [];
        if (filter.slug !== undefined) (where.push('slug = ?'), params.push(filter.slug));
        if (filter.platform !== undefined) (where.push('platform = ?'), params.push(filter.platform));
        if (filter.status !== undefined) (where.push('status = ?'), params.push(filter.status));
        const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
        return all(`SELECT * FROM drafts ${clause} ORDER BY created_at, rowid`, ...params).map(draftFromRow);
      },
      update(id, patch, expectedSha) {
        const sets: string[] = [];
        const params: unknown[] = [];
        for (const key of Object.keys(patch) as (keyof DraftPatch)[]) {
          const value = patch[key];
          if (value === undefined) continue;
          const spec = DRAFT_PATCH_COLUMNS[key];
          if (spec === undefined) throw new Error(`drafts.update: unknown field ${String(key)}`);
          sets.push(`${spec.column} = ?`);
          params.push(value === null ? null : spec.encode(value as never));
        }
        sets.push('updated_at = ?');
        params.push(now(), id);
        let sql = `UPDATE drafts SET ${sets.join(', ')} WHERE id = ?`;
        if (expectedSha !== undefined) {
          sql += ' AND payload_sha256 = ?';
          params.push(expectedSha);
        }
        return run(sql, ...params) === 1;
      },
    },

    approvals: {
      insert(a) {
        run(
          `INSERT INTO approvals (id, draft_id, payload_sha256, channel, mode, status, presence_verified_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          a.id,
          a.draftId,
          a.payloadSha256,
          a.channel,
          a.mode,
          a.status,
          nul(a.presenceVerifiedAt),
          a.expiresAt,
        );
      },
      get(id) {
        const r = one('SELECT * FROM approvals WHERE id = ?', id);
        return r && approvalFromRow(r);
      },
      listByDraft(draftId) {
        return all('SELECT * FROM approvals WHERE draft_id = ? ORDER BY rowid', draftId).map(approvalFromRow);
      },
      setStatus(id, status, extra = {}) {
        const params: unknown[] = [
          status,
          now(),
          nul(extra.presenceVerifiedAt),
          nul(extra.channel),
          nul(extra.mode),
          nul(extra.expiresAt),
          id,
        ];
        let sql = `UPDATE approvals SET status = ?, decided_at = ?,
                     presence_verified_at = COALESCE(?, presence_verified_at),
                     channel = COALESCE(?, channel), mode = COALESCE(?, mode), expires_at = COALESCE(?, expires_at)
                   WHERE id = ?`;
        if (extra.from !== undefined) {
          sql += ' AND status = ?';
          params.push(extra.from);
        }
        return run(sql, ...params) === 1;
      },
      consume(id) {
        return run("UPDATE approvals SET used_at = ? WHERE id = ? AND used_at IS NULL AND status = 'approved'", now(), id) === 1;
      },
    },

    publications: {
      insert(p) {
        run(
          `INSERT INTO publications (id, draft_id, platform, account, payload_sha256, remote_id, remote_url,
                                     published_at, cost_usd)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          p.id,
          p.draftId,
          p.platform,
          p.account,
          p.payloadSha256,
          nul(p.remoteId),
          nul(p.remoteUrl),
          p.publishedAt,
          p.costUsd,
        );
      },
      findByHash(platform, payloadSha256) {
        const r = one(
          'SELECT * FROM publications WHERE platform = ? AND payload_sha256 = ? ORDER BY published_at, rowid LIMIT 1',
          platform,
          payloadSha256,
        );
        return r && publicationFromRow(r);
      },
    },

    connections: {
      upsert(c) {
        run(
          `INSERT INTO connections (platform, account, route, status, expires_at, last_health_at, last_health_detail)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(platform, account) DO UPDATE SET
             route = excluded.route, status = excluded.status, expires_at = excluded.expires_at,
             last_health_at = excluded.last_health_at, last_health_detail = excluded.last_health_detail`,
          c.platform,
          c.account,
          c.route,
          c.status,
          nul(c.expiresAt),
          nul(c.lastHealthAt),
          nul(c.lastHealthDetail),
        );
      },
      get(platform, account) {
        const r = one('SELECT * FROM connections WHERE platform = ? AND account = ?', platform, account);
        return r && connectionFromRow(r);
      },
      list() {
        return all('SELECT * FROM connections ORDER BY platform, account').map(connectionFromRow);
      },
    },

    credentials: {
      put(c) {
        run(
          `INSERT INTO credentials (platform, account, ciphertext, iv, tag, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(platform, account) DO UPDATE SET
             ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag, updated_at = excluded.updated_at`,
          c.platform,
          c.account,
          c.ciphertext,
          c.iv,
          c.tag,
          now(),
        );
      },
      get(platform, account) {
        const r = one('SELECT * FROM credentials WHERE platform = ? AND account = ?', platform, account);
        if (!r) return undefined;
        return {
          platform: r['platform'] as PlatformId,
          account: r['account'] as string,
          ciphertext: r['ciphertext'] as Buffer,
          iv: r['iv'] as Buffer,
          tag: r['tag'] as Buffer,
          updatedAt: r['updated_at'] as string,
        };
      },
      delete(platform, account) {
        return run('DELETE FROM credentials WHERE platform = ? AND account = ?', platform, account) === 1;
      },
      deleteAll() {
        return run('DELETE FROM credentials');
      },
    },

    settings: {
      get(key) {
        const r = one('SELECT value FROM settings WHERE key = ?', key);
        return r === undefined ? undefined : (r['value'] as string);
      },
      set(key, value) {
        run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
      },
    },

    audit: {
      append(e) {
        const info = db
          .prepare(
            `INSERT INTO audit_log (ts, actor_channel, action, draft_id, approval_id, hash, platform, detail_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            now(),
            e.actorChannel,
            e.action,
            nul(e.draftId),
            nul(e.approvalId),
            nul(e.hash),
            nul(e.platform),
            e.detail === undefined ? null : JSON.stringify(e.detail),
          );
        return Number(info.lastInsertRowid);
      },
      list(options = {}) {
        const limit = options.limit ?? 100;
        if (options.draftId !== undefined) {
          return all('SELECT * FROM audit_log WHERE draft_id = ? ORDER BY id DESC LIMIT ?', options.draftId, limit).map(auditFromRow);
        }
        return all('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', limit).map(auditFromRow);
      },
    },

    apiBudget: {
      record(provider, window, limit, remaining, resetsAt) {
        run(
          `INSERT INTO api_budget (provider, window, "limit", remaining, resets_at, observed_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider, window) DO UPDATE SET
             "limit" = excluded."limit", remaining = excluded.remaining,
             resets_at = excluded.resets_at, observed_at = excluded.observed_at`,
          provider,
          window,
          limit,
          remaining,
          resetsAt,
          now(),
        );
      },
      get(provider) {
        return all("SELECT * FROM api_budget WHERE provider = ? ORDER BY CASE window WHEN '15m' THEN 1 WHEN '24h' THEN 2 ELSE 3 END", provider).map((r) => ({
          provider: r['provider'] as string,
          window: r['window'] as BudgetWindow,
          limit: r['limit'] as number,
          remaining: r['remaining'] as number,
          resetsAt: r['resets_at'] as string,
          observedAt: r['observed_at'] as string,
        }));
      },
    },
  };
  return repos;
}
