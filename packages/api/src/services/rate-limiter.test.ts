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
  it("passes through a successful request", async () => {
    const mockFetch = vi.fn().mockResolvedValue(okResponse());
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

    const mockFetch = vi.fn().mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Simulate a short network delay with real timers
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
      return okResponse();
    });

    const client = new RateLimitedClient({
      maxConcurrent: 2,
      maxRetries: 0,
      baseBackoffMs: 1,
      fetchFn: mockFetch,
    });

    // Fire off 5 requests in parallel
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        client.fetch(`https://api.github.com/test/${i}`)
      )
    );

    expect(responses).toHaveLength(5);
    expect(maxInFlight).toBe(2);
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it("retries on 429 with backoff using retry-after header", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(rateLimitResponse(0)) // retry-after: 0 seconds
      .mockResolvedValueOnce(okResponse());

    const client = new RateLimitedClient({
      maxConcurrent: 5,
      maxRetries: 3,
      baseBackoffMs: 1,
      fetchFn: mockFetch,
    });

    const response = await client.fetch("https://api.github.com/test");

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 403 with exponential backoff when no retry-after", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(forbiddenResponse())
      .mockResolvedValueOnce(okResponse());

    const client = new RateLimitedClient({
      maxConcurrent: 5,
      maxRetries: 3,
      baseBackoffMs: 1,
      fetchFn: mockFetch,
    });

    const response = await client.fetch("https://api.github.com/test");

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws after max retries exhausted (returns last response)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(rateLimitResponse(0));

    const client = new RateLimitedClient({
      maxConcurrent: 5,
      maxRetries: 2,
      baseBackoffMs: 1,
      fetchFn: mockFetch,
    });

    const response = await client.fetch("https://api.github.com/test");

    // After 2 retries (3 attempts total), returns the 429 response
    expect(response.status).toBe(429);
    expect(mockFetch).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("calls onRateLimited callback when rate limited", async () => {
    const onRateLimited = vi.fn();
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(rateLimitResponse(0))
      .mockResolvedValueOnce(okResponse());

    const client = new RateLimitedClient({
      maxConcurrent: 5,
      maxRetries: 3,
      baseBackoffMs: 1,
      fetchFn: mockFetch,
      onRateLimited,
    });

    await client.fetch("https://api.github.com/test");

    expect(onRateLimited).toHaveBeenCalledTimes(1);
  });

  it("does not retry on non-rate-limit errors", async () => {
    const mockFetch = vi
      .fn()
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
    const mockFetch = vi.fn().mockResolvedValue(okResponse());
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
