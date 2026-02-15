import BetterSqlite3 from "better-sqlite3";
import type { PR, Repo, Scan, ScanStatus } from "@ossgard/shared";
import { SCHEMA } from "./schema.js";

interface RepoRow {
  id: number;
  owner: string;
  name: string;
  last_scan_at: string | null;
  created_at: string;
}

function mapRepoRow(row: RepoRow): Repo {
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    lastScanAt: row.last_scan_at,
    createdAt: row.created_at,
  };
}

interface ScanRow {
  id: number;
  repo_id: number;
  status: string;
  phase_cursor: string | null;
  pr_count: number;
  dupe_group_count: number;
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

function mapScanRow(row: ScanRow): Scan {
  return {
    id: row.id,
    repoId: row.repo_id,
    status: row.status as ScanStatus,
    phaseCursor: row.phase_cursor ? JSON.parse(row.phase_cursor) : null,
    prCount: row.pr_count,
    dupeGroupCount: row.dupe_group_count,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
  };
}

interface PRRow {
  id: number;
  repo_id: number;
  number: number;
  title: string;
  body: string | null;
  author: string;
  diff_hash: string | null;
  file_paths: string | null;
  state: string;
  github_etag: string | null;
  created_at: string;
  updated_at: string;
}

function mapPRRow(row: PRRow): PR {
  return {
    id: row.id,
    repoId: row.repo_id,
    number: row.number,
    title: row.title,
    body: row.body,
    author: row.author,
    diffHash: row.diff_hash,
    filePaths: row.file_paths ? JSON.parse(row.file_paths) : [],
    state: row.state as PR["state"],
    githubEtag: row.github_etag,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface UpsertPRInput {
  repoId: number;
  number: number;
  title: string;
  body: string | null;
  author: string;
  diffHash: string | null;
  filePaths: string[];
  state: "open" | "closed" | "merged";
  createdAt: string;
  updatedAt: string;
}

export class Database {
  readonly raw: BetterSqlite3.Database;

  constructor(path: string = ":memory:") {
    this.raw = new BetterSqlite3(path);
    this.raw.pragma("journal_mode = WAL");
    this.raw.pragma("foreign_keys = ON");
    this.raw.exec(SCHEMA);
  }

  insertRepo(owner: string, name: string): Repo {
    const stmt = this.raw.prepare(
      "INSERT INTO repos (owner, name) VALUES (?, ?) RETURNING *"
    );
    const row = stmt.get(owner, name) as RepoRow;
    return mapRepoRow(row);
  }

  getRepo(id: number): Repo | undefined {
    const stmt = this.raw.prepare("SELECT * FROM repos WHERE id = ?");
    const row = stmt.get(id) as RepoRow | undefined;
    return row ? mapRepoRow(row) : undefined;
  }

  getRepoByOwnerName(owner: string, name: string): Repo | undefined {
    const stmt = this.raw.prepare(
      "SELECT * FROM repos WHERE owner = ? AND name = ?"
    );
    const row = stmt.get(owner, name) as RepoRow | undefined;
    return row ? mapRepoRow(row) : undefined;
  }

  listRepos(): Repo[] {
    const stmt = this.raw.prepare("SELECT * FROM repos ORDER BY id");
    const rows = stmt.all() as RepoRow[];
    return rows.map(mapRepoRow);
  }

  deleteRepoById(id: number): boolean {
    const stmt = this.raw.prepare("DELETE FROM repos WHERE id = ?");
    const result = stmt.run(id);
    return result.changes > 0;
  }

  deleteRepo(owner: string, name: string): boolean {
    const stmt = this.raw.prepare(
      "DELETE FROM repos WHERE owner = ? AND name = ?"
    );
    const result = stmt.run(owner, name);
    return result.changes > 0;
  }

  createScan(repoId: number): Scan {
    const stmt = this.raw.prepare(
      "INSERT INTO scans (repo_id, status) VALUES (?, 'queued') RETURNING *"
    );
    const row = stmt.get(repoId) as ScanRow;
    return mapScanRow(row);
  }

  getScan(id: number): Scan | undefined {
    const stmt = this.raw.prepare("SELECT * FROM scans WHERE id = ?");
    const row = stmt.get(id) as ScanRow | undefined;
    return row ? mapScanRow(row) : undefined;
  }

  updateScanStatus(
    id: number,
    status: ScanStatus,
    extra?: Partial<Pick<Scan, "error" | "completedAt" | "phaseCursor" | "prCount" | "dupeGroupCount">>
  ): boolean {
    let sql = "UPDATE scans SET status = ?";
    const params: unknown[] = [status];

    if (extra?.error !== undefined) {
      sql += ", error = ?";
      params.push(extra.error);
    }
    if (extra?.completedAt !== undefined) {
      sql += ", completed_at = ?";
      params.push(extra.completedAt);
    }
    if (extra?.phaseCursor !== undefined) {
      sql += ", phase_cursor = ?";
      params.push(extra.phaseCursor ? JSON.stringify(extra.phaseCursor) : null);
    }
    if (extra?.prCount !== undefined) {
      sql += ", pr_count = ?";
      params.push(extra.prCount);
    }
    if (extra?.dupeGroupCount !== undefined) {
      sql += ", dupe_group_count = ?";
      params.push(extra.dupeGroupCount);
    }

    sql += " WHERE id = ?";
    params.push(id);

    const stmt = this.raw.prepare(sql);
    const result = stmt.run(...params);
    return result.changes > 0;
  }

  upsertPR(input: UpsertPRInput): PR {
    const stmt = this.raw.prepare(`
      INSERT INTO prs (repo_id, number, title, body, author, diff_hash, file_paths, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_id, number) DO UPDATE SET
        title = excluded.title,
        body = excluded.body,
        author = excluded.author,
        diff_hash = excluded.diff_hash,
        file_paths = excluded.file_paths,
        state = excluded.state,
        updated_at = excluded.updated_at
      RETURNING *
    `);
    const row = stmt.get(
      input.repoId,
      input.number,
      input.title,
      input.body,
      input.author,
      input.diffHash,
      JSON.stringify(input.filePaths),
      input.state,
      input.createdAt,
      input.updatedAt
    ) as PRRow;
    return mapPRRow(row);
  }

  getPRByNumber(repoId: number, number: number): PR | undefined {
    const stmt = this.raw.prepare(
      "SELECT * FROM prs WHERE repo_id = ? AND number = ?"
    );
    const row = stmt.get(repoId, number) as PRRow | undefined;
    return row ? mapPRRow(row) : undefined;
  }

  listOpenPRs(repoId: number): PR[] {
    const stmt = this.raw.prepare(
      "SELECT * FROM prs WHERE repo_id = ? AND state = 'open' ORDER BY number"
    );
    const rows = stmt.all(repoId) as PRRow[];
    return rows.map(mapPRRow);
  }

  close(): void {
    this.raw.close();
  }
}
