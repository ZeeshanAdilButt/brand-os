/**
 * Schema v3: approvals may come from two more human channels, `dashboard_click` (click mode, for PCs
 * without Windows Hello) and `chat_elicitation` (the approval prompt in Claude Code). SQLite cannot
 * change a CHECK constraint, so the rows are parked in a scratch table, `approvals` is dropped and
 * created again with the wider CHECK, and the rows are put back. `jobs.approval_id` references
 * approvals, so foreign key checks are deferred to the end of the migration's transaction, by which
 * time every approval id exists again (re-inserting a parent row clears the deferred violation).
 */
export const APPROVAL_CHANNELS_SQL = `
PRAGMA defer_foreign_keys = ON;
CREATE TABLE approvals_backup AS SELECT * FROM approvals;
DROP TABLE approvals;
CREATE TABLE approvals (
  id                   TEXT PRIMARY KEY,
  draft_id             TEXT NOT NULL REFERENCES drafts(id),
  payload_sha256       TEXT NOT NULL,
  channel              TEXT NOT NULL CHECK (channel IN ('dashboard_hello','dashboard_click','elicitation','chat_elicitation')),
  mode                 TEXT NOT NULL CHECK (mode IN ('publish_now','approve_only','schedule')),
  status               TEXT NOT NULL,
  presence_verified_at TEXT,
  expires_at           TEXT NOT NULL,
  decided_at           TEXT,
  used_at              TEXT
);
INSERT INTO approvals (id, draft_id, payload_sha256, channel, mode, status, presence_verified_at, expires_at, decided_at, used_at)
  SELECT id, draft_id, payload_sha256, channel, mode, status, presence_verified_at, expires_at, decided_at, used_at FROM approvals_backup;
DROP TABLE approvals_backup;
CREATE INDEX approvals_draft ON approvals(draft_id);
`;
