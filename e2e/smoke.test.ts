/**
 * E2E Smoke Tests
 *
 * These tests exercise the full API request/response cycle using the
 * Hono app with an in-memory SQLite database. They verify that the
 * core user-facing flows work end-to-end without requiring Docker
 * or external services.
 *
 * To run against a live Docker stack instead, set E2E_BASE_URL to
 * the running API server (e.g. http://localhost:3400) and these
 * tests will issue real HTTP requests.
 */
// When E2E_BASE_URL is set, tests hit a live server.
// Otherwise they use the Hono app's built-in test client.
const BASE_URL = process.env.E2E_BASE_URL;

let appRequest: (path: string, init?: RequestInit) => Promise<Response>;
let cleanup: (() => void) | undefined;

beforeAll(async () => {
  if (BASE_URL) {
    // Live server mode
    appRequest = (path, init) => fetch(`${BASE_URL}${path}`, init);
  } else {
    // In-process mode using Hono test client
    const { createApp } = await import("../packages/api/src/app.js");
    const { Database } = await import("../packages/api/src/db/database.js");
    const db = new Database(":memory:");
    const { app } = createApp(db);
    appRequest = (path, init) => app.request(path, init);
    cleanup = () => db.close();
  }
});

afterAll(() => {
  cleanup?.();
});

describe("E2E smoke tests", () => {
  it("health check returns ok", async () => {
    const res = await appRequest("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });

  it("track a repo, list repos, trigger scan, untrack repo", async () => {
    // Step 1: Track a repo
    const trackRes = await appRequest("/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner: "test-owner", name: "test-repo" }),
    });
    expect(trackRes.status).toBe(201);
    const tracked = (await trackRes.json()) as Record<string, unknown>;
    expect(tracked.owner).toBe("test-owner");
    expect(tracked.name).toBe("test-repo");
    expect(tracked.id).toBeDefined();

    // Step 2: List repos - should contain the tracked repo
    const listRes = await appRequest("/repos");
    expect(listRes.status).toBe(200);
    const repos = (await listRes.json()) as Array<Record<string, unknown>>;
    expect(repos).toHaveLength(1);
    expect(repos[0].owner).toBe("test-owner");
    expect(repos[0].name).toBe("test-repo");

    // Step 3: Trigger a scan
    const scanRes = await appRequest("/repos/test-owner/test-repo/scan", {
      method: "POST",
    });
    expect(scanRes.status).toBe(202);
    const scanBody = (await scanRes.json()) as Record<string, unknown>;
    expect(scanBody.scanId).toBeDefined();
    expect(scanBody.status).toBe("queued");

    // Step 4: Check scan status
    const scanId = scanBody.scanId;
    const statusRes = await appRequest(`/scans/${scanId}`);
    expect(statusRes.status).toBe(200);
    const scanStatus = (await statusRes.json()) as Record<string, unknown>;
    expect(scanStatus.status).toBe("queued");

    // Step 5: Untrack the repo
    const deleteRes = await appRequest("/repos/test-owner/test-repo", {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(204);

    // Step 6: Verify repo is gone
    const listRes2 = await appRequest("/repos");
    expect(listRes2.status).toBe(200);
    const repos2 = (await listRes2.json()) as Array<Record<string, unknown>>;
    expect(repos2).toHaveLength(0);
  });

  it("tracking the same repo twice returns 409", async () => {
    // Track
    const res1 = await appRequest("/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner: "dupe-owner", name: "dupe-repo" }),
    });
    expect(res1.status).toBe(201);

    // Track again
    const res2 = await appRequest("/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner: "dupe-owner", name: "dupe-repo" }),
    });
    expect(res2.status).toBe(409);

    // Cleanup
    await appRequest("/repos/dupe-owner/dupe-repo", { method: "DELETE" });
  });

  it("untracking a non-existent repo returns 404", async () => {
    const res = await appRequest("/repos/nonexistent/repo", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("scan on untracked repo returns 404", async () => {
    const res = await appRequest("/repos/ghost/repo/scan", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});
