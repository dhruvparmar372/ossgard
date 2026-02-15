import BetterSqlite3 from "better-sqlite3";
import type { Repo } from "@ossgard/shared";
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

  close(): void {
    this.raw.close();
  }
}
