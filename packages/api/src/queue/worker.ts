import type { Job } from "@ossgard/shared";
import type { JobQueue } from "./types.js";

export interface JobProcessor {
  type: string;
  process(job: Job): Promise<void>;
}

export class WorkerLoop {
  private queue: JobQueue;
  private processors: Map<string, JobProcessor>;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs: number;

  constructor(
    queue: JobQueue,
    processors: JobProcessor[] = [],
    pollIntervalMs: number = 1000
  ) {
    this.queue = queue;
    this.processors = new Map(processors.map((p) => [p.type, p]));
    this.pollIntervalMs = pollIntervalMs;
  }

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

    try {
      await processor.process(job);
      await this.queue.complete(job.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.queue.fail(job.id, message);
    }

    return true;
  }

  /** Register a processor for a given job type. */
  register(processor: JobProcessor): void {
    this.processors.set(processor.type, processor);
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
