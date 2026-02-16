/**
 * E2E Smoke Tests
 *
 * Exercises the full ossgard stack using standalone binaries.
 * Starts the ossgard-api binary as a subprocess and uses the ossgard CLI
 * binary to run commands against it.
 *
 * Prerequisites:
 *   - Standalone binaries built: bun run build && bun run build:api && bun run build:cli
 *   - GitHub token available via GITHUB_TOKEN env var or ~/.ossgard/config.toml
 */
import { startTestEnv, type TestEnv } from "./setup.js";

let env: TestEnv;

beforeAll(async () => {
  env = await startTestEnv({ apiPort: 13400 });
}, 30_000);

afterAll(() => {
  env?.cleanup();
});

describe("E2E smoke tests", () => {
  it("health check returns ok", async () => {
    const res = await fetch(`${env.apiUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });

  it("track a repo via CLI, list via status, trigger scan, untrack", async () => {
    // Step 1: Track a repo
    const track = await env.cli(["track", "test-owner/test-repo"]);
    expect(track.exitCode).toBe(0);
    expect(track.stdout).toContain("Tracking test-owner/test-repo");

    // Step 2: Status should show the tracked repo
    const status = await env.cli(["status"]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("test-owner/test-repo");

    // Step 3: Trigger a scan (--no-wait since we don't have real services)
    const scan = await env.cli(["scan", "test-owner/test-repo", "--no-wait"]);
    expect(scan.exitCode).toBe(0);
    expect(scan.stdout).toContain("Scan #");

    // Step 4: Untrack the repo
    const untrack = await env.cli(["untrack", "test-owner/test-repo"]);
    expect(untrack.exitCode).toBe(0);
    expect(untrack.stdout).toContain("Untracked test-owner/test-repo");

    // Step 5: Status should be empty
    const status2 = await env.cli(["status"]);
    expect(status2.exitCode).toBe(0);
    expect(status2.stdout).toContain("No repositories tracked");
  });

  it("tracking the same repo twice fails", async () => {
    const track1 = await env.cli(["track", "dupe-owner/dupe-repo"]);
    expect(track1.exitCode).toBe(0);

    const track2 = await env.cli(["track", "dupe-owner/dupe-repo"]);
    expect(track2.exitCode).toBe(1);
    expect(track2.stderr).toContain("already tracked");

    await env.cli(["untrack", "dupe-owner/dupe-repo"]);
  });

  it("untracking a non-existent repo fails", async () => {
    const result = await env.cli(["untrack", "nonexistent/repo"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not tracked");
  });

  it("scan on untracked repo fails", async () => {
    const result = await env.cli(["scan", "ghost/repo", "--no-wait"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not tracked");
  });
});
