# Bun Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate ossgard from pnpm/Node.js to Bun runtime for native SQLite, simplified server, and standalone CLI binary compilation.

**Architecture:** Replace the pnpm package manager with Bun workspaces, swap `better-sqlite3` for `bun:sqlite`, replace `@hono/node-server` with `Bun.serve()`, and migrate `vitest` to `bun:test`. Each step is verified by the existing test suite before proceeding.

**Tech Stack:** Bun runtime, bun:sqlite, bun:test, Hono (unchanged), Bun.serve()

---

### Task 1: Create feature branch

**Files:** None

**Step 1: Create and checkout the migration branch**

Run: `git checkout -b feat/bun-migration`
Expected: Switched to new branch 'feat/bun-migration'

---

### Task 2: Swap package manager — root package.json

**Files:**
- Modify: `package.json` (root)

**Step 1: Update root package.json**

Replace the entire file content with:

```json
{
  "name": "ossgard",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "bun run --filter '*' build",
    "test": "bun run --filter '*' test",
    "dev": "bun run --cwd packages/api dev",
    "test:e2e": "vitest run --config e2e/vitest.config.ts"
  },
  "devDependencies": {
    "vitest": "^3.2.4"
  }
}
```

Key changes:
- Added `"workspaces": ["packages/*"]` (Bun reads this instead of pnpm-workspace.yaml)
- Removed `"engines"` block (Bun, not Node)
- Removed `"pnpm"` config block (no longer needed)
- Updated `build`, `test`, `dev` scripts to use `bun run`
- Kept `test:e2e` as vitest for now (migrated in Task 7)

**Step 2: Verify the edit**

Run: `cat package.json`
Expected: Should show `"workspaces"` field, no `"pnpm"` block, `bun run` in scripts.

---

### Task 3: Swap package manager — API package.json

**Files:**
- Modify: `packages/api/package.json`

**Step 1: Update API scripts and remove tsx**

In `packages/api/package.json`, make these changes:
- Change `"dev"` from `"tsx watch src/index.ts"` to `"bun --watch src/index.ts"`
- Change `"start"` from `"node dist/index.js"` to `"bun dist/index.js"`
- Remove `"tsx": "^4.19.0"` from devDependencies

Result should be:

```json
{
  "name": "@ossgard/api",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "dev": "bun --watch src/index.ts",
    "start": "bun dist/index.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@hono/node-server": "^1.14.0",
    "@iarna/toml": "^2.2.5",
    "@ossgard/shared": "workspace:*",
    "@qdrant/js-client-rest": "^1.16.2",
    "better-sqlite3": "^11.8.0",
    "hono": "^4.7.0",
    "uuid": "^11.1.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/iarna__toml": "^2.0.5",
    "@types/uuid": "^10.0.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

---

### Task 4: Swap package manager — CLI package.json

**Files:**
- Modify: `packages/cli/package.json`

**Step 1: Update CLI scripts and remove tsx**

In `packages/cli/package.json`, make these changes:
- Change `"dev"` from `"tsx src/index.ts"` to `"bun src/index.ts"`
- Change `"start"` from `"node dist/index.js"` to `"bun dist/index.js"`
- Remove `"tsx": "^4.19.0"` from devDependencies

Result should be:

```json
{
  "name": "ossgard",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "ossgard": "dist/index.js"
  },
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "dev": "bun src/index.ts",
    "start": "bun dist/index.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@ossgard/shared": "workspace:*",
    "commander": "^13.1.0",
    "@iarna/toml": "^2.2.5"
  },
  "devDependencies": {
    "@types/iarna__toml": "^2.0.5",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

---

### Task 5: Delete pnpm files and install with Bun

**Files:**
- Delete: `pnpm-lock.yaml`
- Delete: `pnpm-workspace.yaml`

**Step 1: Delete pnpm workspace and lock files**

Run: `rm pnpm-lock.yaml pnpm-workspace.yaml`
Expected: No errors

**Step 2: Install dependencies with Bun**

Run: `bun install`
Expected: Generates `bun.lock`, installs all workspace deps including `better-sqlite3` native module.

**Step 3: Verify build works**

Run: `bun run build`
Expected: TypeScript compilation succeeds for shared, api, and cli packages.

**Step 4: Verify tests pass**

Run: `bun run test`
Expected: All tests pass. Tests still use vitest at this point (bun invokes `vitest run` per package).

**Step 5: Commit**

```bash
git add package.json packages/api/package.json packages/cli/package.json bun.lock
git add -u  # stages deletions of pnpm-lock.yaml and pnpm-workspace.yaml
git commit -m "chore: swap package manager from pnpm to bun"
```

---

### Task 6: Migrate database.ts — imports and constructor

**Files:**
- Modify: `packages/api/src/db/database.ts`

**Step 1: Update import and constructor**

In `packages/api/src/db/database.ts`:

Replace line 1:
```typescript
import BetterSqlite3 from "better-sqlite3";
```
With:
```typescript
import { Database as BunDatabase } from "bun:sqlite";
```

Replace line 133 (the `raw` property declaration):
```typescript
  readonly raw: BetterSqlite3.Database;
```
With:
```typescript
  readonly raw: BunDatabase;
```

Replace lines 136-139 (constructor body):
```typescript
    this.raw = new BetterSqlite3(path);
    this.raw.pragma("journal_mode = WAL");
    this.raw.pragma("foreign_keys = ON");
    this.raw.exec(SCHEMA);
```
With:
```typescript
    this.raw = new BunDatabase(path, { strict: true });
    this.raw.run("PRAGMA journal_mode = WAL");
    this.raw.run("PRAGMA foreign_keys = ON");
    this.raw.run(SCHEMA);
```

---

### Task 7: Migrate database.ts — update return types for .get() null semantics

**Files:**
- Modify: `packages/api/src/db/database.ts`

**Context:** In better-sqlite3, `.get()` returns `undefined` when no row matches. In bun:sqlite, `.get()` returns `null`. We update all methods that return `Type | undefined` to use `Type | null` and change the corresponding checks.

**Step 1: Update getRepo**

Replace (around line 150):
```typescript
  getRepo(id: number): Repo | undefined {
    const stmt = this.raw.prepare("SELECT * FROM repos WHERE id = ?");
    const row = stmt.get(id) as RepoRow | undefined;
    return row ? mapRepoRow(row) : undefined;
  }
```
With:
```typescript
  getRepo(id: number): Repo | null {
    const stmt = this.raw.prepare("SELECT * FROM repos WHERE id = ?");
    const row = stmt.get(id) as RepoRow | null;
    return row ? mapRepoRow(row) : null;
  }
```

**Step 2: Update getRepoByOwnerName**

Replace (around line 156):
```typescript
  getRepoByOwnerName(owner: string, name: string): Repo | undefined {
    const stmt = this.raw.prepare(
      "SELECT * FROM repos WHERE owner = ? AND name = ?"
    );
    const row = stmt.get(owner, name) as RepoRow | undefined;
    return row ? mapRepoRow(row) : undefined;
  }
```
With:
```typescript
  getRepoByOwnerName(owner: string, name: string): Repo | null {
    const stmt = this.raw.prepare(
      "SELECT * FROM repos WHERE owner = ? AND name = ?"
    );
    const row = stmt.get(owner, name) as RepoRow | null;
    return row ? mapRepoRow(row) : null;
  }
```

**Step 3: Update getScan**

Replace (around line 199):
```typescript
  getScan(id: number): Scan | undefined {
    const stmt = this.raw.prepare("SELECT * FROM scans WHERE id = ?");
    const row = stmt.get(id) as ScanRow | undefined;
    return row ? mapScanRow(row) : undefined;
  }
```
With:
```typescript
  getScan(id: number): Scan | null {
    const stmt = this.raw.prepare("SELECT * FROM scans WHERE id = ?");
    const row = stmt.get(id) as ScanRow | null;
    return row ? mapScanRow(row) : null;
  }
```

**Step 4: Update getPRByNumber**

Replace (around line 271):
```typescript
  getPRByNumber(repoId: number, number: number): PR | undefined {
    const stmt = this.raw.prepare(
      "SELECT * FROM prs WHERE repo_id = ? AND number = ?"
    );
    const row = stmt.get(repoId, number) as PRRow | undefined;
    return row ? mapPRRow(row) : undefined;
  }
```
With:
```typescript
  getPRByNumber(repoId: number, number: number): PR | null {
    const stmt = this.raw.prepare(
      "SELECT * FROM prs WHERE repo_id = ? AND number = ?"
    );
    const row = stmt.get(repoId, number) as PRRow | null;
    return row ? mapPRRow(row) : null;
  }
```

**Step 5: Update getPR**

Replace (around line 287):
```typescript
  getPR(id: number): PR | undefined {
    const stmt = this.raw.prepare("SELECT * FROM prs WHERE id = ?");
    const row = stmt.get(id) as PRRow | undefined;
    return row ? mapPRRow(row) : undefined;
  }
```
With:
```typescript
  getPR(id: number): PR | null {
    const stmt = this.raw.prepare("SELECT * FROM prs WHERE id = ?");
    const row = stmt.get(id) as PRRow | null;
    return row ? mapPRRow(row) : null;
  }
```

**Step 6: Update getLatestCompletedScan**

Replace (around line 351):
```typescript
  getLatestCompletedScan(repoId: number): Scan | undefined {
    const stmt = this.raw.prepare(
      "SELECT * FROM scans WHERE repo_id = ? AND status = 'done' ORDER BY completed_at DESC LIMIT 1"
    );
    const row = stmt.get(repoId) as ScanRow | undefined;
    return row ? mapScanRow(row) : undefined;
  }
```
With:
```typescript
  getLatestCompletedScan(repoId: number): Scan | null {
    const stmt = this.raw.prepare(
      "SELECT * FROM scans WHERE repo_id = ? AND status = 'done' ORDER BY completed_at DESC LIMIT 1"
    );
    const row = stmt.get(repoId) as ScanRow | null;
    return row ? mapScanRow(row) : null;
  }
```

---

### Task 8: Migrate local-job-queue.ts to bun:sqlite

**Files:**
- Modify: `packages/api/src/queue/local-job-queue.ts`

**Step 1: Update import and type**

Replace line 2:
```typescript
import type BetterSqlite3 from "better-sqlite3";
```
With:
```typescript
import type { Database } from "bun:sqlite";
```

Replace lines 44-46 (class property and constructor):
```typescript
export class LocalJobQueue implements JobQueue {
  private db: BetterSqlite3.Database;

  constructor(db: BetterSqlite3.Database) {
```
With:
```typescript
export class LocalJobQueue implements JobQueue {
  private db: Database;

  constructor(db: Database) {
```

**Step 2: Update .get() null semantics**

The `getStatus` method (line 68) already returns `Job | null` and uses `row ? mapJobRow(row) : null`, but the type cast is `as JobRow | undefined`. Update:

Replace:
```typescript
    const row = stmt.get(jobId) as JobRow | undefined;
```
With:
```typescript
    const row = stmt.get(jobId) as JobRow | null;
```

The `dequeue` method (line 87) — same fix:

Replace:
```typescript
    const row = stmt.get() as JobRow | undefined;
```
With:
```typescript
    const row = stmt.get() as JobRow | null;
```

---

### Task 9: Update API package.json — remove better-sqlite3

**Files:**
- Modify: `packages/api/package.json`

**Step 1: Remove better-sqlite3 dependencies**

Remove `"better-sqlite3": "^11.8.0"` from `dependencies`.
Remove `"@types/better-sqlite3": "^7.6.13"` from `devDependencies`.

The dependencies section should now be:
```json
  "dependencies": {
    "@hono/node-server": "^1.14.0",
    "@iarna/toml": "^2.2.5",
    "@ossgard/shared": "workspace:*",
    "@qdrant/js-client-rest": "^1.16.2",
    "hono": "^4.7.0",
    "uuid": "^11.1.0"
  },
```

The devDependencies section should now be:
```json
  "devDependencies": {
    "@types/iarna__toml": "^2.0.5",
    "@types/uuid": "^10.0.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
```

---

### Task 10: Fix callers of Database methods that changed from undefined to null

**Files:**
- Modify: Multiple files that call `getRepo`, `getRepoByOwnerName`, `getScan`, `getPRByNumber`, `getPR`, `getLatestCompletedScan`

**Step 1: Find all callers that check for undefined**

Run: `grep -rn "=== undefined\|!== undefined\|toBeUndefined\|toBeDefined" packages/ --include="*.ts" | grep -v node_modules | grep -v ".d.ts"`

This will identify all locations that need updating. Common patterns:
- Test assertions like `expect(fetched).toBeUndefined()` → `expect(fetched).toBeNull()`
- Test assertions like `expect(fetched).toBeDefined()` → `expect(fetched).not.toBeNull()`
- Guard checks like `if (repo === undefined)` → `if (repo === null)` or `if (!repo)`

**Step 2: Update database.test.ts**

In `packages/api/tests/database.test.ts`:

Replace the WAL pragma test (around line 32-38):
```typescript
    it("enables WAL mode for file-based databases", () => {
      // In-memory databases use "memory" journal mode; WAL only applies to files.
      // We verify the pragma is set, but :memory: always returns "memory".
      const result = db.raw.pragma("journal_mode") as { journal_mode: string }[];
      // :memory: dbs cannot use WAL, so just verify it returns a valid mode
      expect(["wal", "memory"]).toContain(result[0].journal_mode);
    });
```
With:
```typescript
    it("enables WAL mode for file-based databases", () => {
      const result = db.raw.query("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(["wal", "memory"]).toContain(result.journal_mode);
    });
```

Replace the foreign keys test (around line 40-43):
```typescript
    it("enables foreign keys", () => {
      const result = db.raw.pragma("foreign_keys") as { foreign_keys: number }[];
      expect(result[0].foreign_keys).toBe(1);
    });
```
With:
```typescript
    it("enables foreign keys", () => {
      const result = db.raw.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
      expect(result.foreign_keys).toBe(1);
    });
```

Replace `toBeDefined()` assertions (around lines 59, 74):
```typescript
      expect(fetched).toBeDefined();
```
With:
```typescript
      expect(fetched).not.toBeNull();
```

Replace `toBeUndefined()` assertions (around lines 66, 78):
```typescript
      expect(fetched).toBeUndefined();
```
With:
```typescript
      expect(fetched).toBeNull();
```

The PR test assertion on line 179:
```typescript
      expect(pr).toBeUndefined();
```
With:
```typescript
      expect(pr).toBeNull();
```

And line 174 `expect(pr).toBeDefined()` → `expect(pr).not.toBeNull()`.

**Step 3: Update all route/pipeline callers**

Search for usages in route handlers and pipeline processors. Any code that does:
```typescript
if (!repo) { ... }  // Already works with null
if (repo === undefined) { ... }  // Needs to change to === null
```

The falsy checks (`if (!repo)`) work for both `null` and `undefined`, so only explicit `=== undefined` checks need updating.

Run: `grep -rn "=== undefined" packages/api/src/ --include="*.ts" | grep -v node_modules`

Update each match to use `=== null` instead.

**Step 4: Run bun install and tests**

Run: `bun install && bun run test`
Expected: All tests pass with bun:sqlite.

**Step 5: Commit**

```bash
git add packages/api/
git commit -m "feat: migrate better-sqlite3 to bun:sqlite"
```

---

### Task 11: Switch @hono/node-server to Bun.serve()

**Files:**
- Modify: `packages/api/src/index.ts`
- Modify: `packages/api/package.json`

**Step 1: Update the server entry point**

In `packages/api/src/index.ts`:

Remove line 2:
```typescript
import { serve } from "@hono/node-server";
```

Replace the serve() call block (around lines 117-121):
```typescript
  serve({ fetch: app.fetch, port }, () => {
    console.log(`ossgard-api listening on http://localhost:${port}`);
    ctx.worker.start();
    console.log("Worker loop started");
  });
```
With:
```typescript
  const server = Bun.serve({ fetch: app.fetch, port });
  console.log(`ossgard-api listening on http://localhost:${server.port}`);
  ctx.worker.start();
  console.log("Worker loop started");
```

Update the shutdown handler (around lines 123-128). Add `server.stop()`:
```typescript
  const shutdown = () => {
    console.log("Shutting down gracefully...");
    server.stop();
    ctx.worker.stop();
    db.close();
    process.exit(0);
  };
```

**Step 2: Remove @hono/node-server from dependencies**

In `packages/api/package.json`, remove `"@hono/node-server": "^1.14.0"` from dependencies.

The dependencies section should now be:
```json
  "dependencies": {
    "@iarna/toml": "^2.2.5",
    "@ossgard/shared": "workspace:*",
    "@qdrant/js-client-rest": "^1.16.2",
    "hono": "^4.7.0",
    "uuid": "^11.1.0"
  },
```

**Step 3: Reinstall and verify tests**

Run: `bun install && bun run test`
Expected: All tests pass (API tests use `app.request()`, not the server binding).

**Step 4: Commit**

```bash
git add packages/api/src/index.ts packages/api/package.json bun.lock
git commit -m "feat: switch from @hono/node-server to Bun.serve()"
```

---

### Task 12: Migrate vitest to bun:test — simple test files (no mocking)

These 13 test files only import `describe`, `it`, `expect`, `beforeEach`, `afterEach`, `beforeAll`, `afterAll` from vitest. Since bun:test provides all of these as globals, we just remove the import line.

**Files:**
- Modify: `packages/api/tests/database.test.ts`
- Modify: `packages/api/tests/health.test.ts`
- Modify: `packages/api/tests/repos.test.ts`
- Modify: `packages/api/tests/scans.test.ts`
- Modify: `packages/api/tests/dupes.test.ts`
- Modify: `packages/api/src/queue/local-job-queue.test.ts`
- Modify: `packages/api/src/pipeline/union-find.test.ts`
- Modify: `packages/api/src/pipeline/normalize-diff.test.ts`
- Modify: `packages/api/src/services/factory.test.ts`
- Modify: `packages/cli/tests/client.test.ts`
- Modify: `packages/cli/tests/config.test.ts`
- Modify: `e2e/smoke.test.ts`
- Modify: `e2e/openclaw.test.ts`

**Step 1: Remove vitest imports from all simple test files**

In each file listed above, delete the first line that reads:
```typescript
import { describe, it, expect, ... } from "vitest";
```

These globals are automatically available in bun:test without imports.

---

### Task 13: Migrate vitest to bun:test — test files with vi.fn() mocking

These test files use `vi.fn()` and `vi.mocked()`. Bun provides `vi` as a global for vitest compatibility, so `vi.fn()`, `vi.fn().mockResolvedValue()`, `vi.fn().mockImplementation()`, and `vi.spyOn()` should work as-is. Remove the vitest import.

**Files (remove `import { ... } from "vitest"` line):**
- Modify: `packages/api/src/services/ollama-provider.test.ts`
- Modify: `packages/api/src/services/github-client.test.ts`
- Modify: `packages/api/src/services/openai-batch-embedding-provider.test.ts`
- Modify: `packages/api/src/services/rate-limiter.test.ts`
- Modify: `packages/api/src/services/anthropic-batch-provider.test.ts`
- Modify: `packages/api/src/services/openai-embedding-provider.test.ts`
- Modify: `packages/api/src/services/anthropic-provider.test.ts`
- Modify: `packages/api/src/services/qdrant-store.test.ts`
- Modify: `packages/api/src/queue/worker.test.ts`
- Modify: `packages/api/src/pipeline/rank.test.ts`
- Modify: `packages/api/src/pipeline/embed.test.ts`
- Modify: `packages/api/src/pipeline/scan-orchestrator.test.ts`
- Modify: `packages/api/src/pipeline/verify.test.ts`
- Modify: `packages/api/src/pipeline/cluster.test.ts`
- Modify: `packages/api/src/pipeline/ingest.test.ts`

**Step 1: Remove vitest imports**

In each file listed above, delete line 1:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
```

All `vi.fn()`, `vi.mocked()`, `vi.spyOn()` calls remain unchanged — they use the global `vi` object provided by bun:test for vitest compatibility.

**Step 2: If vi.mocked() fails under bun:test**

If `vi.mocked()` is not available as a global, replace all `vi.mocked(fn)` calls with just `fn` — since `vi.fn()` returns a mock with `.mock` property already accessible. For example:

```typescript
// Before:
const callArgs = vi.mocked(fetchFn).mock.calls[0];
// After:
const callArgs = (fetchFn as any).mock.calls[0];
```

But try removing just the import first — it's likely all vi methods work as globals.

---

### Task 14: Update test scripts and remove vitest config files

**Files:**
- Modify: `package.json` (root)
- Modify: `packages/api/package.json`
- Modify: `packages/cli/package.json`
- Delete: `packages/api/vitest.config.ts`
- Delete: `packages/cli/vitest.config.ts`
- Delete: `e2e/vitest.config.ts`

**Step 1: Update per-package test scripts**

In `packages/api/package.json`, change:
```json
"test": "vitest run"
```
To:
```json
"test": "bun test"
```

In `packages/cli/package.json`, change:
```json
"test": "vitest run"
```
To:
```json
"test": "bun test"
```

**Step 2: Update root package.json**

Change the e2e script:
```json
"test:e2e": "vitest run --config e2e/vitest.config.ts"
```
To:
```json
"test:e2e": "bun test e2e/"
```

Remove `"vitest": "^3.2.4"` from root devDependencies. Also remove `vitest` from `packages/api/package.json` and `packages/cli/package.json` devDependencies.

The root package.json devDependencies should be empty (or the key removed).

**Step 3: Delete vitest config files**

Run: `rm packages/api/vitest.config.ts packages/cli/vitest.config.ts e2e/vitest.config.ts`

**Step 4: Reinstall dependencies**

Run: `bun install`

**Step 5: Run all tests**

Run: `bun run test`
Expected: All unit tests pass under bun:test.

Run: `bun run test:e2e` (if stack is running)
Expected: E2E tests pass.

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: migrate vitest to bun:test"
```

---

### Task 15: Update Dockerfile for Bun

**Files:**
- Modify: `packages/api/Dockerfile`

**Step 1: Rewrite Dockerfile**

Replace the entire `packages/api/Dockerfile` with:

```dockerfile
FROM oven/bun:latest AS base

WORKDIR /app

COPY package.json bun.lock tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/

RUN bun install --frozen-lockfile

COPY packages/shared/ packages/shared/
COPY packages/api/ packages/api/

RUN cd packages/shared && bun run build && cd ../api && bun run build

EXPOSE 3400

CMD ["bun", "packages/api/dist/index.js"]
```

**Step 2: Verify Docker build**

Run: `docker compose build api`
Expected: Build succeeds with oven/bun base image.

**Step 3: Commit**

```bash
git add packages/api/Dockerfile
git commit -m "chore: update Dockerfile to use Bun runtime"
```

---

### Task 16: Add CLI binary compilation

**Files:**
- Modify: `packages/cli/package.json`
- Modify: `package.json` (root)

**Step 1: Add build:bin script to CLI**

In `packages/cli/package.json`, add to scripts:
```json
"build:bin": "bun build ./src/index.ts --compile --outfile dist/ossgard"
```

**Step 2: Add convenience script to root**

In root `package.json`, add to scripts:
```json
"build:cli": "bun run --cwd packages/cli build:bin"
```

**Step 3: Build and verify the binary**

Run: `bun run build:cli`
Expected: Compiles standalone binary to `packages/cli/dist/ossgard`.

Run: `./packages/cli/dist/ossgard --help`
Expected: Prints CLI usage/help text.

**Step 4: Commit**

```bash
git add packages/cli/package.json package.json
git commit -m "feat: add CLI binary compilation via bun build --compile"
```

---

### Task 17: Update README.md

**Files:**
- Modify: `README.md`

**Step 1: Update prerequisites**

Replace:
```markdown
- Node.js >= 22
- pnpm
```
With:
```markdown
- [Bun](https://bun.sh) >= 1.0
```

**Step 2: Update install instructions**

Replace:
```bash
pnpm install
pnpm build
```
With:
```bash
bun install
bun run build
```

**Step 3: Update CLI execution commands**

Replace all `pnpm --filter cli exec ossgard` with the binary path or `bun run --cwd packages/cli`:
```bash
# Initialize config
bun run --cwd packages/cli start -- init

# Or build and use the binary directly:
bun run build:cli
./packages/cli/dist/ossgard init
./packages/cli/dist/ossgard up --detach
./packages/cli/dist/ossgard track facebook/react
./packages/cli/dist/ossgard scan facebook/react
./packages/cli/dist/ossgard dupes facebook/react
```

**Step 4: Update development section**

Replace:
```bash
pnpm dev          # Run API with hot reload (tsx watch)
pnpm test         # Run unit tests across all packages
pnpm test:e2e     # Run end-to-end tests (requires running stack)
```
With:
```bash
bun run dev       # Run API with hot reload
bun run test      # Run unit tests across all packages
bun run test:e2e  # Run end-to-end tests (requires running stack)
bun run build:cli # Compile standalone CLI binary
```

---

### Task 18: Update .gitignore and final cleanup

**Files:**
- Modify: `.gitignore`

**Step 1: Verify .gitignore**

The current `.gitignore` already ignores `dist/` which covers build output. The `bun.lock` file should NOT be in `.gitignore` (it needs to be committed). Verify this is the case:

Run: `grep "bun.lock" .gitignore`
Expected: No output (bun.lock is not ignored — good).

No changes needed to `.gitignore` unless the above check shows it's being ignored.

**Step 2: Final verification**

Run the complete build and test pipeline:

```bash
bun install
bun run build
bun run test
bun run build:cli
./packages/cli/dist/ossgard --help
```

Expected: All commands succeed.

**Step 3: Verify no pnpm/tsx references remain**

Run: `grep -rn "pnpm\|tsx" packages/ --include="*.json" --include="*.ts" | grep -v node_modules | grep -v ".d.ts" | grep -v dist/`
Expected: No matches (all pnpm and tsx references have been removed).

**Step 4: Commit**

```bash
git add README.md .gitignore
git commit -m "docs: update README and .gitignore for Bun migration"
```

---

### Task 19: Final full verification

**Step 1: Clean install**

Run: `rm -rf node_modules && bun install`
Expected: Clean install succeeds.

**Step 2: Full build**

Run: `bun run build`
Expected: All packages compile.

**Step 3: Full test suite**

Run: `bun run test`
Expected: All tests pass.

**Step 4: Docker build**

Run: `docker compose build api`
Expected: Docker image builds successfully.

**Step 5: CLI binary**

Run: `bun run build:cli && ./packages/cli/dist/ossgard --help`
Expected: Binary compiles and prints help.

**Step 6: Review all commits**

Run: `git log --oneline feat/bun-migration`
Expected: Clean commit history with one commit per migration step.
