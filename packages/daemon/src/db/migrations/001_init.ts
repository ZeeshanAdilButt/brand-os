/**
 * Schema v1 (spec 2.7). Embedded as a string rather than a .sql file because `tsc` does not
 * copy non-TS files into dist, and the daemon must find it the same way from src and dist.
 *
 * Timestamps are ISO-8601 UTC strings. Booleans are 0/1. Phase 2 and later tables
 * (video_jobs, metrics) arrive with their own migrations.
 */
export const INIT_SQL = `
CREATE TABLE content (
  slug              TEXT PRIMARY KEY,
  canonical_url     TEXT NOT NULL,
  title             TEXT NOT NULL,
  date              TEXT NOT NULL,
  mdx_sha256        TEXT NOT NULL,
  notes_sha256      TEXT,
  repo_commit       TEXT NOT NULL,
  dirty             INTEGER NOT NULL CHECK (dirty IN (0, 1)),
  published         INTEGER NOT NULL CHECK (published IN (0, 1)),
  canonical_live_at TEXT,
  t0                TEXT,
  synced_at         TEXT NOT NULL
);

CREATE TABLE assets (
  id             TEXT PRIMARY KEY,
  slug           TEXT NOT NULL REFERENCES content(slug),
  kind           TEXT NOT NULL CHECK (kind IN ('cover','diagram','table','snapshot','video','caption','thumb')),
  local_path     TEXT NOT NULL,
  sha256         TEXT NOT NULL,
  public_url     TEXT,
  url_expires_at TEXT
);
CREATE INDEX assets_slug ON assets(slug);

CREATE TABLE drafts (
  id                  TEXT PRIMARY KEY,
  slug                TEXT NOT NULL REFERENCES content(slug),
  platform            TEXT NOT NULL CHECK (platform IN
    ('devto','linkedin','x','bluesky','mastodon','hashnode','medium','substack','reddit','youtube')),
  account             TEXT NOT NULL,
  route               TEXT NOT NULL CHECK (route IN ('direct','buffer','assist')),
  kind                TEXT NOT NULL CHECK (kind IN
    ('article','post','thread','video','newsletter','assist-kit')),
  payload_json        TEXT NOT NULL,
  payload_sha256      TEXT NOT NULL,
  authorship          TEXT NOT NULL CHECK (authorship IN ('verbatim','reformatted','ai-assisted')),
  lint_json           TEXT NOT NULL DEFAULT '[]',
  not_before          TEXT,
  scheduled_at        TEXT,
  status              TEXT NOT NULL CHECK (status IN
    ('draft','staged','pending_approval','approved','scheduled','publishing','unknown',
     'published','handed_off','failed','held','source_changed')),
  remote_ref          TEXT,
  remote_scheduled_id TEXT,
  failure_reason      TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX drafts_slug ON drafts(slug);
CREATE INDEX drafts_status ON drafts(status);

CREATE TABLE approvals (
  id                   TEXT PRIMARY KEY,
  draft_id             TEXT NOT NULL REFERENCES drafts(id),
  payload_sha256       TEXT NOT NULL,
  channel              TEXT NOT NULL CHECK (channel IN ('dashboard_hello','elicitation')),
  mode                 TEXT NOT NULL CHECK (mode IN ('publish_now','approve_only','schedule')),
  status               TEXT NOT NULL,
  presence_verified_at TEXT,
  expires_at           TEXT NOT NULL,
  decided_at           TEXT,
  used_at              TEXT
);
CREATE INDEX approvals_draft ON approvals(draft_id);

CREATE TABLE api_budget (
  provider    TEXT NOT NULL,
  window      TEXT NOT NULL CHECK (window IN ('15m','24h','30d')),
  "limit"     INTEGER NOT NULL,
  remaining   INTEGER NOT NULL,
  resets_at   TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (provider, window)
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES ('publishing_enabled', 'false');

CREATE TABLE jobs (
  id          TEXT PRIMARY KEY,
  draft_id    TEXT NOT NULL REFERENCES drafts(id),
  approval_id TEXT REFERENCES approvals(id),
  run_at      TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending','running','done','failed','held')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT
);
CREATE INDEX jobs_due ON jobs(status, run_at);

CREATE TABLE publications (
  id             TEXT PRIMARY KEY,
  draft_id       TEXT NOT NULL REFERENCES drafts(id),
  platform       TEXT NOT NULL,
  account        TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  remote_id      TEXT,
  remote_url     TEXT,
  published_at   TEXT NOT NULL,
  cost_usd       REAL NOT NULL DEFAULT 0
);
CREATE INDEX publications_hash ON publications(platform, payload_sha256);

CREATE TABLE connections (
  platform           TEXT NOT NULL,
  account            TEXT NOT NULL,
  route              TEXT NOT NULL CHECK (route IN ('direct','buffer','assist')),
  status             TEXT NOT NULL,
  expires_at         TEXT,
  last_health_at     TEXT,
  last_health_detail TEXT,
  PRIMARY KEY (platform, account)
);

CREATE TABLE credentials (
  platform   TEXT NOT NULL,
  account    TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  iv         BLOB NOT NULL,
  tag        BLOB NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (platform, account)
);

CREATE TABLE spend (
  month    TEXT NOT NULL,
  platform TEXT NOT NULL,
  usd      REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (month, platform)
);

CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,
  actor_channel TEXT NOT NULL,
  action        TEXT NOT NULL,
  draft_id      TEXT,
  approval_id   TEXT,
  hash          TEXT,
  platform      TEXT,
  detail_json   TEXT
);
CREATE INDEX audit_log_draft ON audit_log(draft_id);

-- The audit trail is append-only: not even a stray statement can rewrite or drop a row.
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
`;
