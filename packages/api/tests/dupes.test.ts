import { createApp } from "../src/app.js";
import { Database } from "../src/db/database.js";
import type { Hono } from "hono";
import type { AppEnv } from "../src/app.js";

describe("dupes routes", () => {
  let db: Database;
  let app: Hono<AppEnv>;

  beforeEach(() => {
    db = new Database(":memory:");
    ({ app } = createApp(db));
  });

  afterEach(() => {
    db.close();
  });

  describe("GET /repos/:owner/:name/dupes", () => {
    it("returns 404 for untracked repo", async () => {
      const res = await app.request("/repos/facebook/react/dupes");
      expect(res.status).toBe(404);
      const body = (await res.json()) as any;
      expect(body.error).toContain("not tracked");
    });

    it("returns 404 when no completed scan exists", async () => {
      db.insertRepo("facebook", "react");

      const res = await app.request("/repos/facebook/react/dupes");
      expect(res.status).toBe(404);
      const body = (await res.json()) as any;
      expect(body.error).toContain("No completed scan");
    });

    it("returns 404 when scan exists but is not done", async () => {
      const repo = db.insertRepo("facebook", "react");
      db.createScan(repo.id); // status = queued

      const res = await app.request("/repos/facebook/react/dupes");
      expect(res.status).toBe(404);
      const body = (await res.json()) as any;
      expect(body.error).toContain("No completed scan");
    });

    it("returns empty groups when scan is done with no dupes", async () => {
      const repo = db.insertRepo("facebook", "react");
      const scan = db.createScan(repo.id);
      db.updateScanStatus(scan.id, "done", {
        completedAt: new Date().toISOString(),
      });

      const res = await app.request("/repos/facebook/react/dupes");
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.repo).toBe("facebook/react");
      expect(body.scanId).toBe(scan.id);
      expect(body.groupCount).toBe(0);
      expect(body.groups).toEqual([]);
    });

    it("returns dupe groups with member details", async () => {
      const repo = db.insertRepo("facebook", "react");

      // Create two PRs
      const pr1 = db.upsertPR({
        repoId: repo.id,
        number: 101,
        title: "Fix button styling",
        body: "Fixes the button",
        author: "alice",
        diffHash: "aaa",
        filePaths: ["src/button.tsx"],
        state: "open",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const pr2 = db.upsertPR({
        repoId: repo.id,
        number: 102,
        title: "Fix button styles",
        body: "Also fixes the button",
        author: "bob",
        diffHash: "bbb",
        filePaths: ["src/button.tsx"],
        state: "open",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Create a completed scan with dupe groups
      const scan = db.createScan(repo.id);
      db.updateScanStatus(scan.id, "done", {
        completedAt: new Date().toISOString(),
        dupeGroupCount: 1,
      });

      const group = db.insertDupeGroup(scan.id, repo.id, "Button styling fixes", 2);
      db.insertDupeGroupMember(group.id, pr1.id, 1, 0.95, "Original fix");
      db.insertDupeGroupMember(group.id, pr2.id, 2, 0.90, "Duplicate fix");

      const res = await app.request("/repos/facebook/react/dupes");
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.repo).toBe("facebook/react");
      expect(body.scanId).toBe(scan.id);
      expect(body.groupCount).toBe(1);
      expect(body.groups).toHaveLength(1);

      const g = body.groups[0];
      expect(g.groupId).toBe(group.id);
      expect(g.label).toBe("Button styling fixes");
      expect(g.prCount).toBe(2);
      expect(g.members).toHaveLength(2);

      // First member (rank 1)
      expect(g.members[0].prNumber).toBe(101);
      expect(g.members[0].title).toBe("Fix button styling");
      expect(g.members[0].author).toBe("alice");
      expect(g.members[0].rank).toBe(1);
      expect(g.members[0].score).toBe(0.95);
      expect(g.members[0].rationale).toBe("Original fix");

      // Second member (rank 2)
      expect(g.members[1].prNumber).toBe(102);
      expect(g.members[1].rank).toBe(2);
    });

    it("returns the latest completed scan", async () => {
      const repo = db.insertRepo("facebook", "react");

      // Create first completed scan
      const scan1 = db.createScan(repo.id);
      db.updateScanStatus(scan1.id, "done", {
        completedAt: "2024-01-01T00:00:00Z",
      });

      // Create second completed scan
      const scan2 = db.createScan(repo.id);
      db.updateScanStatus(scan2.id, "done", {
        completedAt: "2024-06-01T00:00:00Z",
      });

      const res = await app.request("/repos/facebook/react/dupes");
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.scanId).toBe(scan2.id);
    });
  });
});
