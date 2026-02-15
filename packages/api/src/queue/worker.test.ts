import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "../db/database.js";
import { LocalJobQueue } from "./local-job-queue.js";
import { WorkerLoop } from "./worker.js";
import type { JobProcessor } from "./worker.js";
import type { Job } from "@ossgard/shared";

describe("WorkerLoop", () => {
  let db: Database;
  let queue: LocalJobQueue;

  beforeEach(() => {
    db = new Database(":memory:");
    queue = new LocalJobQueue(db.raw);
  });

  afterEach(() => {
    db.close();
  });

  describe("tick()", () => {
    it("processes a job with matching processor", async () => {
      const processed: Job[] = [];
      const processor: JobProcessor = {
        type: "scan",
        process: async (job) => {
          processed.push(job);
        },
      };

      const worker = new WorkerLoop(queue, [processor]);

      const jobId = await queue.enqueue({
        type: "scan",
        payload: { repoId: 1 },
      });

      const result = await worker.tick();
      expect(result).toBe(true);
      expect(processed).toHaveLength(1);
      expect(processed[0].id).toBe(jobId);
      expect(processed[0].payload).toEqual({ repoId: 1 });

      // Job should be marked as done
      const job = await queue.getStatus(jobId);
      expect(job!.status).toBe("done");
    });

    it("fails job when processor throws", async () => {
      const processor: JobProcessor = {
        type: "scan",
        process: async () => {
          throw new Error("GitHub API rate limit exceeded");
        },
      };

      const worker = new WorkerLoop(queue, [processor]);

      const jobId = await queue.enqueue({
        type: "scan",
        payload: {},
      });

      const result = await worker.tick();
      expect(result).toBe(true);

      const job = await queue.getStatus(jobId);
      expect(job!.status).toBe("failed");
      expect(job!.error).toBe("GitHub API rate limit exceeded");
    });

    it("returns false when no jobs available", async () => {
      const worker = new WorkerLoop(queue, []);

      const result = await worker.tick();
      expect(result).toBe(false);
    });

    it("fails job with no matching processor", async () => {
      const processor: JobProcessor = {
        type: "embed",
        process: async () => {},
      };

      const worker = new WorkerLoop(queue, [processor]);

      const jobId = await queue.enqueue({
        type: "scan",
        payload: {},
      });

      const result = await worker.tick();
      expect(result).toBe(true);

      const job = await queue.getStatus(jobId);
      expect(job!.status).toBe("failed");
      expect(job!.error).toBe("No processor for type: scan");
    });

    it("dispatches to correct processor among multiple", async () => {
      const scanJobs: Job[] = [];
      const ingestJobs: Job[] = [];

      const scanProcessor: JobProcessor = {
        type: "scan",
        process: async (job) => {
          scanJobs.push(job);
        },
      };

      const ingestProcessor: JobProcessor = {
        type: "ingest",
        process: async (job) => {
          ingestJobs.push(job);
        },
      };

      const worker = new WorkerLoop(queue, [scanProcessor, ingestProcessor]);

      await queue.enqueue({ type: "ingest", payload: { prId: 5 } });
      await queue.enqueue({ type: "scan", payload: { repoId: 1 } });

      await worker.tick(); // processes ingest (oldest)
      await worker.tick(); // processes scan

      expect(ingestJobs).toHaveLength(1);
      expect(scanJobs).toHaveLength(1);
      expect(ingestJobs[0].payload).toEqual({ prId: 5 });
      expect(scanJobs[0].payload).toEqual({ repoId: 1 });
    });

    it("handles non-Error thrown values", async () => {
      const processor: JobProcessor = {
        type: "scan",
        process: async () => {
          throw "string error";
        },
      };

      const worker = new WorkerLoop(queue, [processor]);

      const jobId = await queue.enqueue({
        type: "scan",
        payload: {},
      });

      await worker.tick();

      const job = await queue.getStatus(jobId);
      expect(job!.status).toBe("failed");
      expect(job!.error).toBe("string error");
    });
  });

  describe("start() / stop()", () => {
    it("starts polling and processes jobs", async () => {
      const processed: Job[] = [];
      const processor: JobProcessor = {
        type: "scan",
        process: async (job) => {
          processed.push(job);
        },
      };

      const worker = new WorkerLoop(queue, [processor], 50);

      await queue.enqueue({ type: "scan", payload: { repoId: 1 } });

      worker.start();

      // Wait for at least one poll cycle
      await new Promise((resolve) => setTimeout(resolve, 150));

      worker.stop();

      expect(processed).toHaveLength(1);
    });

    it("stop() is idempotent", () => {
      const worker = new WorkerLoop(queue, []);
      worker.stop(); // should not throw
      worker.stop(); // should not throw
    });

    it("start() is idempotent (does not create multiple intervals)", () => {
      const worker = new WorkerLoop(queue, [], 50);
      worker.start();
      worker.start(); // should not create second interval
      worker.stop();
    });
  });
});
