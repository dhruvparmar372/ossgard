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
      expect(tableNames).toContain("accounts");
      expect(tableNames).toContain("repos");
      expect(tableNames).toContain("prs");
      expect(tableNames).toContain("scans");
      expect(tableNames).toContain("dupe_groups");
      expect(tableNames).toContain("dupe_group_members");
      expect(tableNames).toContain("jobs");
    });

    it("enables WAL mode for file-based databases", () => {
      const result = db.raw.query("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(["wal", "memory"]).toContain(result.journal_mode);
    });

    it("enables foreign keys", () => {
      const result = db.raw.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
      expect(result.foreign_keys).toBe(1);
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
      expect(fetched).not.toBeNull();
      expect(fetched!.owner).toBe("facebook");
      expect(fetched!.name).toBe("react");
    });

    it("returns null for missing repo", () => {
      const fetched = db.getRepo(999);
      expect(fetched).toBeNull();
    });

    it("gets a repo by owner and name", () => {
      db.insertRepo("facebook", "react");
      const fetched = db.getRepoByOwnerName("facebook", "react");
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(1);
    });

    it("returns null for missing owner/name", () => {
      const fetched = db.getRepoByOwnerName("nope", "nada");
      expect(fetched).toBeNull();
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

  describe("PR CRUD", () => {
    let repoId: number;

    beforeEach(() => {
      const repo = db.insertRepo("facebook", "react");
      repoId = repo.id;
    });

    const basePR = () => ({
      repoId: 0, // will be set in tests
      number: 1,
      title: "Fix bug",
      body: "Fixes a critical bug",
      author: "octocat",
      diffHash: "abc123",
      filePaths: ["src/index.ts", "src/utils.ts"],
      state: "open" as const,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-02T00:00:00Z",
    });

    it("upsert inserts a new PR", () => {
      const pr = db.upsertPR({ ...basePR(), repoId });
      expect(pr.id).toBe(1);
      expect(pr.repoId).toBe(repoId);
      expect(pr.number).toBe(1);
      expect(pr.title).toBe("Fix bug");
      expect(pr.body).toBe("Fixes a critical bug");
      expect(pr.author).toBe("octocat");
      expect(pr.diffHash).toBe("abc123");
      expect(pr.filePaths).toEqual(["src/index.ts", "src/utils.ts"]);
      expect(pr.state).toBe("open");
    });

    it("upsert updates an existing PR", () => {
      db.upsertPR({ ...basePR(), repoId });

      const updated = db.upsertPR({
        ...basePR(),
        repoId,
        title: "Fix bug v2",
        diffHash: "def456",
        filePaths: ["src/index.ts", "src/utils.ts", "src/new.ts"],
        updatedAt: "2025-01-03T00:00:00Z",
      });

      expect(updated.id).toBe(1); // same row
      expect(updated.title).toBe("Fix bug v2");
      expect(updated.diffHash).toBe("def456");
      expect(updated.filePaths).toEqual([
        "src/index.ts",
        "src/utils.ts",
        "src/new.ts",
      ]);
      expect(updated.updatedAt).toBe("2025-01-03T00:00:00Z");
    });

    it("getPRByNumber returns the PR", () => {
      db.upsertPR({ ...basePR(), repoId });
      const pr = db.getPRByNumber(repoId, 1);
      expect(pr).not.toBeNull();
      expect(pr!.number).toBe(1);
      expect(pr!.title).toBe("Fix bug");
    });

    it("getPRByNumber returns null for missing PR", () => {
      const pr = db.getPRByNumber(repoId, 999);
      expect(pr).toBeNull();
    });

    it("listOpenPRs filters by state", () => {
      db.upsertPR({ ...basePR(), repoId, number: 1, state: "open" });
      db.upsertPR({ ...basePR(), repoId, number: 2, state: "closed" });
      db.upsertPR({ ...basePR(), repoId, number: 3, state: "open" });
      db.upsertPR({ ...basePR(), repoId, number: 4, state: "merged" });

      const openPRs = db.listOpenPRs(repoId);
      expect(openPRs).toHaveLength(2);
      expect(openPRs[0].number).toBe(1);
      expect(openPRs[1].number).toBe(3);
    });

    it("filePaths round-trips as string[]", () => {
      const paths = ["a/b.ts", "c/d.ts", "e/f.ts"];
      db.upsertPR({ ...basePR(), repoId, filePaths: paths });
      const pr = db.getPRByNumber(repoId, 1);
      expect(pr!.filePaths).toEqual(paths);
      expect(Array.isArray(pr!.filePaths)).toBe(true);
    });

    it("handles null body", () => {
      db.upsertPR({ ...basePR(), repoId, body: null });
      const pr = db.getPRByNumber(repoId, 1);
      expect(pr!.body).toBeNull();
    });

    it("handles empty filePaths", () => {
      db.upsertPR({ ...basePR(), repoId, filePaths: [] });
      const pr = db.getPRByNumber(repoId, 1);
      expect(pr!.filePaths).toEqual([]);
    });

    it("getPRsByIds returns multiple PRs in one query", () => {
      const pr1 = db.upsertPR({ ...basePR(), repoId, number: 1 });
      const pr2 = db.upsertPR({ ...basePR(), repoId, number: 2, title: "Second PR" });
      db.upsertPR({ ...basePR(), repoId, number: 3, title: "Third PR" });

      const results = db.getPRsByIds([pr1.id, pr2.id]);
      expect(results).toHaveLength(2);
      const ids = results.map((r) => r.id);
      expect(ids).toContain(pr1.id);
      expect(ids).toContain(pr2.id);
    });

    it("getPRsByIds returns empty array for empty input", () => {
      const results = db.getPRsByIds([]);
      expect(results).toEqual([]);
    });

    it("getPRsByIds ignores non-existent ids", () => {
      const pr1 = db.upsertPR({ ...basePR(), repoId, number: 1 });
      const results = db.getPRsByIds([pr1.id, 9999]);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(pr1.id);
    });
  });
});
