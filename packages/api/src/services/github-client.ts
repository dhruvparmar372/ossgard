import { RateLimitedClient } from "./rate-limiter.js";

export class DiffTooLargeError extends Error {
  constructor(
    public readonly owner: string,
    public readonly repo: string,
    public readonly prNumber: number
  ) {
    super(`Diff too large for ${owner}/${repo}#${prNumber} (GitHub 406)`);
    this.name = "DiffTooLargeError";
  }
}

export interface FetchedPR {
  number: number;
  title: string;
  body: string | null;
  author: string;
  state: "open" | "closed" | "merged";
  createdAt: string;
  updatedAt: string;
}

export interface GitHubClientOptions {
  token: string;
  maxConcurrent?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  rateLimitBuffer?: number;
  fetchFn?: typeof fetch;
}

export class GitHubClient {
  private static DEFAULT_RATE_LIMIT_BUFFER = 100;

  private client: RateLimitedClient;
  private token: string;
  private rateLimitBuffer: number;

  rateLimitRemaining = -1;
  rateLimitReset = -1;

  constructor(options: GitHubClientOptions) {
    this.token = options.token;
    this.rateLimitBuffer = options.rateLimitBuffer ?? GitHubClient.DEFAULT_RATE_LIMIT_BUFFER;
    this.client = new RateLimitedClient({
      maxConcurrent: options.maxConcurrent ?? 10,
      maxRetries: options.maxRetries ?? 3,
      baseBackoffMs: options.baseBackoffMs ?? 1000,
      fetchFn: options.fetchFn,
      onRateLimited: () => {
        // Rate limit tracking is handled via response headers
      },
    });
  }

  private async throttleIfNeeded(): Promise<void> {
    if (
      this.rateLimitRemaining >= 0 &&
      this.rateLimitRemaining < this.rateLimitBuffer &&
      this.rateLimitReset > 0
    ) {
      const now = Date.now() / 1000; // GitHub reset is in epoch seconds
      const timeToReset = this.rateLimitReset - now;
      if (timeToReset > 0 && this.rateLimitRemaining > 0) {
        const delayMs = (timeToReset / this.rateLimitRemaining) * 1000;
        await new Promise((r) => setTimeout(r, delayMs));
      } else if (this.rateLimitRemaining === 0 && timeToReset > 0) {
        // Completely exhausted, wait until reset
        await new Promise((r) => setTimeout(r, timeToReset * 1000));
      }
    }
  }

  private async githubFetch(
    url: string,
    headers: Record<string, string>
  ): Promise<Response> {
    await this.throttleIfNeeded();
    const response = await this.client.fetch(url, { headers });
    this.trackRateLimit(response);
    return response;
  }

  private defaultHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    return headers;
  }

  private trackRateLimit(response: Response): void {
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = response.headers.get("x-ratelimit-reset");
    if (remaining !== null) {
      this.rateLimitRemaining = Number(remaining);
    }
    if (reset !== null) {
      this.rateLimitReset = Number(reset);
    }
  }

  async listOpenPRs(owner: string, repo: string, maxResults?: number): Promise<FetchedPR[]> {
    const allPRs: FetchedPR[] = [];
    let page = 1;
    const perPage = maxResults ? Math.min(maxResults, 100) : 100;

    while (true) {
      const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=${perPage}&page=${page}`;
      const response = await this.githubFetch(url, this.defaultHeaders());

      if (!response.ok) {
        throw new Error(
          `GitHub API error: ${response.status} ${response.statusText}`
        );
      }

      const data = (await response.json()) as Array<{
        number: number;
        title: string;
        body: string | null;
        user: { login: string } | null;
        state: string;
        created_at: string;
        updated_at: string;
      }>;

      for (const pr of data) {
        allPRs.push({
          number: pr.number,
          title: pr.title,
          body: pr.body,
          author: pr.user?.login ?? "unknown",
          state: pr.state as FetchedPR["state"],
          createdAt: pr.created_at,
          updatedAt: pr.updated_at,
        });

        if (maxResults && allPRs.length >= maxResults) {
          return allPRs;
        }
      }

      // If we got fewer than perPage, we've reached the last page
      if (data.length < perPage) {
        break;
      }

      page++;
    }

    return allPRs;
  }

  async fetchPR(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<FetchedPR> {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
    const response = await this.githubFetch(url, this.defaultHeaders());

    if (!response.ok) {
      throw new Error(
        `GitHub API error: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as {
      number: number;
      title: string;
      body: string | null;
      user: { login: string } | null;
      state: string;
      merged: boolean;
      created_at: string;
      updated_at: string;
    };

    let state: FetchedPR["state"] = data.state as FetchedPR["state"];
    if (data.merged) state = "merged";

    return {
      number: data.number,
      title: data.title,
      body: data.body,
      author: data.user?.login ?? "unknown",
      state,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  async getPRFiles(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<string[]> {
    const allFiles: string[] = [];
    let page = 1;

    while (true) {
      const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`;
      const response = await this.githubFetch(url, this.defaultHeaders());

      if (!response.ok) {
        throw new Error(
          `GitHub API error: ${response.status} ${response.statusText}`
        );
      }

      const data = (await response.json()) as Array<{ filename: string }>;
      allFiles.push(...data.map((f) => f.filename));

      if (data.length < 100) break;
      page++;
    }

    return allFiles;
  }

  async getPRDiff(
    owner: string,
    repo: string,
    prNumber: number,
    etag?: string | null
  ): Promise<{ diff: string; etag: string | null } | null> {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
    const headers: Record<string, string> = {
      ...this.defaultHeaders(),
      Accept: "application/vnd.github.diff",
    };
    if (etag) {
      headers["If-None-Match"] = etag;
    }

    const response = await this.githubFetch(url, headers);

    if (response.status === 304) {
      return null; // Not modified
    }

    if (response.status === 406) {
      throw new DiffTooLargeError(owner, repo, prNumber);
    }

    if (!response.ok) {
      throw new Error(
        `GitHub API error: ${response.status} ${response.statusText}`
      );
    }

    const diff = await response.text();
    const newEtag = response.headers.get("etag");
    return { diff, etag: newEtag };
  }
}
