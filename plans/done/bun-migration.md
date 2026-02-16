# Migrate ossgard from pnpm to Bun

## Context

We want to ship the CLI as a standalone binary and run the API as a daemon. Bun's `bun build --compile` makes this straightforward compared to Node.js SEA. This plan migrates the package manager and runtime from pnpm/Node to Bun, using a TDD approach: each step runs the existing test suite to verify no regressions before moving on.

**Decisions made:**
- Switch `better-sqlite3` to Bun's native `bun:sqlite`
- Switch `@hono/node-server` to `Bun.serve()`

## Steps

Each step ends with `bun run test` (or equivalent) to verify no regressions.

### Step 1: Swap package manager (pnpm → bun)

**Files:**
- `package.json` (root) — remove `pnpm` config block, update scripts:
  - `"build": "bun run --filter '*' build"`
  - `"test": "bun run --filter '*' test"`
  - `"dev": "bun run --cwd packages/api dev"`
  - `"test:e2e"` stays as-is (vitest directly)
- `packages/api/package.json` — update dev/start scripts:
  - `"dev": "bun --watch src/index.ts"`
  - `"start": "bun dist/index.js"`
- `packages/cli/package.json` — update dev/start scripts:
  - `"dev": "bun src/index.ts"`
  - `"start": "bun dist/index.js"`
- Delete `pnpm-lock.yaml`, `pnpm-workspace.yaml`
- Remove `tsx` from devDependencies in both api and cli packages (Bun runs TS natively)

**Verify:** `bun install && bun run build && bun run test`

### Step 2: Migrate better-sqlite3 to bun:sqlite

This is the most involved step. The API surfaces are similar but have key differences.

**API mapping (better-sqlite3 → bun:sqlite):**

| better-sqlite3 | bun:sqlite | Notes |
|----------------|------------|-------|
| `import BetterSqlite3 from "better-sqlite3"` | `import { Database } from "bun:sqlite"` | Named import |
| `new BetterSqlite3(path)` | `new Database(path, { strict: true })` | `strict: true` enables positional `?` without prefix requirement |
| `db.pragma("journal_mode = WAL")` | `db.run("PRAGMA journal_mode = WAL")` | No `.pragma()` method — use `.run()` |
| `db.pragma("foreign_keys = ON")` | `db.run("PRAGMA foreign_keys = ON")` | Same |
| `db.pragma("journal_mode")` (query) | `db.query("PRAGMA journal_mode").get()` | Returns object like `{ journal_mode: "wal" }` |
| `db.exec(SCHEMA)` | `db.run(SCHEMA)` | `run` is aliased as `exec` on Database class, handles multi-statement SQL |
| `db.prepare(sql).get(...)` returns `undefined` | `db.prepare(sql).get(...)` returns `null` | **Breaking change** — update all `=== undefined` checks to `=== null` or use falsy checks |
| `stmt.run(...)` returns `{ changes }` | `stmt.run(...)` returns `{ changes, lastInsertRowid }` | Compatible (superset) |
| `BetterSqlite3.Database` (type) | `Database` (from `bun:sqlite`) | Update type references |

**Files to modify:**

1. `packages/api/src/db/database.ts` — Main changes:
   - Change import from `better-sqlite3` to `bun:sqlite`
   - Replace `new BetterSqlite3(path)` with `new Database(path)`
   - Replace `.pragma()` calls with `.run("PRAGMA ...")`
   - Type of `raw` property changes to `Database` from `bun:sqlite`
   - All `.get()` call sites already use `as Type | undefined` — since bun:sqlite returns `null` instead of `undefined`, update the return checks (or add `?? undefined` if callers depend on `undefined`)

2. `packages/api/src/queue/local-job-queue.ts` — Change type reference:
   - Replace `import type BetterSqlite3 from "better-sqlite3"` with `import type { Database } from "bun:sqlite"`
   - Change `db: BetterSqlite3.Database` to `db: Database`
   - Same `.get()` null vs undefined consideration

3. `packages/api/package.json` — Remove dependencies:
   - Remove `better-sqlite3` from dependencies
   - Remove `@types/better-sqlite3` from devDependencies

4. Test files — Update pragma assertions:
   - `packages/api/tests/database.test.ts` — update `db.raw.pragma(...)` calls to `db.raw.query("PRAGMA ...").get()`

**Verify:** `bun run test` — all existing database and queue tests must pass

### Step 3: Switch API server from @hono/node-server to Bun.serve()

**Files:**
- `packages/api/src/index.ts` — replace:
  ```typescript
  // Remove: import { serve } from "@hono/node-server";
  // Replace the serve() call with:
  const server = Bun.serve({ fetch: app.fetch, port });
  console.log(`ossgard-api listening on http://localhost:${server.port}`);
  ctx.worker.start();
  ```
  Update shutdown handler to call `server.stop()`.
- `packages/api/package.json` — remove `@hono/node-server` from dependencies

**Verify:** `bun run test` (all existing API tests pass — they test route handlers via `app.request()`, not the server binding)

### Step 4: Update Dockerfile for Bun

**Files:**
- `packages/api/Dockerfile`:
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

**Verify:** `docker compose build api` succeeds

### Step 5: Add CLI binary compilation

**Files:**
- `packages/cli/package.json` — add build:bin script:
  - `"build:bin": "bun build ./src/index.ts --compile --outfile dist/ossgard"`
- Root `package.json` — add convenience script:
  - `"build:cli": "bun run --cwd packages/cli build:bin"`

**Verify:** `bun run build:cli && ./packages/cli/dist/ossgard --help` prints usage

### Step 6: Update README and .gitignore

**Files:**
- `README.md` — replace all pnpm references with bun equivalents, add binary compilation section
- `.gitignore` — add `bun.lock` if not auto-handled, ensure `dist/ossgard` binary isn't ignored

**Verify:** manual review

### Step 7: Final full verification

Run the complete test suite and build pipeline:
```
bun install
bun run build
bun run test
docker compose build api
bun run build:cli
./packages/cli/dist/ossgard --help
```
