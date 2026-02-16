import { describe, it, expect, afterEach, mock } from "bun:test";
import { healthCheck } from "./setup.js";

describe("healthCheck", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns true when fetch responds with 200", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 200 }))
    ) as typeof fetch;

    expect(await healthCheck("http://localhost:3400", "/health")).toBe(true);
  });

  it("returns false when fetch responds with non-200", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 500 }))
    ) as typeof fetch;

    expect(await healthCheck("http://localhost:3400", "/health")).toBe(false);
  });

  it("returns false when fetch throws (network error)", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("ECONNREFUSED"))
    ) as typeof fetch;

    expect(await healthCheck("http://localhost:3400", "/health")).toBe(false);
  });

  it("concatenates url and path correctly", async () => {
    const mockFetch = mock(() =>
      Promise.resolve(new Response(null, { status: 200 }))
    ) as typeof fetch;
    globalThis.fetch = mockFetch;

    await healthCheck("http://example.com", "/api/tags");

    expect(mockFetch).toHaveBeenCalledWith("http://example.com/api/tags");
  });
});
