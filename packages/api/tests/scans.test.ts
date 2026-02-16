import { createApp } from "../src/app.js";
import { Database } from "../src/db/database.js";
import type { Hono } from "hono";
import type { AppEnv, AppContext } from "../src/app.js";
import type { Account, AccountConfig } from "@ossgard/shared";

const TEST_API_KEY = "test-api-key-123";
const TEST_CONFIG: AccountConfig = {
  github: { token: "ghp_test" },
  llm: { provider: "ollama", url: "http://localhost:11434", model: "llama3", api_key: "" },
  embedding: { provider: "ollama", url: "http://localhost:11434", model: "nomic-embed-text", api_key: "" },
  vector_store: { url: "http://localhost:6333", api_key: "" },
};
const AUTH_HEADER = { Authorization: `Bearer ${TEST_API_KEY}` };

describe("scans routes", () => {
  let db: Database;
  let app: Hono<AppEnv>;
  let ctx: AppContext;
  let account: Account;

  beforeEach(() => {
    db = new Database(":memory:");
    ({ app, ctx } = createApp(db));
    account = db.createAccount(TEST_API_KEY, "test", TEST_CONFIG);
  });

  afterEach(() => {
    db.close();
  });

  describe("POST /repos/:owner/:name/scan", () => {
    it("creates a scan and enqueues a job for a tracked repo", async () => {
      db.insertRepo("facebook", "react");

      const res = await app.request("/repos/facebook/react/scan", {
        method: "POST",
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as any;
      expect(body.scanId).toBe(1);
      expect(body.status).toBe("queued");
      expect(body.jobId).toBeTruthy();

      // Verify scan was created in database
      const scan = db.getScan(body.scanId);
      expect(scan).not.toBeNull();
      expect(scan!.repoId).toBe(1);
      expect(scan!.status).toBe("queued");

      // Verify job was enqueued
      const job = await ctx.queue.getStatus(body.jobId);
      expect(job).not.toBeNull();
      expect(job!.type).toBe("scan");
      expect(job!.payload).toEqual({ scanId: 1, repoId: 1, accountId: account.id, full: false });
      expect(job!.status).toBe("queued");
    });

    it("auto-tracks untracked repo and creates scan", async () => {
      const res = await app.request("/repos/facebook/react/scan", {
        method: "POST",
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as any;
      expect(body.scanId).toBeTruthy();
      expect(body.status).toBe("queued");
      expect(body.jobId).toBeTruthy();

      // Verify repo was auto-tracked
      const repo = db.getRepoByOwnerName("facebook", "react");
      expect(repo).not.toBeNull();
    });

    it("returns existing scan if one is active", async () => {
      db.insertRepo("facebook", "react");

      const res1 = await app.request("/repos/facebook/react/scan", {
        method: "POST",
        headers: AUTH_HEADER,
      });
      expect(res1.status).toBe(202);
      const body1 = (await res1.json()) as any;

      const res2 = await app.request("/repos/facebook/react/scan", {
        method: "POST",
        headers: AUTH_HEADER,
      });
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as any;

      expect(body2.scanId).toBe(body1.scanId);
      expect(body2.status).toBe("queued");
      expect(body2.jobId).toBeUndefined();
    });

    it("creates new scan after previous one completes", async () => {
      db.insertRepo("facebook", "react");

      const res1 = await app.request("/repos/facebook/react/scan", {
        method: "POST",
        headers: AUTH_HEADER,
      });
      expect(res1.status).toBe(202);
      const body1 = (await res1.json()) as any;

      // Complete the first scan
      db.updateScanStatus(body1.scanId, "done", { completedAt: new Date().toISOString() });

      const res2 = await app.request("/repos/facebook/react/scan", {
        method: "POST",
        headers: AUTH_HEADER,
      });
      expect(res2.status).toBe(202);
      const body2 = (await res2.json()) as any;

      expect(body2.scanId).not.toBe(body1.scanId);
      expect(body2.jobId).toBeTruthy();
    });
  });

  describe("GET /scans/:id", () => {
    it("returns scan progress for existing scan", async () => {
      db.insertRepo("facebook", "react");

      // Create a scan via the route
      const createRes = await app.request("/repos/facebook/react/scan", {
        method: "POST",
        headers: AUTH_HEADER,
      });
      const { scanId } = (await createRes.json()) as any;

      const res = await app.request(`/scans/${scanId}`, { headers: AUTH_HEADER });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.id).toBe(scanId);
      expect(body.repoId).toBe(1);
      expect(body.status).toBe("queued");
      expect(body.prCount).toBe(0);
      expect(body.dupeGroupCount).toBe(0);
      expect(body.startedAt).toBeTruthy();
      expect(body.completedAt).toBeNull();
      expect(body.error).toBeNull();
    });

    it("returns 404 for non-existent scan", async () => {
      const res = await app.request("/scans/999", { headers: AUTH_HEADER });
      expect(res.status).toBe(404);
      const body = (await res.json()) as any;
      expect(body.error).toContain("not found");
    });

    it("returns 400 for invalid scan ID", async () => {
      const res = await app.request("/scans/abc", { headers: AUTH_HEADER });
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.error).toContain("Invalid scan ID");
    });

    it("reflects updated scan status", async () => {
      const repo = db.insertRepo("facebook", "react");
      const scan = db.createScan(repo.id, account.id);

      // Update the scan status
      db.updateScanStatus(scan.id, "ingesting", { prCount: 42 });

      const res = await app.request(`/scans/${scan.id}`, { headers: AUTH_HEADER });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.status).toBe("ingesting");
      expect(body.prCount).toBe(42);
    });
  });
});
