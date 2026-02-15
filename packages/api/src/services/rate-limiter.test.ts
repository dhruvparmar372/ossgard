import { describe, it, expect, vi, beforeEach } from "vitest";
import { RateLimitedClient } from "./rate-limiter.js";

function okResponse(): Response {
  return new Response("ok", { status: 200 });
}

function rateLimitResponse(retryAfterSeconds?: number): Response {
  const headers = new Headers();
  if (retryAfterSeconds !== undefined) {
    headers.set("retry-after", String(retryAfterSeconds));
  }
  return new Response("rate limited", { status: 429, headers });
}

function forbiddenResponse(): Response {
  return new Response("forbidden", { status: 403 });
}

describe("RateLimitedClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("passes through a successful request", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    const client = new RateLimitedClient({
      maxConcurrent: 5,
      maxRetries: 3,
      baseBackoffMs: 100,
      fetchFn: mockFetch,
    });

    const response = await client.fetch("https://api.github.com/test");
    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/test",
      undefined
    );
  });

  it("limits concurrent requests to maxConcurrent", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const mockFetch = vi.fn<typeof fetch>().mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Simulate network delay
      await new Promise((resolve) => setTimeout(resolve, 50));
      inFlight--;
      return okResponse();
    });

    const client = new RateLimitedClient({
      maxConcurrent: 2,
      maxRetries: 0,
      baseBackoffMs: 100,
      fetchFn: mockFetch,
    });

    // Fire off 5 requests in parallel
    const promises = Array.from({ length: 5 }, (_, i) =>
      client.fetch(`https://api.github.com/test/${i}`)
    );

    // Advance timers to let all requests complete
    await vi.runAllTimersAsync();
    const responses = await Promise.all(promises);

    expect(responses).toHaveLength(5);
    expect(maxInFlight).toBe(2);
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it("retries on 429 with backoff using retry-after header", async () => {
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(rateLimitResponse(1)) // retry-after: 1 second
      .mockResolvedValueOnce(okResponse());

    const client = new RateLimitedClient({
      maxConcurrent: 5,
      maxRetries: 3,
      baseBackoffMs: 100,
      fetchFn: mockFetch,
    });

    const promise = client.fetch("https://api.github.com/test");
    // Advance past the 1-second retry-after
    await vi.advanceTimersByTimeAsync(1100);
    const response = await promise;

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 403 with exponential backoff when no retry-after", async () => {
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(forbiddenResponse())
      .mockResolvedValueOnce(okResponse());

    const client = new RateLimitedClient({
      maxConcurrent: 5,
      maxRetries: 3,
      baseBackoffMs: 100,
      fetchFn: mockFetch,
    });

    const promise = client.fetch("https://api.github.com/test");
    // Exponential backoff: baseBackoffMs * 2^0 * jitter = ~100ms
    await vi.advanceTimersByTimeAsync(200);
    const response = await promise;

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws after max retries exhausted (returns last response)", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(rateLimitResponse(0));

    const client = new RateLimitedClient({
      maxConcurrent: 5,
      maxRetries: 2,
      baseBackoffMs: 10,
      fetchFn: mockFetch,
    });

    const promise = client.fetch("https://api.github.com/test");
    await vi.runAllTimersAsync();
    const response = await promise;

    // After 2 retries (3 attempts total), returns the 429 response
    expect(response.status).toBe(429);
    expect(mockFetch).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("calls onRateLimited callback when rate limited", async () => {
    const onRateLimited = vi.fn();
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(rateLimitResponse(2))
      .mockResolvedValueOnce(okResponse());

    const client = new RateLimitedClient({
      maxConcurrent: 5,
      maxRetries: 3,
      baseBackoffMs: 100,
      fetchFn: mockFetch,
      onRateLimited,
    });

    const promise = client.fetch("https://api.github.com/test");
    await vi.advanceTimersByTimeAsync(2100);
    await promise;

    expect(onRateLimited).toHaveBeenCalledTimes(1);
    expect(onRateLimited).toHaveBeenCalledWith(2000); // 2 seconds
  });

  it("does not retry on non-rate-limit errors", async () => {
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("not found", { status: 404 }));

    const client = new RateLimitedClient({
      maxConcurrent: 5,
      maxRetries: 3,
      baseBackoffMs: 100,
      fetchFn: mockFetch,
    });

    const response = await client.fetch("https://api.github.com/test");
    expect(response.status).toBe(404);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("passes RequestInit options through", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    const client = new RateLimitedClient({
      maxConcurrent: 5,
      maxRetries: 0,
      baseBackoffMs: 100,
      fetchFn: mockFetch,
    });

    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"test": true}',
    };
    await client.fetch("https://api.github.com/test", init);

    expect(mockFetch).toHaveBeenCalledWith("https://api.github.com/test", init);
  });
});
