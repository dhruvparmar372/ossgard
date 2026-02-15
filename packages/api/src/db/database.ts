import BetterSqlite3 from "better-sqlite3";
import type { Repo } from "@ossgard/shared";
import { SCHEMA } from "./schema.js";

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
    return stmt.get(owner, name) as Repo;
  }

  getRepo(id: number): Repo | undefined {
    const stmt = this.raw.prepare("SELECT * FROM repos WHERE id = ?");
    return stmt.get(id) as Repo | undefined;
  }

  getRepoByOwnerName(owner: string, name: string): Repo | undefined {
    const stmt = this.raw.prepare(
      "SELECT * FROM repos WHERE owner = ? AND name = ?"
    );
    return stmt.get(owner, name) as Repo | undefined;
  }

  listRepos(): Repo[] {
    const stmt = this.raw.prepare("SELECT * FROM repos ORDER BY id");
    return stmt.all() as Repo[];
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
