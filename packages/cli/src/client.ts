export class ApiClient {
  readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(baseUrl: string = "http://localhost:3400", apiKey?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.apiKey) {
      h["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return h;
  }

  async get<T = unknown>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new ApiError(res.status, body);
    }
    return res.json() as Promise<T>;
  }

  async post<T = unknown>(path: string, data?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: data !== undefined ? JSON.stringify(data) : undefined,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new ApiError(res.status, body);
    }
    return res.json() as Promise<T>;
  }

  async put<T = unknown>(path: string, data?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "PUT",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: data !== undefined ? JSON.stringify(data) : undefined,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new ApiError(res.status, body);
    }
    return res.json() as Promise<T>;
  }

  async delete(path: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new ApiError(res.status, body);
    }
  }

  /** Register a new account (unauthenticated — no API key needed). */
  async register(config: unknown, label?: string): Promise<{ apiKey: string; warnings: string[] }> {
    const res = await fetch(`${this.baseUrl}/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config, label }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new ApiError(res.status, body);
    }
    return res.json() as Promise<{ apiKey: string; warnings: string[] }>;
  }

  async getAccountConfig(): Promise<unknown> {
    return this.get("/accounts/me");
  }

  async updateAccountConfig(config: unknown): Promise<{ updated: boolean; warnings: string[] }> {
    return this.put("/accounts/me", { config });
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string
  ) {
    super(`API error ${status}: ${body}`);
    this.name = "ApiError";
  }
}
