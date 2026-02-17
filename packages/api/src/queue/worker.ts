import type { Job } from "@ossgard/shared";
import type { JobQueue } from "./types.js";
import { log } from "../logger.js";

export interface JobProcessor {
  type: string;
  process(job: Job): Promise<void>;
}

export interface WorkerLoopOptions {
  pollIntervalMs?: number;
  onJobFailed?: (job: Job, error: string) => void;
}

export class WorkerLoop {
  private queue: JobQueue;
  private processors: Map<string, JobProcessor>;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs: number;
  private onJobFailed?: (job: Job, error: string) => void;

  constructor(
    queue: JobQueue,
    processors: JobProcessor[] = [],
    optsOrInterval: WorkerLoopOptions | number = {}
  ) {
    this.queue = queue;
    this.processors = new Map(processors.map((p) => [p.type, p]));
    if (typeof optsOrInterval === "number") {
      this.pollIntervalMs = optsOrInterval;
    } else {
      this.pollIntervalMs = optsOrInterval.pollIntervalMs ?? 1000;
      this.onJobFailed = optsOrInterval.onJobFailed;
    }
  }

  private log = log.child("worker");

  /** Process one job from the queue. Returns true if a job was processed. */
  async tick(): Promise<boolean> {
    const job = await this.queue.dequeue();
    if (!job) {
      return false;
    }

    const processor = this.processors.get(job.type);
    if (!processor) {
      await this.queue.fail(job.id, `No processor for type: ${job.type}`);
      return true;
    }

    this.log.info("Job dequeued", { type: job.type, jobId: job.id, attempt: job.attempts });
    const start = Date.now();

    try {
      await processor.process(job);
      await this.queue.complete(job.id);
      this.log.info("Job completed", { type: job.type, jobId: job.id, durationMs: Date.now() - start });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (job.attempts < job.maxRetries) {
        // Retry with exponential backoff (longer for rate limits)
        const isRateLimit = /429|rate.?limit|token.?limit|enqueued.+limit/i.test(message);
        const baseMs = isRateLimit ? 60_000 : 1000;
        const backoffMs = baseMs * Math.pow(2, job.attempts - 1);
        const runAfter = new Date(Date.now() + backoffMs);
        await this.queue.pause(job.id, runAfter);
        this.log.warn("Job retrying", { type: job.type, jobId: job.id, error: message, backoffMs });
      } else {
        // Max retries exhausted - mark as permanently failed
        await this.queue.fail(job.id, message);
        this.onJobFailed?.(job, message);
        this.log.error("Job permanently failed", { type: job.type, jobId: job.id, error: message });
      }
    }

    return true;
  }

  /** Register a processor for a given job type. */
  register(processor: JobProcessor): void {
    this.processors.set(processor.type, processor);
  }

  /** Set a callback invoked when a job permanently fails. */
  setOnJobFailed(handler: (job: Job, error: string) => void): void {
    this.onJobFailed = handler;
  }

  /** Start polling for jobs at the configured interval. */
  start(): void {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => this.tick(), this.pollIntervalMs);
  }

  /** Stop the polling loop. */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}
