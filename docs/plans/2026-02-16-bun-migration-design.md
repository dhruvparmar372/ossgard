# Bun Migration Execution Plan

## Context

Migrate ossgard from pnpm/Node.js to Bun runtime. Motivations:
- Standalone CLI binary via `bun build --compile`
- Native SQLite via `bun:sqlite` (no native C++ addon)
- Simplified server via `Bun.serve()`
- Native TypeScript execution (no tsx needed)

**Decisions:**
- Replace `better-sqlite3` with `bun:sqlite`
- Replace `@hono/node-server` with `Bun.serve()`
- Replace `vitest` with `bun:test`
- Keep `hono` (Bun is a first-class Hono target)

## Git Strategy

- **Branch:** `feat/bun-migration` off `main`
- **Commits:** One atomic commit per step, each verified with passing tests
- **Rollback:** Each commit is independently revertable

## Step Overview

| # | Step | Risk | Files |
|---|------|------|-------|
| 0 | Dependency compatibility audit | None | 0 |
| 1 | Swap package manager (pnpm→bun) | Low | 5 + delete 2 |
| 2 | Migrate better-sqlite3 → bun:sqlite | **High** | 4 |
| 3 | Switch @hono/node-server → Bun.serve() | Medium | 2 |
| 4 | Migrate vitest → bun:test | **High** | ~20 |
| 5 | Update Dockerfile | Low | 1 |
| 6 | Add CLI binary compilation | Low | 2 |
| 7 | Update README, .gitignore, cleanup | Low | 3 |

---

## Step 0: Dependency Compatibility Audit

Verify all dependencies work under Bun runtime before touching code.

| Package | Type | Status |
|---------|------|--------|
| `hono` | Pure JS/TS | OK — Bun is first-class target |
| `@qdrant/js-client-rest` | HTTP client (fetch) | OK — Bun has native fetch |
| `@iarna/toml` | Pure JS | OK |
| `commander` | Pure JS | OK |
| `uuid` | Pure JS | OK |
| `zod` | Pure JS | OK |
| `better-sqlite3` | Native C++ addon | INCOMPATIBLE — replaced in Step 2 |
| `@hono/node-server` | Node-specific | INCOMPATIBLE — replaced in Step 3 |
| `vitest` | Test framework | Works under Bun, replaced in Step 4 |
| `tsx` | TS runner | Unnecessary — removed in Step 1 |
| `esbuild` | Only in pnpm config | Verify not used elsewhere, then remove reference |

**Action:** After Step 1, run `bun install` to confirm no unexpected failures on pure-JS deps.

---

## Step 1: Swap Package Manager (pnpm → bun)

### Files to modify

**`package.json` (root):**
- Add `"workspaces": ["packages/*"]` (Bun reads this instead of pnpm-workspace.yaml)
- Remove `pnpm.onlyBuiltDependencies` block
- Update scripts:
  ```json
  "build": "bun run --filter '*' build",
  "test": "bun run --filter '*' test",
  "dev": "bun run --cwd packages/api dev"
  ```
- Keep `test:e2e` pointing to vitest for now (migrated in Step 4)

**`packages/api/package.json`:**
- Update scripts:
  ```json
  "dev": "bun --watch src/index.ts",
  "start": "bun dist/index.js"
  ```
- Remove `tsx` from devDependencies

**`packages/cli/package.json`:**
- Update scripts:
  ```json
  "dev": "bun src/index.ts",
  "start": "bun dist/index.js"
  ```
- Remove `tsx` from devDependencies

**`packages/shared/package.json`:**
- `"dev": "tsc --watch"` — unchanged (pure TS compilation)

### Files to delete
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`

### Verify
```bash
bun install && bun run build && bun run test
```

Tests still run via vitest at this point (bun invokes each package's test script which uses vitest). Vitest works under Bun runtime.

---

## Step 2: Migrate better-sqlite3 → bun:sqlite

Highest-risk step. Every database interaction changes.

### API Mapping

| better-sqlite3 | bun:sqlite | Notes |
|----------------|------------|-------|
| `import BetterSqlite3 from "better-sqlite3"` | `import { Database } from "bun:sqlite"` | Named import |
| `new BetterSqlite3(path)` | `new Database(path, { strict: true })` | `strict: true` for positional `?` params |
| `db.pragma("journal_mode = WAL")` | `db.run("PRAGMA journal_mode = WAL")` | No `.pragma()` method |
| `db.pragma("foreign_keys = ON")` | `db.run("PRAGMA foreign_keys = ON")` | Use `.run()` |
| `db.pragma("journal_mode")` (query) | `db.query("PRAGMA journal_mode").get()` | Returns `{ journal_mode: "wal" }` |
| `db.exec(SCHEMA)` | `db.run(SCHEMA)` | `run` handles multi-statement SQL |
| `stmt.get(...)` returns `undefined` | `stmt.get(...)` returns `null` | Update all checks |
| `stmt.run(...)` returns `{ changes }` | `stmt.run(...)` returns `{ changes, lastInsertRowid }` | Compatible superset |
| `BetterSqlite3.Database` (type) | `Database` from `bun:sqlite` | Update type refs |

### Files

**1. `packages/api/src/db/database.ts`:**
- Change import to `import { Database as BunDatabase } from "bun:sqlite"`
- Replace `new BetterSqlite3(path)` → `new BunDatabase(path, { strict: true })`
- Replace `.pragma()` calls → `.run("PRAGMA ...")`
- Update raw property type to `BunDatabase`
- Change all `.get()` return type annotations from `Type | undefined` to `Type | null`
- Update all `=== undefined` checks to `=== null`

**2. `packages/api/src/queue/local-job-queue.ts`:**
- Change `import type BetterSqlite3 from "better-sqlite3"` → `import type { Database } from "bun:sqlite"`
- Change `db: BetterSqlite3.Database` → `db: Database`
- Update `.get()` null checks

**3. `packages/api/package.json`:**
- Remove `better-sqlite3` from dependencies
- Remove `@types/better-sqlite3` from devDependencies

**4. `packages/api/tests/database.test.ts`:**
- Replace `db.raw.pragma("journal_mode")` → `db.raw.query("PRAGMA journal_mode").get()`
- Update assertion: result is `{ journal_mode: "wal" }` not `"wal"`
- Replace `db.raw.pragma("foreign_keys")` similarly

### Verify
```bash
bun run test
```
All database, queue, and API tests must pass.

---

## Step 3: Switch @hono/node-server → Bun.serve()

### Files

**1. `packages/api/src/index.ts`:**
```typescript
// Remove: import { serve } from "@hono/node-server"
// Replace serve() call:
const server = Bun.serve({ fetch: app.fetch, port });
console.log(`ossgard-api listening on http://localhost:${server.port}`);
ctx.worker.start();

// Shutdown handler: replace server.close() with server.stop()
```

**2. `packages/api/package.json`:**
- Remove `@hono/node-server` from dependencies

### Verify
```bash
bun run test
```
Existing API tests use `app.request()`, not the server binding — should pass unchanged.

Manual smoke test:
```bash
bun run dev
curl http://localhost:3400/health
```

---

## Step 4: Migrate vitest → bun:test

Second highest-risk step due to file count.

### API Mapping

| vitest | bun:test | Notes |
|--------|----------|-------|
| `import { describe, it, expect, ... } from "vitest"` | Remove import (globals auto-available) | Or `import from "bun:test"` |
| `vi.fn()` | `mock(() => {})` from `bun:test` | Or use global `vi.fn()` compat |
| `vi.fn().mockReturnValue(x)` | `mock(() => x)` | Pass implementation directly |
| `vi.fn().mockResolvedValue(x)` | `mock(() => Promise.resolve(x))` | |
| `vi.fn().mockImplementation(fn)` | `mock(fn)` | |
| `vi.spyOn(obj, "method")` | `spyOn(obj, "method")` from `bun:test` | Same API |
| `vi.mocked(fn)` | Not needed — mocks are already typed | |
| `vi.mock("module")` | `mock.module("module", () => ...)` | Different API |
| `vitest run` | `bun test` | CLI |
| `vitest.config.ts` | Not needed (or `bunfig.toml`) | |

**Note:** Bun provides global `vi.fn()` and `vi.spyOn()` for Vitest compatibility. Many test files may need minimal changes — primarily removing vitest imports.

### Files to modify

**All test files (~20 across packages/api, packages/cli, e2e):**
- Remove `import { ... } from "vitest"` lines
- Replace `vi.fn()` with `mock()` from `bun:test` (or keep `vi.fn()` via compat globals)
- Replace `vi.mocked()` calls if any
- Replace `vi.mock("module")` with `mock.module()` if any

**Config files to delete:**
- `packages/api/vitest.config.ts`
- `packages/cli/vitest.config.ts` (if exists)
- `e2e/vitest.config.ts`

**Package files to update:**
- Root `package.json`: Remove vitest from devDependencies
- Each package `package.json`: Update `"test": "bun test"`
- Root `package.json`: Update `"test:e2e": "bun test e2e/"`

### Verify
```bash
bun test        # unit tests
bun test e2e/   # e2e tests
```

---

## Step 5: Update Dockerfile

**`packages/api/Dockerfile`:**
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

### Verify
```bash
docker compose build api
```

---

## Step 6: Add CLI Binary Compilation

**`packages/cli/package.json`:**
```json
"build:bin": "bun build ./src/index.ts --compile --outfile dist/ossgard"
```

**Root `package.json`:**
```json
"build:cli": "bun run --cwd packages/cli build:bin"
```

### Verify
```bash
bun run build:cli && ./packages/cli/dist/ossgard --help
```

---

## Step 7: Update README, .gitignore, Cleanup

**`README.md`:**
- Replace all `pnpm` references with `bun` equivalents
- Add binary compilation section
- Update prerequisites (Bun instead of Node.js + pnpm)

**`.gitignore`:**
- Ensure `bun.lock` is NOT ignored (should be committed)
- Verify `dist/ossgard` binary handling

**Cleanup:**
- Remove any remaining pnpm references from root `package.json`
- Verify no `tsx` references remain anywhere

### Final Full Verification
```bash
bun install
bun run build
bun test
docker compose build api
bun run build:cli
./packages/cli/dist/ossgard --help
```
