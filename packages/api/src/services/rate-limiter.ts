export interface RateLimitedClientOptions {
  maxConcurrent: number;
  maxRetries: number;
  baseBackoffMs: number;
  maxBackoffMs?: number;
  fetchFn?: typeof fetch;
  onRateLimited?: (retryAfterMs: number, attempt: number) => void;
  /** Extract a retry delay (ms) from the response (e.g. x-ratelimit-reset). Checked before retry-after header. */
  getRetryAfterMs?: (response: Response) => number | null;
}

export class RateLimitedClient {
  private maxConcurrent: number;
  private maxRetries: number;
  private baseBackoffMs: number;
  private maxBackoffMs: number;
  private fetchFn: typeof fetch;
  private onRateLimited?: (retryAfterMs: number, attempt: number) => void;
  private getRetryAfterMs?: (response: Response) => number | null;

  private inFlight = 0;
  private waitQueue: Array<() => void> = [];

  constructor(options: RateLimitedClientOptions) {
    this.maxConcurrent = options.maxConcurrent;
    this.maxRetries = options.maxRetries;
    this.baseBackoffMs = options.baseBackoffMs;
    this.maxBackoffMs = options.maxBackoffMs ?? 5 * 60 * 1000; // 5 minutes
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.onRateLimited = options.onRateLimited;
    this.getRetryAfterMs = options.getRetryAfterMs;
  }

  private async acquireSemaphore(): Promise<void> {
    if (this.inFlight < this.maxConcurrent) {
      this.inFlight++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waitQueue.push(() => {
        this.inFlight++;
        resolve();
      });
    });
  }

  private releaseSemaphore(): void {
    this.inFlight--;
    const next = this.waitQueue.shift();
    if (next) {
      next();
    }
  }

  async fetch(url: string, init?: RequestInit): Promise<Response> {
    await this.acquireSemaphore();
    try {
      return await this.fetchWithRetry(url, init, 0);
    } finally {
      this.releaseSemaphore();
    }
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit | undefined,
    attempt: number
  ): Promise<Response> {
    const response = await this.fetchFn(url, init);

    if (response.status === 429 || response.status === 403) {
      if (attempt >= this.maxRetries) {
        return response;
      }

      let backoffMs: number | null = null;

      // 1. Check caller-provided extractor (e.g. x-ratelimit-reset)
      if (this.getRetryAfterMs) {
        backoffMs = this.getRetryAfterMs(response);
      }

      // 2. Fall back to retry-after header
      if (backoffMs == null) {
        const retryAfterHeader = response.headers.get("retry-after");
        if (retryAfterHeader) {
          const seconds = Number(retryAfterHeader);
          if (!Number.isNaN(seconds)) {
            backoffMs = seconds * 1000;
          } else {
            const date = new Date(retryAfterHeader);
            backoffMs = Math.max(0, date.getTime() - Date.now());
          }
        }
      }

      // 3. Fall back to exponential backoff with jitter
      if (backoffMs == null) {
        backoffMs =
          this.baseBackoffMs * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5);
      }

      // Cap at maxBackoffMs
      backoffMs = Math.min(backoffMs, this.maxBackoffMs);

      this.onRateLimited?.(backoffMs, attempt);

      await sleep(backoffMs);
      return this.fetchWithRetry(url, init, attempt + 1);
    }

    return response;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
