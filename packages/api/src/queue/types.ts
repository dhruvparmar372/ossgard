import type { Job } from "@ossgard/shared";

export interface EnqueueOptions {
  type: string;
  payload: Record<string, unknown>;
  maxRetries?: number;
  runAfter?: string; // ISO timestamp
}

export interface JobQueue {
  enqueue(opts: EnqueueOptions): Promise<string>; // returns job UUID
  getStatus(jobId: string): Promise<Job | null>;
  dequeue(): Promise<Job | null>; // atomically claim oldest queued job
  complete(jobId: string, result?: Record<string, unknown>): Promise<void>;
  fail(jobId: string, error: string): Promise<void>;
  pause(jobId: string, runAfter: Date): Promise<void>; // re-queue with delay
}
