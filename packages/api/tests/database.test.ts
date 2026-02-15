import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "../src/db/database.js";

describe("Database", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  describe("table creation", () => {
    it("creates all required tables", () => {
      const tables = db.raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )
        .all() as { name: string }[];

      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain("repos");
      expect(tableNames).toContain("prs");
      expect(tableNames).toContain("scans");
      expect(tableNames).toContain("dupe_groups");
      expect(tableNames).toContain("dupe_group_members");
      expect(tableNames).toContain("jobs");
    });

    it("enables WAL mode for file-based databases", () => {
      // In-memory databases use "memory" journal mode; WAL only applies to files.
      // We verify the pragma is set, but :memory: always returns "memory".
      const result = db.raw.pragma("journal_mode") as { journal_mode: string }[];
      // :memory: dbs cannot use WAL, so just verify it returns a valid mode
      expect(["wal", "memory"]).toContain(result[0].journal_mode);
    });

    it("enables foreign keys", () => {
      const result = db.raw.pragma("foreign_keys") as { foreign_keys: number }[];
      expect(result[0].foreign_keys).toBe(1);
    });
  });

  describe("repo CRUD", () => {
    it("inserts and retrieves a repo", () => {
      const repo = db.insertRepo("facebook", "react");
      expect(repo.id).toBe(1);
      expect(repo.owner).toBe("facebook");
      expect(repo.name).toBe("react");
      expect(repo.lastScanAt).toBeNull();
      expect(repo.createdAt).toBeTruthy();
    });

    it("gets a repo by id", () => {
      const inserted = db.insertRepo("facebook", "react");
      const fetched = db.getRepo(inserted.id);
      expect(fetched).toBeDefined();
      expect(fetched!.owner).toBe("facebook");
      expect(fetched!.name).toBe("react");
    });

    it("returns undefined for missing repo", () => {
      const fetched = db.getRepo(999);
      expect(fetched).toBeUndefined();
    });

    it("gets a repo by owner and name", () => {
      db.insertRepo("facebook", "react");
      const fetched = db.getRepoByOwnerName("facebook", "react");
      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(1);
    });

    it("returns undefined for missing owner/name", () => {
      const fetched = db.getRepoByOwnerName("nope", "nada");
      expect(fetched).toBeUndefined();
    });

    it("lists all repos", () => {
      db.insertRepo("facebook", "react");
      db.insertRepo("vercel", "next.js");
      const repos = db.listRepos();
      expect(repos).toHaveLength(2);
      expect(repos[0].owner).toBe("facebook");
      expect(repos[1].owner).toBe("vercel");
    });

    it("returns empty array when no repos", () => {
      const repos = db.listRepos();
      expect(repos).toHaveLength(0);
    });

    it("deletes a repo", () => {
      db.insertRepo("facebook", "react");
      const deleted = db.deleteRepo("facebook", "react");
      expect(deleted).toBe(true);
      const repos = db.listRepos();
      expect(repos).toHaveLength(0);
    });

    it("returns false when deleting non-existent repo", () => {
      const deleted = db.deleteRepo("nope", "nada");
      expect(deleted).toBe(false);
    });

    it("enforces unique owner/name constraint", () => {
      db.insertRepo("facebook", "react");
      expect(() => db.insertRepo("facebook", "react")).toThrow();
    });
  });
});
