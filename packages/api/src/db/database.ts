import { Database as BunDatabase } from "bun:sqlite";
import type { Account, AccountConfig, DupeGroup, DupeGroupMember, DuplicateStrategyName, PR, Repo, Scan, ScanStatus } from "@ossgard/shared";
import { SCHEMA } from "./schema.js";

interface AccountRow {
  id: number;
  api_key: string;
  label: string | null;
  config: string;
  created_at: string;
  updated_at: string;
}

function mapAccountRow(row: AccountRow): Account {
  return {
    id: row.id,
    apiKey: row.api_key,
    label: row.label,
    config: JSON.parse(row.config) as AccountConfig,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

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
  account_id: number;
  status: string;
  strategy: string;
  phase_cursor: string | null;
  pr_count: number;
  dupe_group_count: number;
  input_tokens: number;
  output_tokens: number;
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

function mapScanRow(row: ScanRow): Scan {
  return {
    id: row.id,
    repoId: row.repo_id,
    status: row.status as ScanStatus,
    strategy: (row.strategy ?? "pairwise-llm") as DuplicateStrategyName,
    phaseCursor: row.phase_cursor ? JSON.parse(row.phase_cursor) : null,
    prCount: row.pr_count,
    dupeGroupCount: row.dupe_group_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
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
  embed_hash: string | null;
  intent_summary: string | null;
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
    embedHash: row.embed_hash,
    intentSummary: row.intent_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface DupeGroupRow {
  id: number;
  scan_id: number;
  repo_id: number;
  label: string | null;
  pr_count: number;
}

function mapDupeGroupRow(row: DupeGroupRow): DupeGroup {
  return {
    id: row.id,
    scanId: row.scan_id,
    repoId: row.repo_id,
    label: row.label,
    prCount: row.pr_count,
  };
}

interface DupeGroupMemberRow {
  id: number;
  group_id: number;
  pr_id: number;
  rank: number;
  score: number;
  rationale: string | null;
}

function mapDupeGroupMemberRow(row: DupeGroupMemberRow): DupeGroupMember {
  return {
    id: row.id,
    groupId: row.group_id,
    prId: row.pr_id,
    rank: row.rank,
    score: row.score,
    rationale: row.rationale,
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
  readonly raw: BunDatabase;

  constructor(path: string = ":memory:") {
    this.raw = new BunDatabase(path, { strict: true });
    this.raw.run("PRAGMA journal_mode = WAL");
    this.raw.run("PRAGMA foreign_keys = ON");
    this.raw.run(SCHEMA);

    // Migrations: add columns if missing (for existing databases)
    const migrations = [
      "ALTER TABLE prs ADD COLUMN embed_hash TEXT",
      "ALTER TABLE scans ADD COLUMN input_tokens INTEGER DEFAULT 0",
      "ALTER TABLE scans ADD COLUMN output_tokens INTEGER DEFAULT 0",
      "ALTER TABLE scans ADD COLUMN phase_cursor TEXT",
      "ALTER TABLE scans ADD COLUMN strategy TEXT NOT NULL DEFAULT 'pairwise-llm'",
      "ALTER TABLE prs ADD COLUMN intent_summary TEXT",
    ];
    for (const sql of migrations) {
      try {
        this.raw.run(sql);
      } catch {
        // Column already exists — ignore
      }
    }
  }

  // ── Account methods ──

  createAccount(apiKey: string, label: string | null, config: AccountConfig): Account {
    const stmt = this.raw.prepare(
      "INSERT INTO accounts (api_key, label, config) VALUES (?, ?, ?) RETURNING *"
    );
    const row = stmt.get(apiKey, label, JSON.stringify(config)) as AccountRow;
    return mapAccountRow(row);
  }

  getAccountByApiKey(apiKey: string): Account | null {
    const stmt = this.raw.prepare("SELECT * FROM accounts WHERE api_key = ?");
    const row = stmt.get(apiKey) as AccountRow | null;
    return row ? mapAccountRow(row) : null;
  }

  getAccount(id: number): Account | null {
    const stmt = this.raw.prepare("SELECT * FROM accounts WHERE id = ?");
    const row = stmt.get(id) as AccountRow | null;
    return row ? mapAccountRow(row) : null;
  }

  updateAccountConfig(id: number, config: AccountConfig): boolean {
    const stmt = this.raw.prepare(
      "UPDATE accounts SET config = ?, updated_at = datetime('now') WHERE id = ?"
    );
    const result = stmt.run(JSON.stringify(config), id);
    return result.changes > 0;
  }

  // ── Repo methods ──

  insertRepo(owner: string, name: string): Repo {
    const stmt = this.raw.prepare(
      "INSERT INTO repos (owner, name) VALUES (?, ?) RETURNING *"
    );
    const row = stmt.get(owner, name) as RepoRow;
    return mapRepoRow(row);
  }

  getRepo(id: number): Repo | null {
    const stmt = this.raw.prepare("SELECT * FROM repos WHERE id = ?");
    const row = stmt.get(id) as RepoRow | null;
    return row ? mapRepoRow(row) : null;
  }

  getRepoByOwnerName(owner: string, name: string): Repo | null {
    const stmt = this.raw.prepare(
      "SELECT * FROM repos WHERE owner = ? AND name = ?"
    );
    const row = stmt.get(owner, name) as RepoRow | null;
    return row ? mapRepoRow(row) : null;
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

  updateRepoLastScanAt(repoId: number, timestamp: string): void {
    const stmt = this.raw.prepare(
      "UPDATE repos SET last_scan_at = ? WHERE id = ?"
    );
    stmt.run(timestamp, repoId);
  }

  deleteRepo(owner: string, name: string): boolean {
    const stmt = this.raw.prepare(
      "DELETE FROM repos WHERE owner = ? AND name = ?"
    );
    const result = stmt.run(owner, name);
    return result.changes > 0;
  }

  createScan(repoId: number, accountId: number): Scan {
    const stmt = this.raw.prepare(
      "INSERT INTO scans (repo_id, account_id, status, strategy) VALUES (?, ?, 'queued', 'pairwise-llm') RETURNING *"
    );
    const row = stmt.get(repoId, accountId) as ScanRow;
    return mapScanRow(row);
  }

  getScan(id: number): Scan | null {
    const stmt = this.raw.prepare("SELECT * FROM scans WHERE id = ?");
    const row = stmt.get(id) as ScanRow | null;
    return row ? mapScanRow(row) : null;
  }

  updateScanStatus(
    id: number,
    status: ScanStatus,
    extra?: Partial<Pick<Scan, "error" | "completedAt" | "phaseCursor" | "prCount" | "dupeGroupCount">>
  ): boolean {
    let sql = "UPDATE scans SET status = ?";
    const params: (string | number | null)[] = [status];

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

  addScanTokens(scanId: number, inputTokens: number, outputTokens: number): void {
    const stmt = this.raw.prepare(
      "UPDATE scans SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE id = ?"
    );
    stmt.run(inputTokens, outputTokens, scanId);
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
        updated_at = excluded.updated_at,
        embed_hash = NULL,
        intent_summary = NULL
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

  markStalePRsClosed(repoId: number, openNumbers: number[]): number {
    if (openNumbers.length === 0) {
      // No open PRs fetched — mark ALL open PRs as closed
      const stmt = this.raw.prepare(
        "UPDATE prs SET state = 'closed' WHERE repo_id = ? AND state = 'open'"
      );
      return stmt.run(repoId).changes;
    }
    const placeholders = openNumbers.map(() => "?").join(",");
    const stmt = this.raw.prepare(
      `UPDATE prs SET state = 'closed' WHERE repo_id = ? AND state = 'open' AND number NOT IN (${placeholders})`
    );
    return stmt.run(repoId, ...openNumbers).changes;
  }

  getPRByNumber(repoId: number, number: number): PR | null {
    const stmt = this.raw.prepare(
      "SELECT * FROM prs WHERE repo_id = ? AND number = ?"
    );
    const row = stmt.get(repoId, number) as PRRow | null;
    return row ? mapPRRow(row) : null;
  }

  countPRs(repoId: number): number {
    const stmt = this.raw.prepare("SELECT COUNT(*) as count FROM prs WHERE repo_id = ?");
    const row = stmt.get(repoId) as { count: number };
    return row.count;
  }

  listOpenPRs(repoId: number): PR[] {
    const stmt = this.raw.prepare(
      "SELECT * FROM prs WHERE repo_id = ? AND state = 'open' ORDER BY number"
    );
    const rows = stmt.all(repoId) as PRRow[];
    return rows.map(mapPRRow);
  }

  getPR(id: number): PR | null {
    const stmt = this.raw.prepare("SELECT * FROM prs WHERE id = ?");
    const row = stmt.get(id) as PRRow | null;
    return row ? mapPRRow(row) : null;
  }

  updatePREtag(prId: number, etag: string | null): void {
    const stmt = this.raw.prepare("UPDATE prs SET github_etag = ? WHERE id = ?");
    stmt.run(etag, prId);
  }

  updatePREmbedHash(prId: number, hash: string): void {
    const stmt = this.raw.prepare("UPDATE prs SET embed_hash = ? WHERE id = ?");
    stmt.run(hash, prId);
  }

  updatePRCacheFields(prId: number, embedHash: string, intentSummary: string): void {
    const stmt = this.raw.prepare(
      "UPDATE prs SET embed_hash = ?, intent_summary = ? WHERE id = ?"
    );
    stmt.run(embedHash, intentSummary, prId);
  }

  updatePRIntentSummary(prId: number, intentSummary: string): void {
    const stmt = this.raw.prepare("UPDATE prs SET intent_summary = ? WHERE id = ?");
    stmt.run(intentSummary, prId);
  }

  // ── Pairwise Cache methods ──

  getPairwiseCache(
    repoId: number,
    pairs: Array<{ prA: number; prB: number; hashA: string; hashB: string }>
  ): Map<string, { isDuplicate: boolean; confidence: number; relationship: string; rationale: string }> {
    const result = new Map<string, { isDuplicate: boolean; confidence: number; relationship: string; rationale: string }>();
    if (pairs.length === 0) return result;

    const stmt = this.raw.prepare(
      "SELECT * FROM pairwise_cache WHERE repo_id = ? AND pr_a_number = ? AND pr_b_number = ?"
    );

    for (const { prA, prB, hashA, hashB } of pairs) {
      const minPr = Math.min(prA, prB);
      const maxPr = Math.max(prA, prB);
      const expectedHashA = prA <= prB ? hashA : hashB;
      const expectedHashB = prA <= prB ? hashB : hashA;

      const row = stmt.get(repoId, minPr, maxPr) as {
        hash_a: string; hash_b: string;
        is_duplicate: number; confidence: number; relationship: string; rationale: string;
      } | null;

      if (row && row.hash_a === expectedHashA && row.hash_b === expectedHashB) {
        result.set(`${minPr}-${maxPr}`, {
          isDuplicate: row.is_duplicate === 1,
          confidence: row.confidence,
          relationship: row.relationship,
          rationale: row.rationale,
        });
      }
    }

    return result;
  }

  setPairwiseCache(
    repoId: number,
    entries: Array<{
      prA: number; prB: number;
      hashA: string; hashB: string;
      result: { isDuplicate: boolean; confidence: number; relationship: string; rationale: string };
    }>
  ): void {
    if (entries.length === 0) return;

    const stmt = this.raw.prepare(`
      INSERT OR REPLACE INTO pairwise_cache
        (repo_id, pr_a_number, pr_b_number, hash_a, hash_b, is_duplicate, confidence, relationship, rationale)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = this.raw.transaction(() => {
      for (const { prA, prB, hashA, hashB, result } of entries) {
        stmt.run(
          repoId, prA, prB, hashA, hashB,
          result.isDuplicate ? 1 : 0,
          result.confidence,
          result.relationship,
          result.rationale
        );
      }
    });
    tx();
  }

  clearPairwiseCache(repoId: number): void {
    this.raw.prepare("DELETE FROM pairwise_cache WHERE repo_id = ?").run(repoId);
  }

  resetPRCacheFields(repoId: number): void {
    this.raw.prepare(
      "UPDATE prs SET embed_hash = NULL, intent_summary = NULL WHERE repo_id = ?"
    ).run(repoId);
  }

  getPRsByIds(ids: number[]): PR[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const stmt = this.raw.prepare(
      `SELECT * FROM prs WHERE id IN (${placeholders})`
    );
    const rows = stmt.all(...ids) as PRRow[];
    return rows.map(mapPRRow);
  }

  getPRsByNumbers(repoId: number, numbers: number[]): PR[] {
    if (numbers.length === 0) return [];
    const placeholders = numbers.map(() => "?").join(",");
    const stmt = this.raw.prepare(
      `SELECT * FROM prs WHERE repo_id = ? AND number IN (${placeholders}) ORDER BY number`
    );
    const rows = stmt.all(repoId, ...numbers) as PRRow[];
    return rows.map(mapPRRow);
  }

  insertDupeGroup(
    scanId: number,
    repoId: number,
    label: string | null,
    prCount: number
  ): DupeGroup {
    const stmt = this.raw.prepare(
      "INSERT INTO dupe_groups (scan_id, repo_id, label, pr_count) VALUES (?, ?, ?, ?) RETURNING *"
    );
    const row = stmt.get(scanId, repoId, label, prCount) as DupeGroupRow;
    return mapDupeGroupRow(row);
  }

  insertDupeGroupMember(
    groupId: number,
    prId: number,
    rank: number,
    score: number,
    rationale: string | null
  ): DupeGroupMember {
    const stmt = this.raw.prepare(
      "INSERT INTO dupe_group_members (group_id, pr_id, rank, score, rationale) VALUES (?, ?, ?, ?, ?) RETURNING *"
    );
    const row = stmt.get(groupId, prId, rank, score, rationale) as DupeGroupMemberRow;
    return mapDupeGroupMemberRow(row);
  }

  deleteDupeGroupsByScan(scanId: number): void {
    this.raw.prepare(
      "DELETE FROM dupe_group_members WHERE group_id IN (SELECT id FROM dupe_groups WHERE scan_id = ?)"
    ).run(scanId);
    this.raw.prepare("DELETE FROM dupe_groups WHERE scan_id = ?").run(scanId);
  }

  listDupeGroups(scanId: number): DupeGroup[] {
    const stmt = this.raw.prepare(
      "SELECT * FROM dupe_groups WHERE scan_id = ? ORDER BY id"
    );
    const rows = stmt.all(scanId) as DupeGroupRow[];
    return rows.map(mapDupeGroupRow);
  }

  findDupeGroupsByPR(scanId: number, prId: number): DupeGroup[] {
    const stmt = this.raw.prepare(
      `SELECT dg.* FROM dupe_groups dg
       INNER JOIN dupe_group_members dgm ON dgm.group_id = dg.id
       WHERE dg.scan_id = ? AND dgm.pr_id = ?
       ORDER BY dg.id`
    );
    const rows = stmt.all(scanId, prId) as DupeGroupRow[];
    return rows.map(mapDupeGroupRow);
  }

  listDupeGroupMembers(groupId: number): DupeGroupMember[] {
    const stmt = this.raw.prepare(
      "SELECT * FROM dupe_group_members WHERE group_id = ? ORDER BY rank"
    );
    const rows = stmt.all(groupId) as DupeGroupMemberRow[];
    return rows.map(mapDupeGroupMemberRow);
  }

  getLatestCompletedScan(repoId: number, accountId: number): Scan | null {
    const stmt = this.raw.prepare(
      "SELECT * FROM scans WHERE repo_id = ? AND account_id = ? AND status = 'done' ORDER BY completed_at DESC LIMIT 1"
    );
    const row = stmt.get(repoId, accountId) as ScanRow | null;
    return row ? mapScanRow(row) : null;
  }

  getActiveScan(repoId: number, accountId: number): Scan | null {
    const stmt = this.raw.prepare(
      "SELECT * FROM scans WHERE repo_id = ? AND account_id = ? AND status NOT IN ('done', 'failed') ORDER BY id DESC LIMIT 1"
    );
    const row = stmt.get(repoId, accountId) as ScanRow | null;
    return row ? mapScanRow(row) : null;
  }

  listCompletedScans(repoId: number, accountId: number): Scan[] {
    const stmt = this.raw.prepare(
      "SELECT * FROM scans WHERE repo_id = ? AND account_id = ? AND status = 'done' ORDER BY completed_at DESC"
    );
    const rows = stmt.all(repoId, accountId) as ScanRow[];
    return rows.map(mapScanRow);
  }

  clearScans(): void {
    this.raw.run("DELETE FROM dupe_group_members");
    this.raw.run("DELETE FROM dupe_groups");
    this.raw.run("DELETE FROM scans");
    this.raw.run("DELETE FROM jobs");
    this.raw.run("DELETE FROM pairwise_cache");
    this.raw.run("UPDATE prs SET embed_hash = NULL, intent_summary = NULL");
  }

  clearRepos(): void {
    this.raw.run("DELETE FROM dupe_group_members");
    this.raw.run("DELETE FROM dupe_groups");
    this.raw.run("DELETE FROM scans");
    this.raw.run("DELETE FROM jobs");
    this.raw.run("DELETE FROM pairwise_cache");
    this.raw.run("DELETE FROM prs");
    this.raw.run("DELETE FROM repos");
  }

  resetAll(): void {
    this.raw.run("DELETE FROM dupe_group_members");
    this.raw.run("DELETE FROM dupe_groups");
    this.raw.run("DELETE FROM scans");
    this.raw.run("DELETE FROM jobs");
    this.raw.run("DELETE FROM pairwise_cache");
    this.raw.run("DELETE FROM prs");
    this.raw.run("DELETE FROM repos");
    this.raw.run("DELETE FROM accounts");
  }

  close(): void {
    this.raw.close();
  }
}
