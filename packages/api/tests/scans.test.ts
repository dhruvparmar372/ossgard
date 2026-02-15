import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApp } from "../src/app.js";
import { Database } from "../src/db/database.js";
import type { Hono } from "hono";
import type { AppEnv, AppContext } from "../src/app.js";

describe("scans routes", () => {
  let db: Database;
  let app: Hono<AppEnv>;
  let ctx: AppContext;

  beforeEach(() => {
    db = new Database(":memory:");
    ({ app, ctx } = createApp(db));
  });

  afterEach(() => {
    db.close();
  });

  describe("POST /repos/:owner/:name/scan", () => {
    it("creates a scan and enqueues a job for a tracked repo", async () => {
      db.insertRepo("facebook", "react");

      const res = await app.request("/repos/facebook/react/scan", {
        method: "POST",
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as any;
      expect(body.scanId).toBe(1);
      expect(body.status).toBe("queued");
      expect(body.jobId).toBeTruthy();

      // Verify scan was created in database
      const scan = db.getScan(body.scanId);
      expect(scan).toBeDefined();
      expect(scan!.repoId).toBe(1);
      expect(scan!.status).toBe("queued");

      // Verify job was enqueued
      const job = await ctx.queue.getStatus(body.jobId);
      expect(job).not.toBeNull();
      expect(job!.type).toBe("scan");
      expect(job!.payload).toEqual({ scanId: 1, repoId: 1 });
      expect(job!.status).toBe("queued");
    });

    it("returns 404 for untracked repo", async () => {
      const res = await app.request("/repos/facebook/react/scan", {
        method: "POST",
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as any;
      expect(body.error).toContain("not tracked");
    });

    it("creates multiple scans for the same repo", async () => {
      db.insertRepo("facebook", "react");

      const res1 = await app.request("/repos/facebook/react/scan", {
        method: "POST",
      });
      const res2 = await app.request("/repos/facebook/react/scan", {
        method: "POST",
      });

      expect(res1.status).toBe(202);
      expect(res2.status).toBe(202);

      const body1 = (await res1.json()) as any;
      const body2 = (await res2.json()) as any;
      expect(body1.scanId).not.toBe(body2.scanId);
      expect(body1.jobId).not.toBe(body2.jobId);
    });
  });

  describe("GET /scans/:id", () => {
    it("returns scan progress for existing scan", async () => {
      db.insertRepo("facebook", "react");

      // Create a scan via the route
      const createRes = await app.request("/repos/facebook/react/scan", {
        method: "POST",
      });
      const { scanId } = (await createRes.json()) as any;

      const res = await app.request(`/scans/${scanId}`);
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
      const res = await app.request("/scans/999");
      expect(res.status).toBe(404);
      const body = (await res.json()) as any;
      expect(body.error).toContain("not found");
    });

    it("returns 400 for invalid scan ID", async () => {
      const res = await app.request("/scans/abc");
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.error).toContain("Invalid scan ID");
    });

    it("reflects updated scan status", async () => {
      const repo = db.insertRepo("facebook", "react");
      const scan = db.createScan(repo.id);

      // Update the scan status
      db.updateScanStatus(scan.id, "ingesting", { prCount: 42 });

      const res = await app.request(`/scans/${scan.id}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.status).toBe("ingesting");
      expect(body.prCount).toBe(42);
    });
  });
});
