/**
 * Shared E2E test setup utilities.
 *
 * Handles resolving config, starting the API server binary, and providing
 * a CLI runner — all using the standalone binaries.
 */
import { spawn, type Subprocess } from "bun";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

const API_BIN = join(import.meta.dirname, "..", "packages", "api", "dist", "ossgard-api");
const CLI_BIN = join(import.meta.dirname, "..", "packages", "cli", "dist", "ossgard");

const E2E_CONFIG_PATH = join(import.meta.dirname, "config.toml");

/** Resolve the GitHub token from GITHUB_TOKEN env var or host config. */
function resolveGitHubToken(): string {
  // 1. Env var takes precedence
  if (process.env.GITHUB_TOKEN) {
    return process.env.GITHUB_TOKEN;
  }

  // 2. Fall back to host machine's ~/.ossgard/config.toml
  const hostConfigPath = join(homedir(), ".ossgard", "config.toml");
  if (existsSync(hostConfigPath)) {
    const raw = readFileSync(hostConfigPath, "utf-8");
    const match = raw.match(/token\s*=\s*"([^"]+)"/);
    if (match && match[1] && match[1].length > 0) {
      return match[1];
    }
  }

  return "";
}

/** Write the e2e config to a temp directory, injecting the GitHub token. */
function writeTestConfig(tempDir: string, overrides: { apiPort: number; githubToken: string }): string {
  const configDir = join(tempDir, ".ossgard");
  mkdirSync(configDir, { recursive: true });

  let config = readFileSync(E2E_CONFIG_PATH, "utf-8");

  // Inject the API URL with the test port
  config = config.replace(
    /url = "http:\/\/localhost:\d+"/,
    `url = "http://localhost:${overrides.apiPort}"`
  );

  // Inject the GitHub token
  config = config.replace(
    /token = ""/,
    `token = "${overrides.githubToken}"`
  );

  const configPath = join(configDir, "config.toml");
  writeFileSync(configPath, config);
  return configPath;
}

/** Check if a service is reachable. */
export async function assertReachable(url: string, label: string): Promise<void> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`${label} returned ${res.status}`);
  } catch (err) {
    throw new Error(
      `${label} is not reachable at ${url}. ` +
      `Make sure the local AI stack is running:\n` +
      `  docker compose -f local-ai/vector-store.yml up -d\n` +
      `  docker compose -f local-ai/llm-provider.yml up -d`
    );
  }
}

/** Assert that Ollama has a specific model pulled. */
export async function assertModel(ollamaUrl: string, model: string): Promise<void> {
  const res = await fetch(`${ollamaUrl}/api/tags`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Ollama /api/tags returned ${res.status}`);

  const data = (await res.json()) as { models: Array<{ name: string }> };
  const found = data.models.some((m) => m.name.startsWith(model));
  if (!found) {
    throw new Error(
      `Ollama model "${model}" not found. Pull it with:\n` +
      `  ollama pull ${model}`
    );
  }
}

export interface TestEnv {
  apiProcess: Subprocess;
  apiUrl: string;
  tempDir: string;
  configPath: string;
  githubToken: string;
  cli: (args: string[], timeoutMs?: number) => Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
  cleanup: () => void;
}

/**
 * Start the ossgard-api binary and prepare a CLI runner.
 *
 * Fails if:
 * - Standalone binaries haven't been built
 * - No GitHub token is available
 */
export async function startTestEnv(opts: { apiPort: number }): Promise<TestEnv> {
  // Verify binaries exist
  if (!existsSync(API_BIN)) {
    throw new Error(
      `API binary not found at ${API_BIN}. Build it first:\n` +
      `  bun run build && bun run build:api`
    );
  }
  if (!existsSync(CLI_BIN)) {
    throw new Error(
      `CLI binary not found at ${CLI_BIN}. Build it first:\n` +
      `  bun run build && bun run build:cli`
    );
  }

  // Resolve GitHub token
  const githubToken = resolveGitHubToken();
  if (!githubToken) {
    throw new Error(
      `No GitHub token available. Provide one via:\n` +
      `  GITHUB_TOKEN=ghp_... bun run test:e2e\n` +
      `Or ensure ~/.ossgard/config.toml has a valid token.`
    );
  }

  // Set up temp directory and config
  const tempDir = mkdirSync(join(tmpdir(), `ossgard-e2e-${opts.apiPort}-${Date.now()}`), { recursive: true }) as string;
  const apiUrl = `http://localhost:${opts.apiPort}`;
  const configPath = writeTestConfig(tempDir, {
    apiPort: opts.apiPort,
    githubToken,
  });

  // Start the API server binary
  const dbPath = join(tempDir, "test.db");
  const apiProcess = spawn([API_BIN], {
    env: {
      ...process.env,
      PORT: String(opts.apiPort),
      DATABASE_PATH: dbPath,
      CONFIG_PATH: configPath,
      GITHUB_TOKEN: githubToken,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Wait for API to be ready
  const deadline = Date.now() + 15_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${apiUrl}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) {
    apiProcess.kill();
    throw new Error("API server did not start in time");
  }

  // CLI runner
  const cli = async (
    args: string[],
    timeoutMs = 30_000
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    const proc = spawn([CLI_BIN, ...args], {
      env: {
        ...process.env,
        OSSGARD_API_URL: apiUrl,
        HOME: tempDir,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    return { stdout, stderr, exitCode };
  };

  return {
    apiProcess,
    apiUrl,
    tempDir,
    configPath,
    githubToken,
    cli,
    cleanup: () => apiProcess.kill(),
  };
}
