import { describe, it, expect, vi } from "vitest";
import { GitHubClient } from "./github-client.js";

function makeGitHubPR(n: number) {
  return {
    number: n,
    title: `PR #${n}`,
    body: `Body of PR #${n}`,
    user: { login: `author${n}` },
    state: "open",
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-02T00:00:00Z",
  };
}

function makeGitHubResponse(
  body: unknown,
  options?: {
    remaining?: number;
    reset?: number;
    status?: number;
  }
): Response {
  const headers = new Headers({
    "content-type": "application/json",
  });
  if (options?.remaining !== undefined) {
    headers.set("x-ratelimit-remaining", String(options.remaining));
  }
  if (options?.reset !== undefined) {
    headers.set("x-ratelimit-reset", String(options.reset));
  }
  return new Response(JSON.stringify(body), {
    status: options?.status ?? 200,
    headers,
  });
}

function makeTextResponse(
  body: string,
  options?: { remaining?: number; reset?: number }
): Response {
  const headers = new Headers({
    "content-type": "text/plain",
  });
  if (options?.remaining !== undefined) {
    headers.set("x-ratelimit-remaining", String(options.remaining));
  }
  if (options?.reset !== undefined) {
    headers.set("x-ratelimit-reset", String(options.reset));
  }
  return new Response(body, { status: 200, headers });
}

describe("GitHubClient", () => {
  it("fetches paginated PRs (page1 of 100, page2 of 1 = 101 total)", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => makeGitHubPR(i + 1));
    const page2 = [makeGitHubPR(101)];

    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        makeGitHubResponse(page1, { remaining: 4999, reset: 1700000000 })
      )
      .mockResolvedValueOnce(
        makeGitHubResponse(page2, { remaining: 4998, reset: 1700000000 })
      );

    const client = new GitHubClient({
      token: "test-token",
      fetchFn: mockFetch,
      maxRetries: 0,
    });

    const prs = await client.listOpenPRs("facebook", "react");

    expect(prs).toHaveLength(101);
    expect(prs[0].number).toBe(1);
    expect(prs[0].title).toBe("PR #1");
    expect(prs[0].author).toBe("author1");
    expect(prs[0].state).toBe("open");
    expect(prs[0].createdAt).toBe("2025-01-01T00:00:00Z");
    expect(prs[100].number).toBe(101);

    // Verify correct URLs were called
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const url1 = mockFetch.mock.calls[0][0] as string;
    expect(url1).toContain("page=1");
    expect(url1).toContain("per_page=100");
    expect(url1).toContain("state=open");
    const url2 = mockFetch.mock.calls[1][0] as string;
    expect(url2).toContain("page=2");
  });

  it("sets correct auth headers", async () => {
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(makeGitHubResponse([]));

    const client = new GitHubClient({
      token: "ghp_mytoken123",
      fetchFn: mockFetch,
      maxRetries: 0,
    });

    await client.listOpenPRs("owner", "repo");

    const init = mockFetch.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ghp_mytoken123");
    expect(headers.Accept).toBe("application/vnd.github+json");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });

  it("fetches PR files", async () => {
    const files = [
      { filename: "src/index.ts" },
      { filename: "src/utils.ts" },
      { filename: "README.md" },
    ];

    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        makeGitHubResponse(files, { remaining: 4990, reset: 1700000000 })
      );

    const client = new GitHubClient({
      token: "test-token",
      fetchFn: mockFetch,
      maxRetries: 0,
    });

    const result = await client.getPRFiles("facebook", "react", 42);

    expect(result).toEqual(["src/index.ts", "src/utils.ts", "README.md"]);

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/pulls/42/files");
  });

  it("getPRFiles paginates when first page has exactly 100 files", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      filename: `file-${i + 1}.ts`,
    }));
    const page2 = Array.from({ length: 10 }, (_, i) => ({
      filename: `file-${101 + i}.ts`,
    }));

    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        makeGitHubResponse(page1, { remaining: 4999, reset: 1700000000 })
      )
      .mockResolvedValueOnce(
        makeGitHubResponse(page2, { remaining: 4998, reset: 1700000000 })
      );

    const client = new GitHubClient({
      token: "test-token",
      fetchFn: mockFetch,
      maxRetries: 0,
    });

    const result = await client.getPRFiles("owner", "repo", 7);

    expect(result).toHaveLength(110);
    expect(result[0]).toBe("file-1.ts");
    expect(result[99]).toBe("file-100.ts");
    expect(result[100]).toBe("file-101.ts");
    expect(result[109]).toBe("file-110.ts");

    // Verify two requests were made with correct pagination
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const url1 = mockFetch.mock.calls[0][0] as string;
    expect(url1).toContain("/pulls/7/files");
    expect(url1).toContain("page=1");
    const url2 = mockFetch.mock.calls[1][0] as string;
    expect(url2).toContain("/pulls/7/files");
    expect(url2).toContain("page=2");
  });

  it("fetches PR diff with correct Accept header", async () => {
    const diffText =
      "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,4 @@\n+new line\n old line";

    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        makeTextResponse(diffText, { remaining: 4989, reset: 1700000000 })
      );

    const client = new GitHubClient({
      token: "test-token",
      fetchFn: mockFetch,
      maxRetries: 0,
    });

    const result = await client.getPRDiff("facebook", "react", 42);

    expect(result).toBe(diffText);

    const init = mockFetch.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Accept).toBe("application/vnd.github.diff");

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/pulls/42");
    expect(url).not.toContain("/files");
  });

  it("tracks rate limit from headers", async () => {
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        makeGitHubResponse([], { remaining: 4242, reset: 1700001234 })
      );

    const client = new GitHubClient({
      token: "test-token",
      fetchFn: mockFetch,
      maxRetries: 0,
    });

    expect(client.rateLimitRemaining).toBe(-1);
    expect(client.rateLimitReset).toBe(-1);

    await client.listOpenPRs("owner", "repo");

    expect(client.rateLimitRemaining).toBe(4242);
    expect(client.rateLimitReset).toBe(1700001234);
  });

  it("throws on non-ok response", async () => {
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        makeGitHubResponse({ message: "Not Found" }, { status: 404 })
      );

    const client = new GitHubClient({
      token: "test-token",
      fetchFn: mockFetch,
      maxRetries: 0,
    });

    await expect(client.listOpenPRs("owner", "nonexistent")).rejects.toThrow(
      "GitHub API error: 404"
    );
  });

  it("throttles requests when rate limit is low", async () => {
    vi.useFakeTimers();

    const resetTime = Math.floor(Date.now() / 1000) + 60; // 60 seconds in the future
    const files = [{ filename: "src/index.ts" }];

    const mockFetch = vi
      .fn<typeof fetch>()
      // First call returns low remaining rate limit
      .mockResolvedValueOnce(
        makeGitHubResponse(files, { remaining: 50, reset: resetTime })
      )
      // Second call succeeds normally
      .mockResolvedValueOnce(
        makeGitHubResponse(files, { remaining: 49, reset: resetTime })
      );

    const client = new GitHubClient({
      token: "test-token",
      fetchFn: mockFetch,
      maxRetries: 0,
    });

    // First request sets the rate limit state
    await client.getPRFiles("owner", "repo", 1);
    expect(client.rateLimitRemaining).toBe(50);

    // Second request should trigger throttling because remaining < 100 (buffer)
    const secondRequest = client.getPRFiles("owner", "repo", 2);

    // Advance timers to let the throttle delay resolve
    await vi.advanceTimersByTimeAsync(2000);

    await secondRequest;
    expect(mockFetch).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("waits until reset when rate limit is fully exhausted", async () => {
    vi.useFakeTimers();

    const resetTime = Math.floor(Date.now() / 1000) + 30; // 30 seconds in the future
    const files = [{ filename: "src/index.ts" }];

    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        makeGitHubResponse(files, { remaining: 0, reset: resetTime })
      )
      .mockResolvedValueOnce(
        makeGitHubResponse(files, { remaining: 4999, reset: resetTime + 3600 })
      );

    const client = new GitHubClient({
      token: "test-token",
      fetchFn: mockFetch,
      maxRetries: 0,
    });

    // First request sets remaining to 0
    await client.getPRFiles("owner", "repo", 1);
    expect(client.rateLimitRemaining).toBe(0);

    // Second request should block until reset
    const secondRequest = client.getPRFiles("owner", "repo", 2);

    // Advance past the reset time
    await vi.advanceTimersByTimeAsync(31_000);

    await secondRequest;
    expect(mockFetch).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("handles single-page PR response (fewer than 100)", async () => {
    const prs = Array.from({ length: 5 }, (_, i) => makeGitHubPR(i + 1));
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(makeGitHubResponse(prs));

    const client = new GitHubClient({
      token: "test-token",
      fetchFn: mockFetch,
      maxRetries: 0,
    });

    const result = await client.listOpenPRs("owner", "repo");
    expect(result).toHaveLength(5);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
