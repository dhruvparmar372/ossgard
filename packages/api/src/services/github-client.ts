import { RateLimitedClient } from "./rate-limiter.js";

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
  fetchFn?: typeof fetch;
}

export class GitHubClient {
  private static RATE_LIMIT_BUFFER = 100;

  private client: RateLimitedClient;
  private token: string;

  rateLimitRemaining = -1;
  rateLimitReset = -1;

  constructor(options: GitHubClientOptions) {
    this.token = options.token;
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
      this.rateLimitRemaining < GitHubClient.RATE_LIMIT_BUFFER &&
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
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
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

  async listOpenPRs(owner: string, repo: string): Promise<FetchedPR[]> {
    const allPRs: FetchedPR[] = [];
    let page = 1;

    while (true) {
      const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=100&page=${page}`;
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
      }

      // If we got fewer than 100, we've reached the last page
      if (data.length < 100) {
        break;
      }

      page++;
    }

    return allPRs;
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
