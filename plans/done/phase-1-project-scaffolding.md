# Phase 1: Project Scaffolding & Infrastructure

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Set up the pnpm monorepo, shared types, Docker Compose, SQLite database, and bare-bones API + CLI that can talk to each other.

**Architecture:** pnpm workspace with three packages (cli, api, shared). API runs Hono on Node.js. CLI uses Commander.js. Shared package holds Zod schemas and TypeScript types. Docker Compose orchestrates Qdrant, Ollama, and the API.

**Tech Stack:** pnpm, TypeScript 5.x, Hono, Commander.js, better-sqlite3, Zod, Vitest, Docker Compose

---

### Task 1: Initialize pnpm workspace root

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `.gitignore`
- Create: `tsconfig.base.json`

**Step 1: Initialize git repo**

```bash
cd /Users/dhruv/Code/ossgard
git init
```

**Step 2: Create root package.json**

```json
{
  "name": "ossgard",
  "private": true,
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "dev": "pnpm --filter @ossgard/api dev"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

**Step 3: Create pnpm-workspace.yaml**

```yaml
packages:
  - "packages/*"
```

**Step 4: Create tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "outDir": "dist",
    "rootDir": "src"
  }
}
```

**Step 5: Create .gitignore**

```
node_modules/
dist/
*.db
.env
```

**Step 6: Install dependencies**

```bash
pnpm install
```

**Step 7: Commit**

```bash
git add -A
git commit -m "chore: initialize pnpm monorepo workspace"
```

---

### Task 2: Create shared types package

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/types.ts`
- Create: `packages/shared/src/schemas.ts`
- Create: `packages/shared/src/index.ts`

**Step 1: Create package.json**

```json
{
  "name": "@ossgard/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "zod": "^3.24.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

**Step 3: Create types.ts with core domain types**

```typescript
// packages/shared/src/types.ts

export interface Repo {
  id: number;
  owner: string;
  name: string;
  lastScanAt: string | null;
  createdAt: string;
}

export interface PR {
  id: number;
  repoId: number;
  number: number;
  title: string;
  body: string | null;
  author: string;
  diffHash: string | null;
  filePaths: string[];
  state: "open" | "closed" | "merged";
  githubEtag: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Scan {
  id: number;
  repoId: number;
  status: ScanStatus;
  phaseCursor: Record<string, unknown> | null;
  prCount: number;
  dupeGroupCount: number;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

export type ScanStatus =
  | "queued"
  | "ingesting"
  | "embedding"
  | "clustering"
  | "verifying"
  | "ranking"
  | "done"
  | "paused"
  | "failed";

export interface DupeGroup {
  id: number;
  scanId: number;
  repoId: number;
  label: string | null;
  prCount: number;
}

export interface DupeGroupMember {
  id: number;
  groupId: number;
  prId: number;
  rank: number;
  score: number;
  rationale: string | null;
}

export interface Job {
  id: string;
  type: JobType;
  payload: Record<string, unknown>;
  status: JobStatus;
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  maxRetries: number;
  runAfter: string | null;
  createdAt: string;
  updatedAt: string;
}

export type JobType = "scan" | "ingest" | "embed" | "cluster" | "verify" | "rank";
export type JobStatus = "queued" | "running" | "done" | "failed" | "paused";

export interface ScanProgress {
  scanId: number;
  status: ScanStatus;
  phase: string;
  progress: { current: number; total: number } | null;
  dupeGroupCount: number;
}
```

**Step 4: Create schemas.ts with Zod API schemas**

```typescript
// packages/shared/src/schemas.ts
import { z } from "zod";

export const TrackRepoRequest = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
});

export const ScanRequest = z.object({
  full: z.boolean().optional().default(false),
});

export const DupesQuery = z.object({
  minScore: z.coerce.number().min(0).max(100).optional(),
});

export const ScanProgressResponse = z.object({
  scanId: z.number(),
  status: z.enum([
    "queued", "ingesting", "embedding", "clustering",
    "verifying", "ranking", "done", "paused", "failed",
  ]),
  phase: z.string(),
  progress: z.object({
    current: z.number(),
    total: z.number(),
  }).nullable(),
  dupeGroupCount: z.number(),
});

export type TrackRepoRequest = z.infer<typeof TrackRepoRequest>;
export type ScanRequest = z.infer<typeof ScanRequest>;
export type DupesQuery = z.infer<typeof DupesQuery>;
export type ScanProgressResponse = z.infer<typeof ScanProgressResponse>;
```

**Step 5: Create index.ts barrel export**

```typescript
// packages/shared/src/index.ts
export * from "./types.js";
export * from "./schemas.js";
```

**Step 6: Install deps and build**

```bash
pnpm install
pnpm --filter @ossgard/shared build
```

**Step 7: Commit**

```bash
git add packages/shared
git commit -m "feat: add shared types and Zod schemas package"
```

---

### Task 3: Create API package skeleton with Hono

**Files:**
- Create: `packages/api/package.json`
- Create: `packages/api/tsconfig.json`
- Create: `packages/api/src/index.ts`
- Create: `packages/api/src/routes/health.ts`
- Test: `packages/api/src/routes/health.test.ts`

**Step 1: Create package.json**

```json
{
  "name": "@ossgard/api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@ossgard/shared": "workspace:*",
    "hono": "^4.7.0",
    "@hono/node-server": "^1.14.0",
    "better-sqlite3": "^11.8.0",
    "uuid": "^11.1.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/uuid": "^10.0.0",
    "tsx": "^4.19.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

**Step 3: Write the failing test for health route**

```typescript
// packages/api/src/routes/health.test.ts
import { describe, it, expect } from "vitest";
import { app } from "../index.js";

describe("GET /health", () => {
  it("returns ok status", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });
});
```

**Step 4: Run test to verify it fails**

```bash
cd /Users/dhruv/Code/ossgard && pnpm --filter @ossgard/api test
```
Expected: FAIL — `app` not exported yet

**Step 5: Create health route**

```typescript
// packages/api/src/routes/health.ts
import { Hono } from "hono";

export const healthRoutes = new Hono();

healthRoutes.get("/health", (c) => {
  return c.json({ status: "ok" });
});
```

**Step 6: Create API entry point**

```typescript
// packages/api/src/index.ts
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { healthRoutes } from "./routes/health.js";

export const app = new Hono();

app.route("/", healthRoutes);

const port = parseInt(process.env.PORT || "3400");

// Only start server if run directly (not imported for tests)
if (process.argv[1] && !process.argv[1].includes("vitest")) {
  serve({ fetch: app.fetch, port }, () => {
    console.log(`ossgard-api running on http://localhost:${port}`);
  });
}
```

**Step 7: Run test to verify it passes**

```bash
cd /Users/dhruv/Code/ossgard && pnpm --filter @ossgard/api test
```
Expected: PASS

**Step 8: Commit**

```bash
git add packages/api
git commit -m "feat: add API package with Hono and health route"
```

---

### Task 4: Set up SQLite database layer

**Files:**
- Create: `packages/api/src/db/schema.ts`
- Create: `packages/api/src/db/database.ts`
- Test: `packages/api/src/db/database.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/api/src/db/database.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "./database.js";

describe("Database", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("creates all tables on initialization", () => {
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("repos");
    expect(names).toContain("prs");
    expect(names).toContain("scans");
    expect(names).toContain("dupe_groups");
    expect(names).toContain("dupe_group_members");
    expect(names).toContain("jobs");
  });

  it("can insert and retrieve a repo", () => {
    const id = db.insertRepo("openclaw", "openclaw");
    const repo = db.getRepo(id);
    expect(repo).toBeDefined();
    expect(repo!.owner).toBe("openclaw");
    expect(repo!.name).toBe("openclaw");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @ossgard/api test
```
Expected: FAIL — Database class doesn't exist

**Step 3: Create schema.ts**

```typescript
// packages/api/src/db/schema.ts
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  owner           TEXT NOT NULL,
  name            TEXT NOT NULL,
  last_scan_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(owner, name)
);

CREATE TABLE IF NOT EXISTS prs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id         INTEGER NOT NULL REFERENCES repos(id),
  number          INTEGER NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT,
  author          TEXT NOT NULL,
  diff_hash       TEXT,
  file_paths      TEXT,
  state           TEXT NOT NULL DEFAULT 'open',
  github_etag     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE(repo_id, number)
);

CREATE TABLE IF NOT EXISTS scans (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id         INTEGER NOT NULL REFERENCES repos(id),
  status          TEXT NOT NULL DEFAULT 'queued',
  phase_cursor    TEXT,
  pr_count        INTEGER DEFAULT 0,
  dupe_group_count INTEGER DEFAULT 0,
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT,
  error           TEXT
);

CREATE TABLE IF NOT EXISTS dupe_groups (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id         INTEGER NOT NULL REFERENCES scans(id),
  repo_id         INTEGER NOT NULL REFERENCES repos(id),
  label           TEXT,
  pr_count        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dupe_group_members (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id        INTEGER NOT NULL REFERENCES dupe_groups(id),
  pr_id           INTEGER NOT NULL REFERENCES prs(id),
  rank            INTEGER NOT NULL,
  score           REAL NOT NULL,
  rationale       TEXT,
  UNIQUE(group_id, pr_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  payload     TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'queued',
  result      TEXT,
  error       TEXT,
  attempts    INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  run_after   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`;
```

**Step 4: Create database.ts**

```typescript
// packages/api/src/db/database.ts
import BetterSqlite3 from "better-sqlite3";
import { SCHEMA } from "./schema.js";
import type { Repo } from "@ossgard/shared";

export class Database {
  readonly raw: BetterSqlite3.Database;

  constructor(path: string) {
    this.raw = new BetterSqlite3(path);
    this.raw.pragma("journal_mode = WAL");
    this.raw.pragma("foreign_keys = ON");
    this.raw.exec(SCHEMA);
  }

  insertRepo(owner: string, name: string): number {
    const stmt = this.raw.prepare(
      "INSERT INTO repos (owner, name) VALUES (?, ?)"
    );
    const result = stmt.run(owner, name);
    return result.lastInsertRowid as number;
  }

  getRepo(id: number): Repo | undefined {
    const row = this.raw
      .prepare("SELECT * FROM repos WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: row.id as number,
      owner: row.owner as string,
      name: row.name as string,
      lastScanAt: row.last_scan_at as string | null,
      createdAt: row.created_at as string,
    };
  }

  getRepoByOwnerName(owner: string, name: string): Repo | undefined {
    const row = this.raw
      .prepare("SELECT * FROM repos WHERE owner = ? AND name = ?")
      .get(owner, name) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: row.id as number,
      owner: row.owner as string,
      name: row.name as string,
      lastScanAt: row.last_scan_at as string | null,
      createdAt: row.created_at as string,
    };
  }

  listRepos(): Repo[] {
    const rows = this.raw.prepare("SELECT * FROM repos").all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as number,
      owner: row.owner as string,
      name: row.name as string,
      lastScanAt: row.last_scan_at as string | null,
      createdAt: row.created_at as string,
    }));
  }

  deleteRepo(id: number): void {
    this.raw.prepare("DELETE FROM repos WHERE id = ?").run(id);
  }

  close(): void {
    this.raw.close();
  }
}
```

**Step 5: Run tests to verify they pass**

```bash
pnpm --filter @ossgard/api test
```
Expected: PASS

**Step 6: Commit**

```bash
git add packages/api/src/db
git commit -m "feat: add SQLite database layer with schema and repo CRUD"
```

---

### Task 5: Create CLI package skeleton

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/src/index.ts`
- Create: `packages/cli/src/client.ts`
- Create: `packages/cli/src/commands/status.ts`
- Test: `packages/cli/src/client.test.ts`

**Step 1: Create package.json**

```json
{
  "name": "ossgard",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "ossgard": "dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "@ossgard/shared": "workspace:*",
    "commander": "^13.1.0",
    "@iarna/toml": "^2.2.5"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

**Step 3: Create HTTP client**

```typescript
// packages/cli/src/client.ts
export class ApiClient {
  constructor(private baseUrl: string = "http://localhost:3400") {}

  async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`API error ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API error ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  async delete(path: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}${path}`, { method: "DELETE" });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API error ${res.status}: ${text}`);
    }
  }
}
```

**Step 4: Write failing test for client**

```typescript
// packages/cli/src/client.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ApiClient } from "./client.js";

// Test against a real API instance — integration test
// For now, just verify the client class exists and constructs
describe("ApiClient", () => {
  it("constructs with default base URL", () => {
    const client = new ApiClient();
    expect(client).toBeDefined();
  });

  it("constructs with custom base URL", () => {
    const client = new ApiClient("http://localhost:9999");
    expect(client).toBeDefined();
  });
});
```

**Step 5: Run test to verify it passes**

```bash
pnpm --filter ossgard test
```
Expected: PASS

**Step 6: Create CLI entry point with status command stub**

```typescript
// packages/cli/src/index.ts
#!/usr/bin/env node
import { Command } from "commander";
import { ApiClient } from "./client.js";

const program = new Command();
const client = new ApiClient();

program
  .name("ossgard")
  .description("AI-powered PR deduplication and ranking for open source projects")
  .version("0.1.0");

program
  .command("status")
  .description("Show tracked repos and scan status")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    try {
      const repos = await client.get("/repos");
      if (opts.json) {
        console.log(JSON.stringify(repos, null, 2));
      } else {
        console.log("Tracked repositories:");
        console.log(JSON.stringify(repos, null, 2));
      }
    } catch (err) {
      console.error("Failed to connect to ossgard API. Is it running? (ossgard up)");
      process.exit(1);
    }
  });

program.parse();
```

**Step 7: Commit**

```bash
git add packages/cli
git commit -m "feat: add CLI package with Commander.js and API client"
```

---

### Task 6: Create Docker Compose and API Dockerfile

**Files:**
- Create: `docker-compose.yml`
- Create: `packages/api/Dockerfile`

**Step 1: Create Dockerfile for the API**

```dockerfile
# packages/api/Dockerfile
FROM node:22-slim

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/

RUN pnpm install --frozen-lockfile

COPY packages/shared/ packages/shared/
COPY packages/api/ packages/api/

RUN pnpm --filter @ossgard/shared build
RUN pnpm --filter @ossgard/api build

ENV PORT=3400
EXPOSE 3400

CMD ["node", "packages/api/dist/index.js"]
```

**Step 2: Create docker-compose.yml**

```yaml
services:
  qdrant:
    image: qdrant/qdrant:latest
    ports:
      - "6333:6333"
    volumes:
      - ossgard-vectors:/qdrant/storage

  ollama:
    image: ollama/ollama:latest
    ports:
      - "11434:11434"
    volumes:
      - ossgard-models:/root/.ollama

  api:
    build:
      context: .
      dockerfile: packages/api/Dockerfile
    ports:
      - "3400:3400"
    depends_on:
      - qdrant
      - ollama
    volumes:
      - ossgard-data:/data
    environment:
      QDRANT_URL: http://qdrant:6333
      OLLAMA_URL: http://ollama:11434
      DATABASE_PATH: /data/ossgard.db

volumes:
  ossgard-vectors:
  ossgard-models:
  ossgard-data:
```

**Step 3: Verify docker compose config is valid**

```bash
cd /Users/dhruv/Code/ossgard && docker compose config --quiet
```
Expected: no errors

**Step 4: Commit**

```bash
git add docker-compose.yml packages/api/Dockerfile
git commit -m "feat: add Docker Compose and API Dockerfile"
```

---

### Task 7: Add repo CRUD routes to API

**Files:**
- Create: `packages/api/src/routes/repos.ts`
- Modify: `packages/api/src/index.ts`
- Test: `packages/api/src/routes/repos.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/api/src/routes/repos.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createApp } from "../app.js";

describe("Repo routes", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp(":memory:");
  });

  it("POST /repos tracks a new repo", async () => {
    const res = await app.request("/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner: "openclaw", name: "openclaw" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.owner).toBe("openclaw");
    expect(body.id).toBeDefined();
  });

  it("GET /repos lists tracked repos", async () => {
    await app.request("/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner: "openclaw", name: "openclaw" }),
    });
    const res = await app.request("/repos");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].owner).toBe("openclaw");
  });

  it("DELETE /repos/:owner/:name untracks a repo", async () => {
    await app.request("/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner: "openclaw", name: "openclaw" }),
    });
    const res = await app.request("/repos/openclaw/openclaw", { method: "DELETE" });
    expect(res.status).toBe(204);

    const list = await app.request("/repos");
    const body = await list.json();
    expect(body).toHaveLength(0);
  });

  it("POST /repos returns 409 for duplicate repo", async () => {
    await app.request("/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner: "openclaw", name: "openclaw" }),
    });
    const res = await app.request("/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner: "openclaw", name: "openclaw" }),
    });
    expect(res.status).toBe(409);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @ossgard/api test
```
Expected: FAIL — `createApp` doesn't exist

**Step 3: Refactor index.ts into app.ts for testability**

Extract the Hono app creation into a factory function so tests can pass `:memory:` databases.

```typescript
// packages/api/src/app.ts
import { Hono } from "hono";
import { Database } from "./db/database.js";
import { healthRoutes } from "./routes/health.js";
import { createRepoRoutes } from "./routes/repos.js";

export function createApp(dbPath: string) {
  const db = new Database(dbPath);
  const app = new Hono();

  app.route("/", healthRoutes);
  app.route("/", createRepoRoutes(db));

  return app;
}
```

Update `index.ts` to use the factory:

```typescript
// packages/api/src/index.ts
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const dbPath = process.env.DATABASE_PATH || "./ossgard.db";
const app = createApp(dbPath);

export { app };

const port = parseInt(process.env.PORT || "3400");

serve({ fetch: app.fetch, port }, () => {
  console.log(`ossgard-api running on http://localhost:${port}`);
});
```

**Step 4: Create repo routes**

```typescript
// packages/api/src/routes/repos.ts
import { Hono } from "hono";
import { TrackRepoRequest } from "@ossgard/shared";
import type { Database } from "../db/database.js";

export function createRepoRoutes(db: Database) {
  const routes = new Hono();

  routes.get("/repos", (c) => {
    const repos = db.listRepos();
    return c.json(repos);
  });

  routes.post("/repos", async (c) => {
    const body = await c.req.json();
    const parsed = TrackRepoRequest.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.format() }, 400);
    }
    const { owner, name } = parsed.data;

    const existing = db.getRepoByOwnerName(owner, name);
    if (existing) {
      return c.json({ error: "Repo already tracked" }, 409);
    }

    const id = db.insertRepo(owner, name);
    const repo = db.getRepo(id);
    return c.json(repo, 201);
  });

  routes.delete("/repos/:owner/:name", (c) => {
    const { owner, name } = c.req.param();
    const repo = db.getRepoByOwnerName(owner, name);
    if (!repo) {
      return c.json({ error: "Repo not found" }, 404);
    }
    db.deleteRepo(repo.id);
    return c.body(null, 204);
  });

  return routes;
}
```

**Step 5: Update health test to use createApp**

```typescript
// packages/api/src/routes/health.test.ts
import { describe, it, expect } from "vitest";
import { createApp } from "../app.js";

describe("GET /health", () => {
  it("returns ok status", async () => {
    const app = createApp(":memory:");
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });
});
```

**Step 6: Run tests to verify they pass**

```bash
pnpm --filter @ossgard/api test
```
Expected: ALL PASS

**Step 7: Commit**

```bash
git add packages/api/src
git commit -m "feat: add repo CRUD routes with validation"
```

---

### Task 8: Wire up CLI track/untrack/status commands

**Files:**
- Modify: `packages/cli/src/index.ts`
- Create: `packages/cli/src/commands/track.ts`
- Create: `packages/cli/src/commands/status.ts`

**Step 1: Create track command**

```typescript
// packages/cli/src/commands/track.ts
import type { Command } from "commander";
import type { ApiClient } from "../client.js";
import type { Repo } from "@ossgard/shared";

export function registerTrackCommands(program: Command, client: ApiClient) {
  program
    .command("track <owner/repo>")
    .description("Start tracking a repository")
    .action(async (slug: string) => {
      const [owner, name] = slug.split("/");
      if (!owner || !name) {
        console.error('Usage: ossgard track <owner/repo>  (e.g. ossgard track openclaw/openclaw)');
        process.exit(1);
      }
      try {
        const repo = await client.post<Repo>("/repos", { owner, name });
        console.log(`Tracking ${repo.owner}/${repo.name}`);
      } catch (err) {
        console.error(`Failed to track: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  program
    .command("untrack <owner/repo>")
    .description("Stop tracking a repository")
    .action(async (slug: string) => {
      const [owner, name] = slug.split("/");
      if (!owner || !name) {
        console.error('Usage: ossgard untrack <owner/repo>');
        process.exit(1);
      }
      try {
        await client.delete(`/repos/${owner}/${name}`);
        console.log(`Untracked ${owner}/${name}`);
      } catch (err) {
        console.error(`Failed to untrack: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
```

**Step 2: Create status command**

```typescript
// packages/cli/src/commands/status.ts
import type { Command } from "commander";
import type { ApiClient } from "../client.js";
import type { Repo } from "@ossgard/shared";

export function registerStatusCommand(program: Command, client: ApiClient) {
  program
    .command("status")
    .description("Show tracked repos and scan status")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      try {
        const repos = await client.get<Repo[]>("/repos");
        if (opts.json) {
          console.log(JSON.stringify(repos, null, 2));
          return;
        }
        if (repos.length === 0) {
          console.log("No repositories tracked. Run: ossgard track <owner/repo>");
          return;
        }
        console.log("Tracked repositories:\n");
        for (const repo of repos) {
          const lastScan = repo.lastScanAt ?? "never";
          console.log(`  ${repo.owner}/${repo.name}  (last scan: ${lastScan})`);
        }
      } catch (err) {
        console.error("Failed to connect to ossgard API. Is it running? (ossgard up)");
        process.exit(1);
      }
    });
}
```

**Step 3: Update CLI entry point**

```typescript
// packages/cli/src/index.ts
#!/usr/bin/env node
import { Command } from "commander";
import { ApiClient } from "./client.js";
import { registerTrackCommands } from "./commands/track.js";
import { registerStatusCommand } from "./commands/status.js";

const program = new Command();
const client = new ApiClient();

program
  .name("ossgard")
  .description("AI-powered PR deduplication and ranking for open source projects")
  .version("0.1.0");

registerTrackCommands(program, client);
registerStatusCommand(program, client);

program.parse();
```

**Step 4: Build and verify CLI help output**

```bash
pnpm --filter ossgard build && node packages/cli/dist/index.js --help
```
Expected: Shows commands: track, untrack, status

**Step 5: Commit**

```bash
git add packages/cli/src
git commit -m "feat: add track, untrack, and status CLI commands"
```
