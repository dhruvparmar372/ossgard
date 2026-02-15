# Phase 3: Rate-Limited GitHub Client

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a rate-limit-aware GitHub REST API client that handles proactive throttling, reactive retry with exponential backoff, concurrency limiting, and ETag caching.

**Architecture:** A generic `RateLimitedClient` wraps fetch with token bucket tracking, retry logic, and concurrency control. `GitHubClient` extends it with GitHub-specific header parsing and PR fetching methods.

**Tech Stack:** Native fetch, Vitest, msw (Mock Service Worker) for HTTP mocking

**Depends on:** Phase 1 (types), Phase 2 (database for ETag storage)

---

### Task 1: Build the RateLimitedClient base

**Files:**
- Create: `packages/api/src/services/rate-limiter.ts`
- Test: `packages/api/src/services/rate-limiter.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/api/src/services/rate-limiter.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { RateLimitedClient } from "./rate-limiter.js";

describe("RateLimitedClient", () => {
  it("limits concurrent requests", async () => {
    let inflight = 0;
    let maxInflight = 0;

    const mockFetch = vi.fn(async () => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 50));
      inflight--;
      return new Response("ok", { status: 200 });
    });

    const client = new RateLimitedClient({
      maxConcurrent: 2,
      maxRetries: 0,
      baseBackoffMs: 100,
      fetchFn: mockFetch,
    });

    await Promise.all([
      client.fetch("http://a.com/1"),
      client.fetch("http://a.com/2"),
      client.fetch("http://a.com/3"),
      client.fetch("http://a.com/4"),
    ]);

    expect(maxInflight).toBeLessThanOrEqual(2);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("retries on 429 with exponential backoff", async () => {
    let attempt = 0;
    const mockFetch = vi.fn(async () => {
      attempt++;
      if (attempt < 3) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return new Response("ok", { status: 200 });
    });

    const client = new RateLimitedClient({
      maxConcurrent: 5,
      maxRetries: 3,
      baseBackoffMs: 10,
      fetchFn: mockFetch,
    });

    const res = await client.fetch("http://a.com/test");
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("throws after max retries exhausted", async () => {
    const mockFetch = vi.fn(async () => {
      return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "0" },
      });
    });

    const client = new RateLimitedClient({
      maxConcurrent: 5,
      maxRetries: 2,
      baseBackoffMs: 10,
      fetchFn: mockFetch,
    });

    await expect(client.fetch("http://a.com/test")).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("calls onRateLimited callback", async () => {
    const onRateLimited = vi.fn();
    let attempt = 0;
    const mockFetch = vi.fn(async () => {
      attempt++;
      if (attempt === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "5" },
        });
      }
      return new Response("ok", { status: 200 });
    });

    const client = new RateLimitedClient({
      maxConcurrent: 5,
      maxRetries: 2,
      baseBackoffMs: 10,
      fetchFn: mockFetch,
      onRateLimited,
    });

    await client.fetch("http://a.com/test");
    expect(onRateLimited).toHaveBeenCalledOnce();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @ossgard/api test -- src/services/rate-limiter
```
Expected: FAIL

**Step 3: Implement RateLimitedClient**

```typescript
// packages/api/src/services/rate-limiter.ts
export interface RateLimitedClientOptions {
  maxConcurrent: number;
  maxRetries: number;
  baseBackoffMs: number;
  fetchFn?: typeof fetch;
  onRateLimited?: (retryAfterMs: number) => void;
}

export class RateLimitedClient {
  private inflight = 0;
  private waitQueue: Array<() => void> = [];
  private opts: Required<Omit<RateLimitedClientOptions, "onRateLimited">> & {
    onRateLimited?: (retryAfterMs: number) => void;
  };

  constructor(opts: RateLimitedClientOptions) {
    this.opts = {
      ...opts,
      fetchFn: opts.fetchFn ?? globalThis.fetch.bind(globalThis),
    };
  }

  async fetch(url: string, init?: RequestInit): Promise<Response> {
    await this.acquireSlot();
    try {
      return await this.fetchWithRetry(url, init, 0);
    } finally {
      this.releaseSlot();
    }
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit | undefined,
    attempt: number
  ): Promise<Response> {
    const res = await this.opts.fetchFn(url, init);

    if (res.status === 429 || (res.status === 403 && attempt < this.opts.maxRetries)) {
      if (attempt >= this.opts.maxRetries) {
        throw new Error(`Rate limited after ${attempt + 1} attempts: ${url}`);
      }

      const retryAfterHeader = res.headers.get("retry-after");
      const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader) : 0;
      const backoffMs = Math.max(
        retryAfterSec * 1000,
        this.opts.baseBackoffMs * Math.pow(2, attempt)
      );
      // Add jitter: 0-20% of backoff
      const jitter = Math.random() * backoffMs * 0.2;
      const waitMs = backoffMs + jitter;

      this.opts.onRateLimited?.(waitMs);
      await new Promise((r) => setTimeout(r, waitMs));

      return this.fetchWithRetry(url, init, attempt + 1);
    }

    return res;
  }

  private acquireSlot(): Promise<void> {
    if (this.inflight < this.opts.maxConcurrent) {
      this.inflight++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waitQueue.push(() => {
        this.inflight++;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.inflight--;
    const next = this.waitQueue.shift();
    if (next) next();
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
pnpm --filter @ossgard/api test -- src/services/rate-limiter
```
Expected: ALL PASS

**Step 5: Commit**

```bash
git add packages/api/src/services/rate-limiter.ts packages/api/src/services/rate-limiter.test.ts
git commit -m "feat: add rate-limited HTTP client with retry and concurrency control"
```

---

### Task 2: Build GitHubClient with proactive throttling

**Files:**
- Create: `packages/api/src/services/github-client.ts`
- Test: `packages/api/src/services/github-client.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/api/src/services/github-client.test.ts
import { describe, it, expect, vi } from "vitest";
import { GitHubClient } from "./github-client.js";

function mockGitHubResponse(body: unknown, rateLimit?: { remaining: number; reset: number }) {
  const headers = new Headers({ "content-type": "application/json" });
  if (rateLimit) {
    headers.set("x-ratelimit-remaining", String(rateLimit.remaining));
    headers.set("x-ratelimit-reset", String(rateLimit.reset));
  }
  return new Response(JSON.stringify(body), { status: 200, headers });
}

describe("GitHubClient", () => {
  it("fetches paginated open PRs for a repo", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1,
      title: `PR ${i + 1}`,
      body: "description",
      user: { login: "alice" },
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
    }));
    const page2 = [
      {
        number: 101,
        title: "PR 101",
        body: "last one",
        user: { login: "bob" },
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
      },
    ];

    let callCount = 0;
    const mockFetch = vi.fn(async (url: string) => {
      callCount++;
      if (callCount === 1) return mockGitHubResponse(page1, { remaining: 4900, reset: Date.now() / 1000 + 3600 });
      return mockGitHubResponse(page2, { remaining: 4899, reset: Date.now() / 1000 + 3600 });
    });

    const gh = new GitHubClient("fake-token", { fetchFn: mockFetch });
    const prs = await gh.listOpenPRs("openclaw", "openclaw");

    expect(prs).toHaveLength(101);
    expect(prs[0].number).toBe(1);
    expect(prs[100].number).toBe(101);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("fetches changed files for a PR", async () => {
    const files = [
      { filename: "src/auth.ts", status: "modified" },
      { filename: "src/auth.test.ts", status: "added" },
    ];
    const mockFetch = vi.fn(async () => mockGitHubResponse(files, { remaining: 4900, reset: Date.now() / 1000 + 3600 }));

    const gh = new GitHubClient("fake-token", { fetchFn: mockFetch });
    const result = await gh.getPRFiles("openclaw", "openclaw", 42);

    expect(result).toHaveLength(2);
    expect(result[0]).toBe("src/auth.ts");
  });

  it("fetches diff for a PR", async () => {
    const diffText = "diff --git a/file.ts b/file.ts\n+added line";
    const mockFetch = vi.fn(async () =>
      new Response(diffText, {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "x-ratelimit-remaining": "4900",
          "x-ratelimit-reset": String(Date.now() / 1000 + 3600),
        },
      })
    );

    const gh = new GitHubClient("fake-token", { fetchFn: mockFetch });
    const diff = await gh.getPRDiff("openclaw", "openclaw", 42);

    expect(diff).toContain("+added line");
  });

  it("tracks rate limit from response headers", async () => {
    const resetTime = Math.floor(Date.now() / 1000) + 3600;
    const mockFetch = vi.fn(async () =>
      mockGitHubResponse([], { remaining: 150, reset: resetTime })
    );

    const gh = new GitHubClient("fake-token", { fetchFn: mockFetch });
    await gh.listOpenPRs("test", "repo");

    expect(gh.rateLimitRemaining).toBe(150);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @ossgard/api test -- src/services/github-client
```
Expected: FAIL

**Step 3: Implement GitHubClient**

```typescript
// packages/api/src/services/github-client.ts
import { RateLimitedClient } from "./rate-limiter.js";

const GITHUB_API = "https://api.github.com";

interface GitHubPRRaw {
  number: number;
  title: string;
  body: string | null;
  user: { login: string };
  created_at: string;
  updated_at: string;
  state: string;
}

interface GitHubFileRaw {
  filename: string;
  status: string;
}

export interface FetchedPR {
  number: number;
  title: string;
  body: string | null;
  author: string;
  createdAt: string;
  updatedAt: string;
}

export class GitHubClient {
  private client: RateLimitedClient;
  private token: string;
  rateLimitRemaining = 5000;
  rateLimitReset = 0;

  constructor(token: string, opts?: { fetchFn?: typeof fetch }) {
    this.token = token;
    this.client = new RateLimitedClient({
      maxConcurrent: 10,
      maxRetries: 5,
      baseBackoffMs: 1000,
      fetchFn: opts?.fetchFn,
      onRateLimited: (ms) => {
        console.warn(`GitHub rate limited, waiting ${Math.round(ms / 1000)}s`);
      },
    });
  }

  async listOpenPRs(owner: string, repo: string): Promise<FetchedPR[]> {
    const allPRs: FetchedPR[] = [];
    let page = 1;

    while (true) {
      const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls?state=open&per_page=100&page=${page}`;
      const res = await this.ghFetch(url);
      const prs = (await res.json()) as GitHubPRRaw[];

      for (const pr of prs) {
        allPRs.push({
          number: pr.number,
          title: pr.title,
          body: pr.body,
          author: pr.user.login,
          createdAt: pr.created_at,
          updatedAt: pr.updated_at,
        });
      }

      if (prs.length < 100) break;
      page++;
    }

    return allPRs;
  }

  async getPRFiles(owner: string, repo: string, prNumber: number): Promise<string[]> {
    const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`;
    const res = await this.ghFetch(url);
    const files = (await res.json()) as GitHubFileRaw[];
    return files.map((f) => f.filename);
  }

  async getPRDiff(owner: string, repo: string, prNumber: number): Promise<string> {
    const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}`;
    const res = await this.ghFetch(url, {
      headers: {
        Accept: "application/vnd.github.diff",
        Authorization: `Bearer ${this.token}`,
      },
    });
    return res.text();
  }

  private async ghFetch(url: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    if (!headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${this.token}`);
    }
    if (!headers.has("Accept")) {
      headers.set("Accept", "application/vnd.github+json");
    }
    headers.set("X-GitHub-Api-Version", "2022-11-28");

    const res = await this.client.fetch(url, { ...init, headers });
    this.updateRateLimit(res);
    return res;
  }

  private updateRateLimit(res: Response): void {
    const remaining = res.headers.get("x-ratelimit-remaining");
    const reset = res.headers.get("x-ratelimit-reset");
    if (remaining) this.rateLimitRemaining = parseInt(remaining);
    if (reset) this.rateLimitReset = parseInt(reset);
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
pnpm --filter @ossgard/api test -- src/services/github-client
```
Expected: ALL PASS

**Step 5: Commit**

```bash
git add packages/api/src/services/github-client.ts packages/api/src/services/github-client.test.ts
git commit -m "feat: add rate-limited GitHub client with PR fetching"
```

---

### Task 3: Add diff normalization utility

**Files:**
- Create: `packages/api/src/pipeline/normalize-diff.ts`
- Test: `packages/api/src/pipeline/normalize-diff.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/api/src/pipeline/normalize-diff.test.ts
import { describe, it, expect } from "vitest";
import { normalizeDiff, hashDiff } from "./normalize-diff.js";

describe("normalizeDiff", () => {
  it("strips leading/trailing whitespace from lines", () => {
    const diff = "  + added line  \n  - removed line  ";
    const result = normalizeDiff(diff);
    expect(result).not.toContain("  +");
    expect(result).toContain("+ added line");
  });

  it("sorts hunks by file path for consistent ordering", () => {
    const diff = `diff --git a/z-file.ts b/z-file.ts
+z content
diff --git a/a-file.ts b/a-file.ts
+a content`;
    const result = normalizeDiff(diff);
    expect(result.indexOf("a-file.ts")).toBeLessThan(result.indexOf("z-file.ts"));
  });

  it("removes diff metadata lines (index, @@)", () => {
    const diff = `diff --git a/file.ts b/file.ts
index abc123..def456 100644
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,4 @@
+new line`;
    const result = normalizeDiff(diff);
    expect(result).not.toContain("index abc123");
    expect(result).not.toContain("@@");
  });
});

describe("hashDiff", () => {
  it("produces same hash for equivalent diffs", () => {
    const diff1 = "  + added  \n  - removed  ";
    const diff2 = "+ added\n- removed";
    expect(hashDiff(diff1)).toBe(hashDiff(diff2));
  });

  it("produces different hash for different diffs", () => {
    expect(hashDiff("+line a")).not.toBe(hashDiff("+line b"));
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @ossgard/api test -- src/pipeline/normalize-diff
```
Expected: FAIL

**Step 3: Implement diff normalization**

```typescript
// packages/api/src/pipeline/normalize-diff.ts
import { createHash } from "crypto";

export function normalizeDiff(raw: string): string {
  // Split into per-file hunks
  const fileHunks = raw.split(/^diff --git /m).filter(Boolean);

  // Parse each hunk: extract file path and content lines
  const parsed = fileHunks.map((hunk) => {
    const lines = hunk.split("\n");
    // First line contains the file paths: "a/path b/path"
    const headerMatch = lines[0]?.match(/a\/(.+?)\s+b\/(.+)/);
    const filePath = headerMatch?.[1] ?? "";

    // Keep only +/- content lines (not metadata)
    const contentLines = lines
      .slice(1)
      .filter((line) => {
        if (line.startsWith("index ")) return false;
        if (line.startsWith("--- ")) return false;
        if (line.startsWith("+++ ")) return false;
        if (line.startsWith("@@ ")) return false;
        return true;
      })
      .map((line) => line.trim());

    return { filePath, content: contentLines.join("\n") };
  });

  // Sort by file path for consistent ordering
  parsed.sort((a, b) => a.filePath.localeCompare(b.filePath));

  return parsed
    .map((h) => `diff --git a/${h.filePath} b/${h.filePath}\n${h.content}`)
    .join("\n");
}

export function hashDiff(diff: string): string {
  const normalized = normalizeDiff(diff);
  return createHash("sha256").update(normalized).digest("hex");
}
```

**Step 4: Run tests to verify they pass**

```bash
pnpm --filter @ossgard/api test -- src/pipeline/normalize-diff
```
Expected: ALL PASS

**Step 5: Commit**

```bash
git add packages/api/src/pipeline/normalize-diff.ts packages/api/src/pipeline/normalize-diff.test.ts
git commit -m "feat: add diff normalization and hashing for code fingerprinting"
```
