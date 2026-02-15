export interface RateLimitedClientOptions {
  maxConcurrent: number;
  maxRetries: number;
  baseBackoffMs: number;
  fetchFn?: typeof fetch;
  onRateLimited?: (retryAfterMs: number) => void;
}

export class RateLimitedClient {
  private maxConcurrent: number;
  private maxRetries: number;
  private baseBackoffMs: number;
  private fetchFn: typeof fetch;
  private onRateLimited?: (retryAfterMs: number) => void;

  private inFlight = 0;
  private waitQueue: Array<() => void> = [];

  constructor(options: RateLimitedClientOptions) {
    this.maxConcurrent = options.maxConcurrent;
    this.maxRetries = options.maxRetries;
    this.baseBackoffMs = options.baseBackoffMs;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.onRateLimited = options.onRateLimited;
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

      const retryAfterHeader = response.headers.get("retry-after");
      let backoffMs: number;

      if (retryAfterHeader) {
        // retry-after can be seconds or an HTTP-date
        const seconds = Number(retryAfterHeader);
        if (!Number.isNaN(seconds)) {
          backoffMs = seconds * 1000;
        } else {
          // Parse as HTTP date
          const date = new Date(retryAfterHeader);
          backoffMs = Math.max(0, date.getTime() - Date.now());
        }
      } else {
        // Exponential backoff with jitter
        backoffMs =
          this.baseBackoffMs * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5);
      }

      this.onRateLimited?.(backoffMs);

      await sleep(backoffMs);
      return this.fetchWithRetry(url, init, attempt + 1);
    }

    return response;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
