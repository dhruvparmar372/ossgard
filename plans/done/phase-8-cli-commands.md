# Phase 8: CLI Commands & Config

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete all CLI commands: init, up, down, scan (with polling), dupes (with formatted output), and config management. Wire up the TOML config system.

**Architecture:** CLI is a thin HTTP client to the API. Config lives in `~/.ossgard/config.toml`. The `up`/`down` commands wrap Docker Compose. The `scan` command POSTs to start a scan then polls for progress. The `dupes` command fetches and formats results.

**Tech Stack:** Commander.js, @iarna/toml, ora (spinner), chalk (colors), Vitest

**Depends on:** Phase 1 (CLI skeleton), Phase 2 (scan routes), Phase 7 (dupes routes)

---

### Task 1: Build config system

**Files:**
- Create: `packages/cli/src/config.ts`
- Test: `packages/cli/src/config.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/cli/src/config.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Config } from "./config.js";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("Config", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ossgard-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true });
  });

  it("creates default config file on init", () => {
    const config = new Config(tempDir);
    config.init("ghp_test_token");
    const loaded = config.load();
    expect(loaded.github.token).toBe("ghp_test_token");
    expect(loaded.llm.provider).toBe("ollama");
  });

  it("gets and sets values", () => {
    const config = new Config(tempDir);
    config.init("ghp_test");
    config.set("llm.provider", "anthropic");
    expect(config.get("llm.provider")).toBe("anthropic");
  });

  it("loads existing config", () => {
    const config = new Config(tempDir);
    config.init("ghp_existing");
    const config2 = new Config(tempDir);
    const loaded = config2.load();
    expect(loaded.github.token).toBe("ghp_existing");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter ossgard test -- src/config
```

**Step 3: Implement Config**

```typescript
// packages/cli/src/config.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import TOML from "@iarna/toml";

export interface OssgardConfig {
  github: { token: string };
  llm: { provider: string; model: string; api_key: string };
  embedding: { model: string };
  scan: {
    concurrency: number;
    code_similarity_threshold: number;
    intent_similarity_threshold: number;
  };
}

const DEFAULT_CONFIG: OssgardConfig = {
  github: { token: "" },
  llm: { provider: "ollama", model: "llama3", api_key: "" },
  embedding: { model: "nomic-embed-text" },
  scan: {
    concurrency: 10,
    code_similarity_threshold: 0.85,
    intent_similarity_threshold: 0.80,
  },
};

export class Config {
  private configPath: string;

  constructor(configDir?: string) {
    const dir = configDir ?? join(process.env.HOME ?? "~", ".ossgard");
    this.configPath = join(dir, "config.toml");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  init(githubToken: string): void {
    const config = { ...DEFAULT_CONFIG, github: { token: githubToken } };
    writeFileSync(this.configPath, TOML.stringify(config as any));
  }

  load(): OssgardConfig {
    if (!existsSync(this.configPath)) {
      return DEFAULT_CONFIG;
    }
    const content = readFileSync(this.configPath, "utf-8");
    const parsed = TOML.parse(content);
    return { ...DEFAULT_CONFIG, ...parsed } as unknown as OssgardConfig;
  }

  get(key: string): string | number | undefined {
    const config = this.load();
    const parts = key.split(".");
    let current: any = config;
    for (const part of parts) {
      if (current === undefined) return undefined;
      current = current[part];
    }
    return current;
  }

  set(key: string, value: string): void {
    const config = this.load() as any;
    const parts = key.split(".");
    let current = config;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]]) current[parts[i]] = {};
      current = current[parts[i]];
    }
    // Try to preserve type (number vs string)
    const numVal = Number(value);
    current[parts[parts.length - 1]] = isNaN(numVal) ? value : numVal;
    writeFileSync(this.configPath, TOML.stringify(config));
  }

  exists(): boolean {
    return existsSync(this.configPath);
  }
}
```

**Step 4: Run tests**

```bash
pnpm --filter ossgard test -- src/config
```
Expected: ALL PASS

**Step 5: Commit**

```bash
git add packages/cli/src/config.ts packages/cli/src/config.test.ts
git commit -m "feat: add TOML config system for CLI"
```

---

### Task 2: Add init and config CLI commands

**Files:**
- Create: `packages/cli/src/commands/init.ts`
- Create: `packages/cli/src/commands/config.ts`
- Modify: `packages/cli/src/index.ts`

**Step 1: Create init command**

```typescript
// packages/cli/src/commands/init.ts
import type { Command } from "commander";
import { Config } from "../config.js";
import { createInterface } from "readline";

export function registerInitCommand(program: Command) {
  program
    .command("init")
    .description("Initialize ossgard configuration")
    .action(async () => {
      const config = new Config();
      if (config.exists()) {
        console.log("Config already exists at ~/.ossgard/config.toml");
        return;
      }

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const token = await new Promise<string>((resolve) => {
        rl.question("GitHub personal access token: ", (answer) => {
          rl.close();
          resolve(answer.trim());
        });
      });

      if (!token) {
        console.error("Token is required.");
        process.exit(1);
      }

      config.init(token);
      console.log("Created ~/.ossgard/config.toml");
      console.log("Run `ossgard up` to start the stack.");
    });
}
```

**Step 2: Create config command**

```typescript
// packages/cli/src/commands/config.ts
import type { Command } from "commander";
import { Config } from "../config.js";

export function registerConfigCommand(program: Command) {
  const configCmd = program.command("config").description("Manage configuration");

  configCmd
    .command("get <key>")
    .description("Get a config value")
    .action((key: string) => {
      const config = new Config();
      const value = config.get(key);
      if (value === undefined) {
        console.error(`Key not found: ${key}`);
        process.exit(1);
      }
      console.log(value);
    });

  configCmd
    .command("set <key> <value>")
    .description("Set a config value")
    .action((key: string, value: string) => {
      const config = new Config();
      config.set(key, value);
      console.log(`Set ${key} = ${value}`);
    });
}
```

**Step 3: Wire into index.ts**

```typescript
import { registerInitCommand } from "./commands/init.js";
import { registerConfigCommand } from "./commands/config.js";
// ...
registerInitCommand(program);
registerConfigCommand(program);
```

**Step 4: Build and test help output**

```bash
pnpm --filter ossgard build && node packages/cli/dist/index.js --help
```
Expected: Shows init, config commands

**Step 5: Commit**

```bash
git add packages/cli/src
git commit -m "feat: add init and config CLI commands"
```

---

### Task 3: Add up/down commands (Docker Compose wrapper)

**Files:**
- Create: `packages/cli/src/commands/stack.ts`
- Modify: `packages/cli/src/index.ts`

**Step 1: Create stack commands**

```typescript
// packages/cli/src/commands/stack.ts
import type { Command } from "commander";
import { execSync, spawn } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";

function findComposeFile(): string {
  // Look for docker-compose.yml relative to the package
  const candidates = [
    resolve(import.meta.dirname, "../../../docker-compose.yml"),  // dev
    resolve(import.meta.dirname, "../../docker-compose.yml"),     // built
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error("docker-compose.yml not found. Are you in the ossgard directory?");
}

export function registerStackCommands(program: Command) {
  program
    .command("up")
    .description("Start the ossgard stack (Qdrant, Ollama, API)")
    .option("--detach", "Run in background")
    .action(async (opts) => {
      try {
        const composePath = findComposeFile();
        console.log("Starting ossgard stack...");

        const args = ["-f", composePath, "up", "--build"];
        if (opts.detach) args.push("-d");

        const child = spawn("docker", ["compose", ...args], {
          stdio: "inherit",
        });

        child.on("exit", (code) => {
          if (code !== 0) process.exit(code ?? 1);
        });
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    });

  program
    .command("down")
    .description("Stop the ossgard stack")
    .action(async () => {
      try {
        const composePath = findComposeFile();
        console.log("Stopping ossgard stack...");
        execSync(`docker compose -f ${composePath} down`, { stdio: "inherit" });
      } catch (err) {
        console.error("Failed to stop stack:", (err as Error).message);
        process.exit(1);
      }
    });
}
```

**Step 2: Wire into index.ts**

```typescript
import { registerStackCommands } from "./commands/stack.js";
registerStackCommands(program);
```

**Step 3: Commit**

```bash
git add packages/cli/src
git commit -m "feat: add up/down commands to manage Docker Compose stack"
```

---

### Task 4: Add scan command with polling progress

**Files:**
- Create: `packages/cli/src/commands/scan.ts`
- Modify: `packages/cli/src/index.ts`

**Step 1: Create scan command**

```typescript
// packages/cli/src/commands/scan.ts
import type { Command } from "commander";
import type { ApiClient } from "../client.js";

interface ScanStatus {
  scanId: number;
  status: string;
  prCount: number;
  dupeGroupCount: number;
  error: string | null;
}

function renderProgress(status: ScanStatus): void {
  const phases: Record<string, string> = {
    queued: "Queued...",
    ingesting: `Ingesting PRs (${status.prCount} found)`,
    embedding: `Generating embeddings (${status.prCount} PRs)`,
    clustering: "Finding similar PR clusters",
    verifying: "Verifying duplicates with LLM",
    ranking: "Ranking PRs in duplicate groups",
    done: `Done! Found ${status.dupeGroupCount} duplicate groups across ${status.prCount} PRs.`,
    failed: `Failed: ${status.error}`,
    paused: "Paused (rate limited), will resume automatically",
  };

  // Clear line and rewrite
  process.stdout.write(`\r  ${phases[status.status] ?? status.status}${"".padEnd(20)}`);
  if (status.status === "done" || status.status === "failed") {
    process.stdout.write("\n");
  }
}

export function registerScanCommand(program: Command, client: ApiClient) {
  program
    .command("scan <owner/repo>")
    .description("Scan a repository for duplicate PRs")
    .option("--full", "Full scan (ignore incremental cache)")
    .option("--no-wait", "Enqueue scan and exit without waiting")
    .option("--json", "Output as JSON")
    .action(async (slug: string, opts) => {
      const [owner, name] = slug.split("/");
      if (!owner || !name) {
        console.error("Usage: ossgard scan <owner/repo>");
        process.exit(1);
      }

      try {
        const { scanId, status } = await client.post<{ scanId: number; status: string }>(
          `/repos/${owner}/${name}/scan`
        );

        if (opts.noWait) {
          if (opts.json) {
            console.log(JSON.stringify({ scanId, status }));
          } else {
            console.log(`Scan ${scanId} queued. Check with: ossgard status`);
          }
          return;
        }

        console.log(`Scanning ${owner}/${name}...`);

        // Poll for progress
        while (true) {
          const scanStatus = await client.get<ScanStatus>(`/scans/${scanId}`);

          if (opts.json) {
            // In JSON mode, print final result only
            if (scanStatus.status === "done" || scanStatus.status === "failed") {
              console.log(JSON.stringify(scanStatus, null, 2));
              break;
            }
          } else {
            renderProgress(scanStatus);
          }

          if (scanStatus.status === "done") {
            console.log(`\nRun \`ossgard dupes ${owner}/${name}\` to view results.`);
            break;
          }
          if (scanStatus.status === "failed") {
            process.exit(1);
          }

          await new Promise((r) => setTimeout(r, 1000));
        }
      } catch (err) {
        console.error(`Scan failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
```

**Step 2: Wire into index.ts**

```typescript
import { registerScanCommand } from "./commands/scan.js";
registerScanCommand(program, client);
```

**Step 3: Commit**

```bash
git add packages/cli/src
git commit -m "feat: add scan command with progress polling"
```

---

### Task 5: Add dupes command with formatted output

**Files:**
- Create: `packages/cli/src/commands/dupes.ts`
- Create: `packages/api/src/routes/dupes.ts` (API endpoint)
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/api/src/app.ts`

**Step 1: Create the dupes API route**

```typescript
// packages/api/src/routes/dupes.ts
import { Hono } from "hono";
import type { Database } from "../db/database.js";

export function createDupesRoutes(db: Database) {
  const routes = new Hono();

  routes.get("/repos/:owner/:name/dupes", (c) => {
    const { owner, name } = c.req.param();
    const repo = db.getRepoByOwnerName(owner, name);
    if (!repo) return c.json({ error: "Repo not found" }, 404);

    // Get the latest completed scan
    const scan = db.getLatestCompletedScan(repo.id);
    if (!scan) return c.json({ error: "No completed scans" }, 404);

    const groups = db.listDupeGroups(scan.id);
    const result = groups.map((group) => {
      const members = db.listDupeGroupMembers(group.id);
      const prsWithDetails = members.map((m) => {
        const allPrs = db.listOpenPRs(repo.id);
        const pr = allPrs.find((p) => p.id === m.prId);
        return {
          number: pr?.number,
          title: pr?.title,
          author: pr?.author,
          rank: m.rank,
          score: m.score,
          rationale: m.rationale,
        };
      });

      return {
        id: group.id,
        label: group.label,
        prCount: group.prCount,
        prs: prsWithDetails,
      };
    });

    return c.json({
      scanId: scan.id,
      completedAt: scan.completedAt,
      totalPRs: scan.prCount,
      dupeGroupCount: groups.length,
      groups: result,
    });
  });

  return routes;
}
```

**Step 2: Add getLatestCompletedScan to Database**

```typescript
// Add to packages/api/src/db/database.ts
getLatestCompletedScan(repoId: number): Scan | undefined {
  const row = this.raw
    .prepare("SELECT * FROM scans WHERE repo_id = ? AND status = 'done' ORDER BY completed_at DESC LIMIT 1")
    .get(repoId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return this.rowToScan(row);
}
```

**Step 3: Create CLI dupes command**

```typescript
// packages/cli/src/commands/dupes.ts
import type { Command } from "commander";
import type { ApiClient } from "../client.js";

interface DupeResult {
  scanId: number;
  completedAt: string;
  totalPRs: number;
  dupeGroupCount: number;
  groups: Array<{
    id: number;
    label: string;
    prCount: number;
    prs: Array<{
      number: number;
      title: string;
      author: string;
      rank: number;
      score: number;
      rationale: string;
    }>;
  }>;
}

export function registerDupesCommand(program: Command, client: ApiClient) {
  program
    .command("dupes <owner/repo>")
    .description("Show duplicate PR groups with rankings")
    .option("--json", "Output as JSON")
    .option("--min-score <n>", "Only show PRs with score >= n", "0")
    .action(async (slug: string, opts) => {
      const [owner, name] = slug.split("/");
      if (!owner || !name) {
        console.error("Usage: ossgard dupes <owner/repo>");
        process.exit(1);
      }

      try {
        const result = await client.get<DupeResult>(`/repos/${owner}/${name}/dupes`);

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        const minScore = parseInt(opts.minScore);

        console.log(`\n  ${result.dupeGroupCount} duplicate groups found across ${result.totalPRs} open PRs`);
        console.log(`  Scan completed: ${result.completedAt}\n`);

        for (const group of result.groups) {
          console.log(`  ── ${group.label} (${group.prCount} PRs) ${"─".repeat(40)}`);
          console.log("");

          for (const pr of group.prs) {
            if (pr.score < minScore) continue;
            const marker = pr.rank === 1 ? " *" : "  ";
            const recommend = pr.rank === 1 ? " (RECOMMENDED)" : "";
            console.log(`  ${marker} #${pr.number} by @${pr.author}  — Score: ${pr.score}/100${recommend}`);
            console.log(`     ${pr.title}`);
            if (pr.rationale) {
              console.log(`     ${pr.rationale}`);
            }
            console.log("");
          }
        }
      } catch (err) {
        console.error(`Failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
```

**Step 4: Wire dupes route into API and CLI**

API `app.ts`:
```typescript
import { createDupesRoutes } from "./routes/dupes.js";
app.route("/", createDupesRoutes(db));
```

CLI `index.ts`:
```typescript
import { registerDupesCommand } from "./commands/dupes.js";
registerDupesCommand(program, client);
```

**Step 5: Commit**

```bash
git add packages/api/src packages/cli/src
git commit -m "feat: add dupes API route and CLI command with formatted output"
```
