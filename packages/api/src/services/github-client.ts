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
      const response = await this.client.fetch(url, {
        headers: this.defaultHeaders(),
      });

      this.trackRateLimit(response);

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
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`;
    const response = await this.client.fetch(url, {
      headers: this.defaultHeaders(),
    });

    this.trackRateLimit(response);

    if (!response.ok) {
      throw new Error(
        `GitHub API error: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as Array<{ filename: string }>;
    return data.map((f) => f.filename);
  }

  async getPRDiff(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<string> {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
    const response = await this.client.fetch(url, {
      headers: {
        ...this.defaultHeaders(),
        Accept: "application/vnd.github.diff",
      },
    });

    this.trackRateLimit(response);

    if (!response.ok) {
      throw new Error(
        `GitHub API error: ${response.status} ${response.statusText}`
      );
    }

    return response.text();
  }
}
