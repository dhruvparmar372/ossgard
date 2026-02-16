import { Database } from "../db/database.js";
import { LocalJobQueue } from "./local-job-queue.js";

describe("LocalJobQueue", () => {
  let db: Database;
  let queue: LocalJobQueue;

  beforeEach(() => {
    db = new Database(":memory:");
    queue = new LocalJobQueue(db.raw);
  });

  afterEach(() => {
    db.close();
  });

  describe("enqueue + getStatus", () => {
    it("inserts a job and returns its UUID", async () => {
      const id = await queue.enqueue({
        type: "scan",
        payload: { repoId: 1 },
      });
      expect(id).toBeTruthy();
      expect(typeof id).toBe("string");
      // UUID v4 format
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
    });

    it("retrieves job status after enqueue", async () => {
      const id = await queue.enqueue({
        type: "scan",
        payload: { repoId: 1, full: true },
      });

      const job = await queue.getStatus(id);
      expect(job).not.toBeNull();
      expect(job!.id).toBe(id);
      expect(job!.type).toBe("scan");
      expect(job!.payload).toEqual({ repoId: 1, full: true });
      expect(job!.status).toBe("queued");
      expect(job!.result).toBeNull();
      expect(job!.error).toBeNull();
      expect(job!.attempts).toBe(0);
      expect(job!.maxRetries).toBe(3);
      expect(job!.runAfter).toBeNull();
      expect(job!.createdAt).toBeTruthy();
      expect(job!.updatedAt).toBeTruthy();
    });

    it("returns null for non-existent job", async () => {
      const job = await queue.getStatus("non-existent-id");
      expect(job).toBeNull();
    });

    it("respects custom maxRetries", async () => {
      const id = await queue.enqueue({
        type: "scan",
        payload: {},
        maxRetries: 5,
      });

      const job = await queue.getStatus(id);
      expect(job!.maxRetries).toBe(5);
    });

    it("stores runAfter timestamp when provided", async () => {
      const futureDate = new Date(Date.now() + 60000).toISOString();
      const id = await queue.enqueue({
        type: "scan",
        payload: {},
        runAfter: futureDate,
      });

      const job = await queue.getStatus(id);
      // Stored in SQLite datetime format (YYYY-MM-DD HH:MM:SS)
      expect(job!.runAfter).toBeTruthy();
      expect(job!.runAfter).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });
  });

  describe("dequeue", () => {
    it("dequeues the oldest queued job", async () => {
      const id1 = await queue.enqueue({
        type: "scan",
        payload: { order: 1 },
      });
      const id2 = await queue.enqueue({
        type: "ingest",
        payload: { order: 2 },
      });

      const job = await queue.dequeue();
      expect(job).not.toBeNull();
      expect(job!.id).toBe(id1);
      expect(job!.status).toBe("running");
      expect(job!.attempts).toBe(1);

      // Second dequeue gets the next job
      const job2 = await queue.dequeue();
      expect(job2).not.toBeNull();
      expect(job2!.id).toBe(id2);
    });

    it("returns null when no jobs available", async () => {
      const job = await queue.dequeue();
      expect(job).toBeNull();
    });

    it("does not dequeue jobs with future run_after", async () => {
      const futureDate = new Date(Date.now() + 3600000).toISOString();
      await queue.enqueue({
        type: "scan",
        payload: {},
        runAfter: futureDate,
      });

      const job = await queue.dequeue();
      expect(job).toBeNull();
    });

    it("dequeues jobs with past run_after", async () => {
      const pastDate = new Date(Date.now() - 1000).toISOString();
      const id = await queue.enqueue({
        type: "scan",
        payload: {},
        runAfter: pastDate,
      });

      const job = await queue.dequeue();
      expect(job).not.toBeNull();
      expect(job!.id).toBe(id);
    });

    it("does not dequeue already running jobs", async () => {
      const id = await queue.enqueue({
        type: "scan",
        payload: {},
      });

      // Dequeue once (sets to running)
      await queue.dequeue();

      // Should return null since no queued jobs remain
      const job = await queue.dequeue();
      expect(job).toBeNull();
    });

    it("increments attempts on each dequeue", async () => {
      const id = await queue.enqueue({
        type: "scan",
        payload: {},
      });

      const job = await queue.dequeue();
      expect(job!.attempts).toBe(1);

      // Re-queue it (simulating a retry) and dequeue again
      await queue.pause(id, new Date(Date.now() - 1000));
      const job2 = await queue.dequeue();
      expect(job2!.attempts).toBe(2);
    });
  });

  describe("complete", () => {
    it("sets job status to done", async () => {
      const id = await queue.enqueue({
        type: "scan",
        payload: {},
      });
      await queue.dequeue();

      await queue.complete(id);

      const job = await queue.getStatus(id);
      expect(job!.status).toBe("done");
      expect(job!.result).toBeNull();
    });

    it("stores result JSON when provided", async () => {
      const id = await queue.enqueue({
        type: "scan",
        payload: {},
      });
      await queue.dequeue();

      await queue.complete(id, { dupeGroups: 5, prCount: 42 });

      const job = await queue.getStatus(id);
      expect(job!.status).toBe("done");
      expect(job!.result).toEqual({ dupeGroups: 5, prCount: 42 });
    });
  });

  describe("fail", () => {
    it("sets job status to failed with error message", async () => {
      const id = await queue.enqueue({
        type: "scan",
        payload: {},
      });
      await queue.dequeue();

      await queue.fail(id, "Rate limit exceeded");

      const job = await queue.getStatus(id);
      expect(job!.status).toBe("failed");
      expect(job!.error).toBe("Rate limit exceeded");
    });
  });

  describe("pause", () => {
    it("sets job back to queued with future run_after", async () => {
      const id = await queue.enqueue({
        type: "scan",
        payload: {},
      });
      await queue.dequeue();

      const futureDate = new Date(Date.now() + 60000);
      await queue.pause(id, futureDate);

      const job = await queue.getStatus(id);
      expect(job!.status).toBe("queued");
      // Stored in SQLite datetime format
      expect(job!.runAfter).toBeTruthy();
      expect(job!.runAfter).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it("paused job is not dequeued until run_after passes", async () => {
      const id = await queue.enqueue({
        type: "scan",
        payload: {},
      });
      await queue.dequeue();

      const futureDate = new Date(Date.now() + 3600000);
      await queue.pause(id, futureDate);

      const job = await queue.dequeue();
      expect(job).toBeNull();
    });
  });
});
