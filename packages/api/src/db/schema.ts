export const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  owner           TEXT NOT NULL,
  name            TEXT NOT NULL,
  last_scan_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(owner, name)
);

CREATE TABLE IF NOT EXISTS prs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id         INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  number          INTEGER NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT,
  author          TEXT NOT NULL,
  diff_hash       TEXT,
  file_paths      TEXT,
  state           TEXT NOT NULL DEFAULT 'open',
  github_etag     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE(repo_id, number)
);

CREATE TABLE IF NOT EXISTS scans (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id         INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'queued',
  phase_cursor    TEXT,
  pr_count        INTEGER DEFAULT 0,
  dupe_group_count INTEGER DEFAULT 0,
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT,
  error           TEXT
);

CREATE TABLE IF NOT EXISTS dupe_groups (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id         INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  repo_id         INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  label           TEXT,
  pr_count        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dupe_group_members (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id        INTEGER NOT NULL REFERENCES dupe_groups(id) ON DELETE CASCADE,
  pr_id           INTEGER NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
  rank            INTEGER NOT NULL,
  score           REAL NOT NULL,
  rationale       TEXT,
  UNIQUE(group_id, pr_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  payload         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued',
  result          TEXT,
  error           TEXT,
  attempts        INTEGER DEFAULT 0,
  max_retries     INTEGER DEFAULT 3,
  run_after       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
`;
