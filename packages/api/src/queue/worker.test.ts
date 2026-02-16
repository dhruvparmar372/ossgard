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

    it("fails job when processor throws and retries exhausted", async () => {
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
        maxRetries: 1,
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
        maxRetries: 1,
      });

      await worker.tick();

      const job = await queue.getStatus(jobId);
      expect(job!.status).toBe("failed");
      expect(job!.error).toBe("string error");
    });

    it("calls onJobFailed callback when processor throws", async () => {
      const failedJobs: { job: Job; error: string }[] = [];
      const processor: JobProcessor = {
        type: "scan",
        process: async () => {
          throw new Error("connection timeout");
        },
      };

      const worker = new WorkerLoop(queue, [processor], {
        onJobFailed: (job, error) => {
          failedJobs.push({ job, error });
        },
      });

      const jobId = await queue.enqueue({
        type: "scan",
        payload: { scanId: 42 },
        maxRetries: 1,
      });

      await worker.tick();

      expect(failedJobs).toHaveLength(1);
      expect(failedJobs[0].job.id).toBe(jobId);
      expect(failedJobs[0].job.payload).toEqual({ scanId: 42 });
      expect(failedJobs[0].error).toBe("connection timeout");
    });

    it("passes scanId in payload to onJobFailed callback", async () => {
      let receivedPayload: Record<string, unknown> | undefined;
      const processor: JobProcessor = {
        type: "ingest",
        process: async () => {
          throw new Error("disk full");
        },
      };

      const worker = new WorkerLoop(queue, [processor], {
        onJobFailed: (job) => {
          receivedPayload = job.payload;
        },
      });

      await queue.enqueue({
        type: "ingest",
        payload: { scanId: 7, repoId: 99 },
        maxRetries: 1,
      });

      await worker.tick();

      expect(receivedPayload).toBeDefined();
      expect(receivedPayload!.scanId).toBe(7);
      expect(typeof receivedPayload!.scanId).toBe("number");
    });

    it("supports setOnJobFailed to set callback after construction", async () => {
      const errors: string[] = [];
      const processor: JobProcessor = {
        type: "scan",
        process: async () => {
          throw new Error("late callback");
        },
      };

      const worker = new WorkerLoop(queue, [processor]);
      worker.setOnJobFailed((_job, error) => {
        errors.push(error);
      });

      await queue.enqueue({
        type: "scan",
        payload: {},
        maxRetries: 1,
      });

      await worker.tick();

      expect(errors).toEqual(["late callback"]);
    });

    it("pauses job for retry when attempts < maxRetries", async () => {
      const processor: JobProcessor = {
        type: "scan",
        process: async () => {
          throw new Error("transient failure");
        },
      };

      const worker = new WorkerLoop(queue, [processor]);

      const jobId = await queue.enqueue({
        type: "scan",
        payload: { scanId: 1 },
        maxRetries: 3,
      });

      await worker.tick();

      // After first attempt (attempts=1, maxRetries=3), job should be paused (queued with run_after)
      const job = await queue.getStatus(jobId);
      expect(job!.status).toBe("queued");
      expect(job!.runAfter).not.toBeNull();
    });

    it("does not call onJobFailed when job is retried", async () => {
      const failedJobs: Job[] = [];
      const processor: JobProcessor = {
        type: "scan",
        process: async () => {
          throw new Error("transient failure");
        },
      };

      const worker = new WorkerLoop(queue, [processor], {
        onJobFailed: (job) => {
          failedJobs.push(job);
        },
      });

      await queue.enqueue({
        type: "scan",
        payload: {},
        maxRetries: 3,
      });

      await worker.tick();

      // onJobFailed should NOT be called since retries remain
      expect(failedJobs).toHaveLength(0);
    });

    it("fails job and calls onJobFailed when retries are exhausted", async () => {
      let callCount = 0;
      const failedErrors: string[] = [];
      const processor: JobProcessor = {
        type: "scan",
        process: async () => {
          callCount++;
          throw new Error(`failure #${callCount}`);
        },
      };

      const worker = new WorkerLoop(queue, [processor], {
        onJobFailed: (_job, error) => {
          failedErrors.push(error);
        },
      });

      const jobId = await queue.enqueue({
        type: "scan",
        payload: {},
        maxRetries: 2,
      });

      // First attempt (attempts=1 < maxRetries=2) -> paused
      await worker.tick();
      let job = await queue.getStatus(jobId);
      expect(job!.status).toBe("queued");
      expect(failedErrors).toHaveLength(0);

      // Manually clear run_after so dequeue picks it up immediately
      db.raw.prepare("UPDATE jobs SET run_after = NULL WHERE id = ?").run(jobId);

      // Second attempt (attempts=2 >= maxRetries=2) -> failed
      await worker.tick();
      job = await queue.getStatus(jobId);
      expect(job!.status).toBe("failed");
      expect(failedErrors).toHaveLength(1);
      expect(failedErrors[0]).toBe("failure #2");
    });

    it("uses exponential backoff for retry delay", async () => {
      const pauseSpy = vi.spyOn(queue, "pause");
      const processor: JobProcessor = {
        type: "scan",
        process: async () => {
          throw new Error("retry me");
        },
      };

      const worker = new WorkerLoop(queue, [processor]);

      await queue.enqueue({
        type: "scan",
        payload: {},
        maxRetries: 3,
      });

      const before = Date.now();
      await worker.tick();

      // pause should have been called with a future Date
      expect(pauseSpy).toHaveBeenCalledTimes(1);
      const runAfter = pauseSpy.mock.calls[0][1] as Date;
      expect(runAfter.getTime()).toBeGreaterThanOrEqual(before);
      // First attempt: backoff = 1000 * 2^(1-1) = 1000ms
      expect(runAfter.getTime() - before).toBeGreaterThanOrEqual(900); // allow slight timing variance
      expect(runAfter.getTime() - before).toBeLessThanOrEqual(2000);

      pauseSpy.mockRestore();
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
