# Periodic Scans & Scan History — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add periodic scanning (every 2h), scan history listing, TTL-based cleanup, and a demo UI that surfaces all scans per repo with per-scan detail pages and downloads.

**Architecture:** The API server gets an internal setInterval-based scheduler that triggers scans for all tracked repos/accounts, a TTL cleaner that prunes old scans, and new endpoints for listing scans and fetching dupes by scan ID. The demo stays static — the pull script fetches all scans as individual JSON files organized in repo subdirectories, and the barrel exports lightweight indexes plus full-data lookups.

**Tech Stack:** Bun, Hono (API), SQLite (better-sqlite3/bun:sqlite), Next.js 16 (demo), TypeScript

---

## Task 1: Add `listCompletedScans` DB method

**Files:**
- Modify: `packages/api/src/db/database.ts:568` (after `getLatestCompletedScan`)
- Test: `packages/api/tests/database.test.ts`

**Step 1: Write the failing test**

Add to `packages/api/tests/database.test.ts` inside a new `describe("scan history")` block at the end of the file (before the final closing `});`):

```typescript
describe("scan history", () => {
  let repoId: number;
  let accountId: number;

  beforeEach(() => {
    const account = db.createAccount("key-1", "test", {} as any);
    accountId = account.id;
    const repo = db.insertRepo("facebook", "react");
    repoId = repo.id;
  });

  it("listCompletedScans returns completed scans newest-first", () => {
    const s1 = db.createScan(repoId, accountId);
    db.updateScanStatus(s1.id, "done", { completedAt: "2026-02-20T00:00:00Z", prCount: 10, dupeGroupCount: 2 });

    const s2 = db.createScan(repoId, accountId);
    db.updateScanStatus(s2.id, "done", { completedAt: "2026-02-21T00:00:00Z", prCount: 15, dupeGroupCount: 3 });

    // One still running — should be excluded
    db.createScan(repoId, accountId);

    const scans = db.listCompletedScans(repoId, accountId);
    expect(scans).toHaveLength(2);
    expect(scans[0].id).toBe(s2.id); // newest first
    expect(scans[1].id).toBe(s1.id);
  });

  it("listCompletedScans returns empty array when no completed scans", () => {
    db.createScan(repoId, accountId); // queued, not done
    const scans = db.listCompletedScans(repoId, accountId);
    expect(scans).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/dhruv/Code/ossgard && bun test packages/api/tests/database.test.ts`
Expected: FAIL — `db.listCompletedScans is not a function`

**Step 3: Write minimal implementation**

Add to `packages/api/src/db/database.ts` after `getLatestCompletedScan` (after line 574):

```typescript
listCompletedScans(repoId: number, accountId: number): Scan[] {
  const stmt = this.raw.prepare(
    "SELECT * FROM scans WHERE repo_id = ? AND account_id = ? AND status = 'done' ORDER BY completed_at DESC"
  );
  const rows = stmt.all(repoId, accountId) as ScanRow[];
  return rows.map(mapScanRow);
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/dhruv/Code/ossgard && bun test packages/api/tests/database.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/api/src/db/database.ts packages/api/tests/database.test.ts
git commit -m "feat(api): add listCompletedScans DB method"
```

---

## Task 2: Add `deleteExpiredScans` DB method

**Files:**
- Modify: `packages/api/src/db/database.ts` (after `listCompletedScans`)
- Test: `packages/api/tests/database.test.ts`

**Step 1: Write the failing test**

Add inside the `describe("scan history")` block from Task 1:

```typescript
it("deleteExpiredScans removes scans older than cutoff", () => {
  const s1 = db.createScan(repoId, accountId);
  db.updateScanStatus(s1.id, "done", { completedAt: "2026-02-18T00:00:00Z", prCount: 10, dupeGroupCount: 2 });

  const s2 = db.createScan(repoId, accountId);
  db.updateScanStatus(s2.id, "done", { completedAt: "2026-02-22T00:00:00Z", prCount: 15, dupeGroupCount: 3 });

  // Add a dupe group to s1 to verify cascade
  db.insertDupeGroup(s1.id, repoId, "test group", 2);

  // Delete scans older than Feb 20
  const deleted = db.deleteExpiredScans("2026-02-20T00:00:00Z");
  expect(deleted).toBe(1);

  // s1 is gone, s2 remains
  expect(db.getScan(s1.id)).toBeNull();
  expect(db.getScan(s2.id)).not.toBeNull();

  // Dupe groups for s1 should be cascade-deleted
  expect(db.listDupeGroups(s1.id)).toHaveLength(0);
});

it("deleteExpiredScans skips non-done scans", () => {
  const s1 = db.createScan(repoId, accountId);
  // s1 is "queued" (not done), even though it's old by startedAt
  // It should NOT be deleted since it has no completedAt

  const deleted = db.deleteExpiredScans("2026-02-25T00:00:00Z");
  expect(deleted).toBe(0);
  expect(db.getScan(s1.id)).not.toBeNull();
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/dhruv/Code/ossgard && bun test packages/api/tests/database.test.ts`
Expected: FAIL — `db.deleteExpiredScans is not a function`

**Step 3: Write minimal implementation**

Add to `packages/api/src/db/database.ts` after `listCompletedScans`:

```typescript
deleteExpiredScans(olderThan: string): number {
  // Delete dupe_group_members first (FK constraint)
  this.raw.prepare(
    "DELETE FROM dupe_group_members WHERE group_id IN (SELECT id FROM dupe_groups WHERE scan_id IN (SELECT id FROM scans WHERE status = 'done' AND completed_at < ?))"
  ).run(olderThan);
  // Delete dupe_groups
  this.raw.prepare(
    "DELETE FROM dupe_groups WHERE scan_id IN (SELECT id FROM scans WHERE status = 'done' AND completed_at < ?)"
  ).run(olderThan);
  // Delete scans
  const result = this.raw.prepare(
    "DELETE FROM scans WHERE status = 'done' AND completed_at < ?"
  ).run(olderThan);
  return result.changes;
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/dhruv/Code/ossgard && bun test packages/api/tests/database.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/api/src/db/database.ts packages/api/tests/database.test.ts
git commit -m "feat(api): add deleteExpiredScans DB method for TTL cleanup"
```

---

## Task 3: Add `listAccounts` DB method

The scheduler needs to iterate over all accounts to trigger scans. Currently no such method exists.

**Files:**
- Modify: `packages/api/src/db/database.ts:218` (after `updateAccountConfig`)
- Test: `packages/api/tests/database.test.ts`

**Step 1: Write the failing test**

Add a new `describe("account listing")` block:

```typescript
describe("account listing", () => {
  it("listAccounts returns all accounts", () => {
    db.createAccount("key-1", "first", {} as any);
    db.createAccount("key-2", "second", {} as any);
    const accounts = db.listAccounts();
    expect(accounts).toHaveLength(2);
    expect(accounts[0].label).toBe("first");
    expect(accounts[1].label).toBe("second");
  });

  it("listAccounts returns empty array when no accounts", () => {
    const accounts = db.listAccounts();
    expect(accounts).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/dhruv/Code/ossgard && bun test packages/api/tests/database.test.ts`
Expected: FAIL — `db.listAccounts is not a function`

**Step 3: Write minimal implementation**

Add to `packages/api/src/db/database.ts` after `updateAccountConfig` (after line 218):

```typescript
listAccounts(): Account[] {
  const stmt = this.raw.prepare("SELECT * FROM accounts ORDER BY id");
  const rows = stmt.all() as AccountRow[];
  return rows.map(mapAccountRow);
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/dhruv/Code/ossgard && bun test packages/api/tests/database.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/api/src/db/database.ts packages/api/tests/database.test.ts
git commit -m "feat(api): add listAccounts DB method for scheduler"
```

---

## Task 4: Add `GET /repos/:owner/:name/scans` endpoint

**Files:**
- Modify: `packages/api/src/routes/scans.ts`
- Test: `packages/api/tests/scans.test.ts`

**Step 1: Write the failing test**

Add to `packages/api/tests/scans.test.ts` inside the top-level `describe("scans routes")`:

```typescript
describe("GET /repos/:owner/:name/scans", () => {
  it("returns completed scans for a repo", async () => {
    const repo = db.insertRepo("facebook", "react");
    const s1 = db.createScan(repo.id, account.id);
    db.updateScanStatus(s1.id, "done", {
      completedAt: "2026-02-20T00:00:00Z",
      prCount: 100,
      dupeGroupCount: 10,
    });
    const s2 = db.createScan(repo.id, account.id);
    db.updateScanStatus(s2.id, "done", {
      completedAt: "2026-02-21T00:00:00Z",
      prCount: 110,
      dupeGroupCount: 12,
    });

    const res = await app.request("/repos/facebook/react/scans", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.scans).toHaveLength(2);
    expect(body.scans[0].id).toBe(s2.id); // newest first
    expect(body.scans[0].prCount).toBe(110);
    expect(body.scans[1].id).toBe(s1.id);
  });

  it("returns 404 for untracked repo", async () => {
    const res = await app.request("/repos/nope/nada/scans", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(404);
  });

  it("returns empty array when no completed scans", async () => {
    db.insertRepo("facebook", "react");
    const res = await app.request("/repos/facebook/react/scans", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.scans).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/dhruv/Code/ossgard && bun test packages/api/tests/scans.test.ts`
Expected: FAIL — 404 (route not matched)

**Step 3: Write minimal implementation**

Add to `packages/api/src/routes/scans.ts` before the `export { scans }` line:

```typescript
scans.get("/repos/:owner/:name/scans", (c) => {
  const db = c.get("db");
  const account = c.get("account");
  const { owner, name } = c.req.param();

  const repo = db.getRepoByOwnerName(owner, name);
  if (!repo) {
    return c.json({ error: `${owner}/${name} is not tracked` }, 404);
  }

  const completedScans = db.listCompletedScans(repo.id, account.id);
  return c.json({
    scans: completedScans.map((s) => ({
      id: s.id,
      status: s.status,
      prCount: s.prCount,
      dupeGroupCount: s.dupeGroupCount,
      completedAt: s.completedAt,
    })),
  });
});
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/dhruv/Code/ossgard && bun test packages/api/tests/scans.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/api/src/routes/scans.ts packages/api/tests/scans.test.ts
git commit -m "feat(api): add GET /repos/:owner/:name/scans endpoint"
```

---

## Task 5: Add optional `scanId` query param to `GET /repos/:owner/:name/dupes`

**Files:**
- Modify: `packages/api/src/routes/dupes.ts:11-74`
- Test: `packages/api/tests/dupes.test.ts`

**Step 1: Write the failing test**

First, read `packages/api/tests/dupes.test.ts` to understand its setup. Add a test for the `scanId` query param:

```typescript
it("returns dupes for a specific scan when scanId is provided", async () => {
  // Setup: create repo, two completed scans with different groups
  const repo = db.insertRepo("facebook", "react");

  // Scan 1
  const s1 = db.createScan(repo.id, account.id);
  db.updateScanStatus(s1.id, "done", { completedAt: "2026-02-20T00:00:00Z", prCount: 10, dupeGroupCount: 1 });
  const pr1 = db.upsertPR({ repoId: repo.id, number: 1, title: "PR 1", body: null, author: "a", diffHash: null, filePaths: [], state: "open", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
  const pr2 = db.upsertPR({ repoId: repo.id, number: 2, title: "PR 2", body: null, author: "b", diffHash: null, filePaths: [], state: "open", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
  const g1 = db.insertDupeGroup(s1.id, repo.id, "old group", 2);
  db.insertDupeGroupMember(g1.id, pr1.id, 1, 90, "best");
  db.insertDupeGroupMember(g1.id, pr2.id, 2, 70, "dupe");

  // Scan 2 (latest)
  const s2 = db.createScan(repo.id, account.id);
  db.updateScanStatus(s2.id, "done", { completedAt: "2026-02-21T00:00:00Z", prCount: 10, dupeGroupCount: 1 });
  const g2 = db.insertDupeGroup(s2.id, repo.id, "new group", 2);
  db.insertDupeGroupMember(g2.id, pr1.id, 1, 95, "best");
  db.insertDupeGroupMember(g2.id, pr2.id, 2, 75, "dupe");

  // Request dupes for scan 1 specifically
  const res = await app.request(`/repos/facebook/react/dupes?scanId=${s1.id}`, {
    headers: AUTH_HEADER,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.scanId).toBe(s1.id);
  expect(body.groups[0].label).toBe("old group");
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/dhruv/Code/ossgard && bun test packages/api/tests/dupes.test.ts`
Expected: FAIL — scanId is the latest (s2), not s1

**Step 3: Write minimal implementation**

Modify `packages/api/src/routes/dupes.ts` lines 11-27. Replace the scan lookup logic:

```typescript
dupes.get("/repos/:owner/:name/dupes", (c) => {
  const db = c.get("db");
  const account = c.get("account");
  const { owner, name } = c.req.param();

  const repo = db.getRepoByOwnerName(owner, name);
  if (!repo) {
    return c.json({ error: `${owner}/${name} is not tracked` }, 404);
  }

  // Optional scanId query param — if provided, use that scan; otherwise use latest
  const scanIdParam = c.req.query("scanId");
  let scan;
  if (scanIdParam) {
    const scanId = Number(scanIdParam);
    if (Number.isNaN(scanId)) {
      return c.json({ error: "Invalid scanId" }, 400);
    }
    scan = db.getScan(scanId);
    if (!scan || scan.status !== "done") {
      return c.json({ error: `Scan ${scanId} not found or not completed` }, 404);
    }
  } else {
    scan = db.getLatestCompletedScan(repo.id, account.id);
    if (!scan) {
      return c.json(
        { error: `No completed scan found for ${owner}/${name}. Run 'ossgard scan ${owner}/${name}' first.` },
        404
      );
    }
  }

  // ... rest of the handler stays the same (lines 29-74)
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/dhruv/Code/ossgard && bun test packages/api/tests/dupes.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/api/src/routes/dupes.ts packages/api/tests/dupes.test.ts
git commit -m "feat(api): support optional scanId query param on /dupes endpoint"
```

---

## Task 6: Create the scheduler

**Files:**
- Create: `packages/api/src/scheduler.ts`
- Test: `packages/api/tests/scheduler.test.ts`

**Step 1: Write the failing test**

Create `packages/api/tests/scheduler.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "../src/db/database.js";
import { Scheduler } from "../src/scheduler.js";
import type { LocalJobQueue } from "../src/queue/local-job-queue.js";

describe("Scheduler", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("triggers scans for all tracked repos and accounts", async () => {
    const account = db.createAccount("key-1", "test", {} as any);
    const repo = db.insertRepo("facebook", "react");

    // Mock queue
    const enqueued: any[] = [];
    const mockQueue = {
      enqueue: async (opts: any) => {
        enqueued.push(opts);
        return "job-1";
      },
    } as unknown as LocalJobQueue;

    const scheduler = new Scheduler(db, mockQueue, { intervalMs: 60_000, ttlDays: 3 });
    await scheduler.tick();

    // Should have created a scan and enqueued a job
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].type).toBe("scan");
    expect(enqueued[0].payload.repoId).toBe(repo.id);
    expect(enqueued[0].payload.accountId).toBe(account.id);
  });

  it("skips repos with active scans", async () => {
    const account = db.createAccount("key-1", "test", {} as any);
    const repo = db.insertRepo("facebook", "react");
    db.createScan(repo.id, account.id); // active scan (queued)

    const enqueued: any[] = [];
    const mockQueue = {
      enqueue: async (opts: any) => { enqueued.push(opts); return "job-1"; },
    } as unknown as LocalJobQueue;

    const scheduler = new Scheduler(db, mockQueue, { intervalMs: 60_000, ttlDays: 3 });
    await scheduler.tick();

    expect(enqueued).toHaveLength(0);
  });

  it("cleans up expired scans", async () => {
    const account = db.createAccount("key-1", "test", {} as any);
    const repo = db.insertRepo("facebook", "react");

    // Old scan completed 5 days ago
    const oldScan = db.createScan(repo.id, account.id);
    db.updateScanStatus(oldScan.id, "done", {
      completedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      prCount: 10,
      dupeGroupCount: 2,
    });

    const mockQueue = {
      enqueue: async () => "job-1",
    } as unknown as LocalJobQueue;

    const scheduler = new Scheduler(db, mockQueue, { intervalMs: 60_000, ttlDays: 3 });
    await scheduler.tick();

    // Old scan should be cleaned up
    expect(db.getScan(oldScan.id)).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/dhruv/Code/ossgard && bun test packages/api/tests/scheduler.test.ts`
Expected: FAIL — cannot resolve `../src/scheduler.js`

**Step 3: Write minimal implementation**

Create `packages/api/src/scheduler.ts`:

```typescript
import type { Database } from "./db/database.js";
import type { LocalJobQueue } from "./queue/local-job-queue.js";
import { log } from "./logger.js";

const schedulerLog = log.child("scheduler");

export interface SchedulerOptions {
  intervalMs: number;
  ttlDays: number;
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private db: Database,
    private queue: LocalJobQueue,
    private opts: SchedulerOptions,
  ) {}

  start(): void {
    schedulerLog.info("Scheduler started", {
      intervalMs: this.opts.intervalMs,
      ttlDays: this.opts.ttlDays,
    });
    this.timer = setInterval(() => this.tick(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      schedulerLog.info("Scheduler stopped");
    }
  }

  async tick(): Promise<void> {
    schedulerLog.info("Scheduler tick — scanning all repos");

    const repos = this.db.listRepos();
    const accounts = this.db.listAccounts();

    let triggered = 0;
    for (const repo of repos) {
      for (const account of accounts) {
        const active = this.db.getActiveScan(repo.id, account.id);
        if (active) {
          schedulerLog.info("Skipping — active scan", {
            repo: `${repo.owner}/${repo.name}`,
            scanId: active.id,
          });
          continue;
        }

        const scan = this.db.createScan(repo.id, account.id);
        await this.queue.enqueue({
          type: "scan",
          payload: { scanId: scan.id, repoId: repo.id, accountId: account.id, full: false },
        });
        triggered++;
        schedulerLog.info("Triggered scan", {
          repo: `${repo.owner}/${repo.name}`,
          scanId: scan.id,
        });
      }
    }

    schedulerLog.info("Scheduler tick complete", { triggered });

    // TTL cleanup
    const cutoff = new Date(Date.now() - this.opts.ttlDays * 24 * 60 * 60 * 1000).toISOString();
    const cleaned = this.db.deleteExpiredScans(cutoff);
    if (cleaned > 0) {
      schedulerLog.info("Cleaned expired scans", { count: cleaned });
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/dhruv/Code/ossgard && bun test packages/api/tests/scheduler.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/api/src/scheduler.ts packages/api/tests/scheduler.test.ts
git commit -m "feat(api): add Scheduler for periodic scans and TTL cleanup"
```

---

## Task 7: Wire scheduler into server startup

**Files:**
- Modify: `packages/api/src/index.ts`

**Step 1: Write implementation**

Add to `packages/api/src/index.ts`:

1. Import at the top (after existing imports):
```typescript
import { Scheduler } from "./scheduler.js";
```

2. After `ctx.worker.start();` (line 53), add:
```typescript
// Start periodic scan scheduler (disable with SCAN_SCHEDULER_ENABLED=false)
const schedulerEnabled = process.env.SCAN_SCHEDULER_ENABLED !== "false";
let scheduler: Scheduler | null = null;
if (schedulerEnabled) {
  const intervalMs = Number(process.env.SCAN_INTERVAL_MS) || 7_200_000; // 2 hours
  const ttlDays = Number(process.env.SCAN_TTL_DAYS) || 3;
  scheduler = new Scheduler(db, ctx.queue, { intervalMs, ttlDays });
  scheduler.start();
}
```

3. In the `shutdown` function (before `db.close()`), add:
```typescript
scheduler?.stop();
```

**Step 2: Verify existing tests still pass**

Run: `cd /Users/dhruv/Code/ossgard && bun test packages/api/`
Expected: All tests PASS

**Step 3: Commit**

```bash
git add packages/api/src/index.ts
git commit -m "feat(api): wire scheduler into server startup"
```

---

## Task 8: Update demo types

**Files:**
- Modify: `demo/src/lib/types.ts`

**Step 1: Add new types**

Add to `demo/src/lib/types.ts` after the existing `RepoScanData` interface (after line 14):

```typescript
export interface ScanSummary {
  id: number;
  completedAt: string;
  prCount: number;
  dupeGroupCount: number;
}

export interface RepoScanIndex {
  repo: {
    owner: string;
    name: string;
    url: string;
  };
  scans: ScanSummary[];
}
```

No changes needed to `countDuplicatePrs` or `duplicatePercentage` — they still work with `RepoScanData`.

**Step 2: Verify build**

Run: `cd /Users/dhruv/Code/ossgard/demo && npx next build`
Expected: Build succeeds (types are additive, nothing broke)

**Step 3: Commit**

```bash
git add demo/src/lib/types.ts
git commit -m "feat(demo): add ScanSummary and RepoScanIndex types"
```

---

## Task 9: Rewrite pull-scan-data script for multi-scan support

**Files:**
- Modify: `demo/scripts/pull-scan-data.ts`

**Step 1: Rewrite the script**

Replace the contents of `demo/scripts/pull-scan-data.ts` with the following. Key changes:
- Fetches all completed scans per repo via `GET /repos/:owner/:name/scans`
- Fetches dupes for each scan via `GET /repos/:owner/:name/dupes?scanId=X`
- Writes one JSON file per scan in `data/{owner}-{repo}/scan-{id}.json`
- Skips already-downloaded scans (incremental)
- Removes local files for scans no longer on the server (TTL'd)
- Regenerates barrel `data/index.ts`

```typescript
#!/usr/bin/env npx tsx

/**
 * Pulls scan data for all tracked repos from a running ossgard-api server
 * and writes JSON files into demo/src/data/ for the static demo site.
 *
 * Each scan gets its own file: data/{owner}-{name}/scan-{id}.json
 *
 * Usage:
 *   npm run pull-data
 *   npm run pull-data -- --api-url http://localhost:3400 --api-key <key>
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import type { RepoScanData, RepoScanIndex, ScanSummary } from "../src/lib/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "src", "data");

// --- API response types (same as before) ---

interface ApiDupesMember {
  prId: number;
  prNumber: number;
  title: string;
  author: string;
  state: "open" | "closed" | "merged";
  rank: number;
  score: number;
  rationale: string | null;
}

interface ApiDupesGroup {
  groupId: number;
  label: string | null;
  prCount: number;
  members: ApiDupesMember[];
}

interface ApiDupesResponse {
  repo: string;
  scanId: number;
  completedAt: string;
  groupCount: number;
  groups: ApiDupesGroup[];
}

interface ApiScanSummary {
  id: number;
  status: string;
  prCount: number;
  dupeGroupCount: number;
  completedAt: string;
}

interface ApiRepo {
  id: number;
  owner: string;
  name: string;
  prCount: number;
  lastScanAt: string | null;
}

// --- Helpers ---

function readConfig(): { url: string | null; key: string | null } {
  const configPath = join(homedir(), ".ossgard", "config.toml");
  if (!existsSync(configPath)) return { url: null, key: null };

  const config = readFileSync(configPath, "utf-8");
  const urlMatch = config.match(/url\s*=\s*"([^"]+)"/);
  const keyMatch = config.match(/key\s*=\s*"([^"]+)"/);
  return { url: urlMatch?.[1] ?? null, key: keyMatch?.[1] ?? null };
}

function truncateLabel(label: string | null, maxLen = 80): string {
  if (!label || label.length <= maxLen) return label || "";
  const truncated = label.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 40 ? truncated.slice(0, lastSpace) : truncated) + "...";
}

function repoDir(owner: string, name: string): string {
  return join(DATA_DIR, `${owner}-${name}`);
}

function scanFilename(scanId: number): string {
  return `scan-${scanId}.json`;
}

// --- Parse args ---

const args = process.argv.slice(2);

function getFlag(flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

// --- Main ---

async function main() {
  const config = readConfig();
  const apiUrl = getFlag("--api-url") ?? config.url;
  const apiKey = getFlag("--api-key") ?? config.key;

  if (!apiUrl || !apiKey) {
    console.error(
      "Could not determine API URL/key. Provide --api-url and --api-key or ensure ~/.ossgard/config.toml exists."
    );
    process.exit(1);
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };

  // 1. Fetch all tracked repos
  console.log(`Fetching tracked repos from ${apiUrl}...`);
  const reposRes = await fetch(`${apiUrl}/repos`, { headers });
  if (!reposRes.ok) {
    console.error(`Failed to fetch repos: ${reposRes.status}`);
    process.exit(1);
  }

  const allRepos: ApiRepo[] = await reposRes.json();
  const repos = allRepos.filter((r) => r.lastScanAt !== null);

  if (repos.length === 0) {
    console.error("No repos with completed scans found.");
    process.exit(1);
  }

  console.log(`Found ${repos.length} repo(s) with scan data.\n`);

  // 2. Pull scan data for each repo
  const repoIndexes: RepoScanIndex[] = [];

  for (const repo of repos) {
    const { owner, name } = repo;
    console.log(`--- ${owner}/${name} ---`);

    // Fetch scan list
    const scansRes = await fetch(`${apiUrl}/repos/${owner}/${name}/scans`, { headers });
    if (!scansRes.ok) {
      console.error(`  Skipping — failed to fetch scans: ${scansRes.status}`);
      continue;
    }
    const { scans: apiScans }: { scans: ApiScanSummary[] } = await scansRes.json();

    if (apiScans.length === 0) {
      console.log("  No completed scans.\n");
      continue;
    }

    // Ensure repo directory exists
    const dir = repoDir(owner, name);
    mkdirSync(dir, { recursive: true });

    // Track which scan IDs are current (for cleanup)
    const currentScanIds = new Set(apiScans.map((s) => s.id));

    // Download each scan (skip if already exists)
    const scanSummaries: ScanSummary[] = [];
    let newScans = 0;

    for (const scanMeta of apiScans) {
      const filename = scanFilename(scanMeta.id);
      const filepath = join(dir, filename);

      scanSummaries.push({
        id: scanMeta.id,
        completedAt: scanMeta.completedAt,
        prCount: scanMeta.prCount,
        dupeGroupCount: scanMeta.dupeGroupCount,
      });

      if (existsSync(filepath)) {
        continue; // already downloaded
      }

      // Fetch full dupes for this scan
      const dupesRes = await fetch(
        `${apiUrl}/repos/${owner}/${name}/dupes?scanId=${scanMeta.id}`,
        { headers }
      );
      if (!dupesRes.ok) {
        console.error(`  Skipping scan ${scanMeta.id} — failed to fetch dupes: ${dupesRes.status}`);
        continue;
      }
      const dupesData: ApiDupesResponse = await dupesRes.json();

      const repoScanData: RepoScanData = {
        repo: { owner, name, url: `https://github.com/${owner}/${name}` },
        scan: {
          id: scanMeta.id,
          completedAt: scanMeta.completedAt,
          prCount: scanMeta.prCount,
          dupeGroupCount: scanMeta.dupeGroupCount,
        },
        groups: dupesData.groups.map((g) => ({
          id: g.groupId,
          label: truncateLabel(g.label),
          members: g.members.map((m) => ({
            prNumber: m.prNumber,
            title: m.title,
            author: m.author,
            state: m.state,
            rank: m.rank,
            score: m.score,
            rationale: m.rationale || "",
            url: `https://github.com/${owner}/${name}/pull/${m.prNumber}`,
          })),
        })),
      };

      writeFileSync(filepath, JSON.stringify(repoScanData, null, 2) + "\n");
      newScans++;
    }

    // Cleanup: remove scan files that are no longer on the server (TTL'd)
    if (existsSync(dir)) {
      const existing = readdirSync(dir).filter((f) => f.startsWith("scan-") && f.endsWith(".json"));
      for (const file of existing) {
        const match = file.match(/^scan-(\d+)\.json$/);
        if (match && !currentScanIds.has(Number(match[1]))) {
          rmSync(join(dir, file));
          console.log(`  Removed expired: ${file}`);
        }
      }
    }

    repoIndexes.push({
      repo: { owner, name, url: `https://github.com/${owner}/${name}` },
      scans: scanSummaries,
    });

    console.log(`  ${apiScans.length} scan(s) (${newScans} new)\n`);
  }

  // 3. Generate barrel file
  generateBarrel(repoIndexes);

  console.log(`Done. ${repoIndexes.length} repo(s) processed. Run \`npm run build\` in demo/ to rebuild.`);
}

function generateBarrel(indexes: RepoScanIndex[]) {
  const lines: string[] = [
    `import type { RepoScanData, RepoScanIndex } from "@/lib/types";`,
    ``,
  ];

  // Static imports for all scan files
  const scanImports: Map<string, string[]> = new Map(); // repoKey -> [importName, ...]
  for (const idx of indexes) {
    const { owner, name } = idx.repo;
    const dirName = `${owner}-${name}`;
    const importNames: string[] = [];

    for (const scan of idx.scans) {
      const importName = `${owner}${name.charAt(0).toUpperCase() + name.slice(1)}Scan${scan.id}`;
      lines.push(`import ${importName} from "./${dirName}/${scanFilename(scan.id)}";`);
      importNames.push(importName);
    }

    scanImports.set(`${owner}/${name}`, importNames);
  }

  lines.push(``);

  // Export scan lookup map
  lines.push(`const scanMap: Record<string, Record<number, RepoScanData>> = {`);
  for (const idx of indexes) {
    const { owner, name } = idx.repo;
    const key = `${owner}/${name}`;
    const importNames = scanImports.get(key) ?? [];
    lines.push(`  "${key}": {`);
    for (let i = 0; i < idx.scans.length; i++) {
      lines.push(`    ${idx.scans[i].id}: ${importNames[i]} as RepoScanData,`);
    }
    lines.push(`  },`);
  }
  lines.push(`};`);
  lines.push(``);

  // Export repo indexes
  lines.push(`export const repos: RepoScanIndex[] = ${JSON.stringify(indexes, null, 2)};`);
  lines.push(``);

  // Export helpers
  lines.push(`export function getRepoData(owner: string, name: string): RepoScanIndex | undefined {`);
  lines.push(`  return repos.find((r) => r.repo.owner === owner && r.repo.name === name);`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`export function getScanData(owner: string, name: string, scanId: number): RepoScanData | undefined {`);
  lines.push(`  return scanMap[\`\${owner}/\${name}\`]?.[scanId];`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`export function getLatestScan(owner: string, name: string): RepoScanData | undefined {`);
  lines.push(`  const repo = getRepoData(owner, name);`);
  lines.push(`  if (!repo || repo.scans.length === 0) return undefined;`);
  lines.push(`  return getScanData(owner, name, repo.scans[0].id);`);
  lines.push(`}`);
  lines.push(``);

  function scanFilename(id: number) { return `scan-${id}.json`; }

  writeFileSync(join(DATA_DIR, "index.ts"), lines.join("\n"));
  console.log("  Regenerated barrel: src/data/index.ts");
}

main();
```

**Step 2: Verify script compiles**

Run: `cd /Users/dhruv/Code/ossgard/demo && npx tsc --noEmit scripts/pull-scan-data.ts` (or just verify no syntax errors)
Note: This script can only be fully tested with a running API server, so manual smoke test is appropriate.

**Step 3: Commit**

```bash
git add demo/scripts/pull-scan-data.ts
git commit -m "feat(demo): rewrite pull-scan-data for multi-scan support"
```

---

## Task 10: Update repo detail page with scan history

**Files:**
- Modify: `demo/src/app/[owner]/[repo]/page.tsx`

**Step 1: Update the page**

Update `demo/src/app/[owner]/[repo]/page.tsx` to:
- Import from the new barrel (`getRepoData`, `getLatestScan`, `repos`)
- Show latest scan results (stats bar + carousel) as before
- Add a scan history list below the stats bar
- Each scan entry links to `/owner/repo/scan/scanId`

```typescript
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Github, Clock } from "lucide-react";
import { repos, getRepoData, getLatestScan } from "@/data";
import { StatsBar } from "@/components/stats-bar";
import { ReviewCarousel } from "@/components/review-carousel";
import { DownloadButton } from "@/components/download-button";

export function generateStaticParams() {
  return repos.map((r) => ({
    owner: r.repo.owner,
    repo: r.repo.name,
  }));
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function RepoPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string }>;
}) {
  const { owner, repo } = await params;
  const repoIndex = getRepoData(owner, repo);
  if (!repoIndex) notFound();

  const latestScan = getLatestScan(owner, repo);
  if (!latestScan) notFound();

  return (
    <main className="min-h-svh px-6 py-12 sm:px-8">
      <div className="mx-auto max-w-5xl">
        {/* Header */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="inline-flex items-center justify-center rounded-sm border border-border p-2 text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Back to home"
            >
              <ArrowLeft className="size-4" />
            </Link>
            <h1 className="font-mono text-xl font-bold tracking-tight text-foreground sm:text-2xl">
              {owner}/{repo}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <DownloadButton data={latestScan} />
            <a
              href={repoIndex.repo.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-sm border border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`View ${owner}/${repo} on GitHub`}
            >
              <Github className="size-4" />
              <span className="hidden sm:inline">GitHub</span>
            </a>
          </div>
        </div>

        {/* Stats Bar */}
        <div className="mt-8">
          <StatsBar data={latestScan} />
        </div>

        {/* Scan History */}
        {repoIndex.scans.length > 1 && (
          <div className="mt-6">
            <h2 className="flex items-center gap-2 text-sm font-medium uppercase tracking-wider text-muted-foreground">
              <Clock className="size-3.5" />
              Scan History
            </h2>
            <div className="mt-3 space-y-1">
              {repoIndex.scans.map((scan, i) => (
                <Link
                  key={scan.id}
                  href={i === 0 ? `/${owner}/${repo}` : `/${owner}/${repo}/scan/${scan.id}`}
                  className={`flex items-center justify-between rounded-sm border px-4 py-2.5 text-sm transition-colors ${
                    i === 0
                      ? "border-primary/30 bg-primary/5 text-foreground"
                      : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className="font-mono">{formatDate(scan.completedAt)}</span>
                    {i === 0 && (
                      <span className="rounded-sm bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
                        Latest
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-4 font-mono text-xs">
                    <span>{scan.prCount} PRs</span>
                    <span>{scan.dupeGroupCount} groups</span>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Review Carousel */}
        <ReviewCarousel groups={latestScan.groups} />
      </div>
    </main>
  );
}
```

**Step 2: Verify build**

Run: `cd /Users/dhruv/Code/ossgard/demo && npx next build`
Note: Build may fail until the barrel is regenerated with actual data. This is expected — the barrel will be regenerated by the pull script. For now, verify there are no TypeScript errors: `cd /Users/dhruv/Code/ossgard/demo && npx tsc --noEmit`

**Step 3: Commit**

```bash
git add demo/src/app/\\[owner\\]/\\[repo\\]/page.tsx
git commit -m "feat(demo): add scan history list to repo detail page"
```

---

## Task 11: Create scan detail page

**Files:**
- Create: `demo/src/app/[owner]/[repo]/scan/[scanId]/page.tsx`

**Step 1: Create the page**

Create `demo/src/app/[owner]/[repo]/scan/[scanId]/page.tsx`:

```typescript
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { repos, getRepoData, getScanData } from "@/data";
import { StatsBar } from "@/components/stats-bar";
import { ReviewCarousel } from "@/components/review-carousel";
import { DownloadButton } from "@/components/download-button";

export function generateStaticParams() {
  const params: { owner: string; repo: string; scanId: string }[] = [];
  for (const r of repos) {
    // Skip the first scan (it's shown on the main repo page)
    for (const scan of r.scans.slice(1)) {
      params.push({
        owner: r.repo.owner,
        repo: r.repo.name,
        scanId: String(scan.id),
      });
    }
  }
  return params;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function ScanDetailPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string; scanId: string }>;
}) {
  const { owner, repo, scanId: scanIdStr } = await params;
  const scanId = Number(scanIdStr);

  const repoIndex = getRepoData(owner, repo);
  if (!repoIndex) notFound();

  const data = getScanData(owner, repo, scanId);
  if (!data) notFound();

  return (
    <main className="min-h-svh px-6 py-12 sm:px-8">
      <div className="mx-auto max-w-5xl">
        {/* Header */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Link
              href={`/${owner}/${repo}`}
              className="inline-flex items-center justify-center rounded-sm border border-border p-2 text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Back to ${owner}/${repo}`}
            >
              <ArrowLeft className="size-4" />
            </Link>
            <div>
              <h1 className="font-mono text-xl font-bold tracking-tight text-foreground sm:text-2xl">
                {owner}/{repo}
              </h1>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Scan from {formatDate(data.scan.completedAt)}
              </p>
            </div>
          </div>
          <DownloadButton data={data} />
        </div>

        {/* Stats Bar */}
        <div className="mt-8">
          <StatsBar data={data} />
        </div>

        {/* Review Carousel */}
        <ReviewCarousel groups={data.groups} />
      </div>
    </main>
  );
}
```

**Step 2: Verify no TypeScript errors**

Run: `cd /Users/dhruv/Code/ossgard/demo && npx tsc --noEmit`
Expected: No errors (same note as Task 10 — barrel needs real data for full build)

**Step 3: Commit**

```bash
git add demo/src/app/\\[owner\\]/\\[repo\\]/scan/\\[scanId\\]/page.tsx
git commit -m "feat(demo): add scan detail page with download"
```

---

## Task 12: Update home page and repo card

**Files:**
- Modify: `demo/src/app/page.tsx`
- Modify: `demo/src/components/repo-card.tsx`

**Step 1: Update repo-card to use RepoScanIndex**

Update `demo/src/components/repo-card.tsx` to accept `RepoScanIndex` and show latest scan info:

```typescript
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { RepoScanIndex } from "@/lib/types";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function RepoCard({ data }: { data: RepoScanIndex }) {
  const { owner, name } = data.repo;
  const latest = data.scans[0];
  if (!latest) return null;

  return (
    <Link
      href={`/${owner}/${name}`}
      className="group block rounded-sm border border-border bg-card p-5 transition-colors hover:border-primary/40 hover:bg-card/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <h3 className="font-mono text-base font-semibold text-foreground transition-colors group-hover:text-primary">
        {owner}/{name}
      </h3>

      <p className="mt-3 text-sm text-muted-foreground">
        Last scanned {timeAgo(latest.completedAt)}
      </p>

      <div className="mt-4 flex items-center gap-4 font-mono text-sm">
        <span>
          <span className="font-medium text-primary">{latest.dupeGroupCount}</span>{" "}
          <span className="text-muted-foreground">groups</span>
        </span>
        <span>
          <span className="font-medium text-foreground">{latest.prCount}</span>{" "}
          <span className="text-muted-foreground">PRs</span>
        </span>
        {data.scans.length > 1 && (
          <span className="text-muted-foreground">
            {data.scans.length} scans
          </span>
        )}
      </div>

      <div className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
        <span>View details</span>
        <ArrowRight className="size-3" />
      </div>
    </Link>
  );
}
```

**Step 2: Verify no TypeScript errors**

Run: `cd /Users/dhruv/Code/ossgard/demo && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add demo/src/app/page.tsx demo/src/components/repo-card.tsx
git commit -m "feat(demo): update repo card for scan history index"
```

---

## Task 13: Run all API tests

**Files:** None (verification only)

**Step 1: Run full test suite**

Run: `cd /Users/dhruv/Code/ossgard && bun test packages/api/`
Expected: All tests PASS

**Step 2: If any failures, fix them before proceeding**

Check for import errors, type mismatches, etc.

**Step 3: Commit any fixes**

---

## Task 14: Manual integration test

**Step 1: Build the demo**

Temporarily create a minimal barrel that compiles:

```bash
cd /Users/dhruv/Code/ossgard/demo
# If barrel is broken due to missing scan files, create a minimal valid one
npx next build
```

**Step 2: If the API server is available, test the pull script**

```bash
cd /Users/dhruv/Code/ossgard/demo
npm run pull-data
npx next build
```

**Step 3: Verify the scan history UI**

Start the dev server and navigate to a repo page to confirm:
- Stats bar shows latest scan data
- Scan history list appears with all scans
- Clicking an older scan navigates to `/owner/repo/scan/id`
- Download buttons work on both latest and individual scan pages

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | `listCompletedScans` DB method | `database.ts`, `database.test.ts` |
| 2 | `deleteExpiredScans` DB method | `database.ts`, `database.test.ts` |
| 3 | `listAccounts` DB method | `database.ts`, `database.test.ts` |
| 4 | `GET /repos/:owner/:name/scans` endpoint | `scans.ts`, `scans.test.ts` |
| 5 | `scanId` query param on `/dupes` | `dupes.ts`, `dupes.test.ts` |
| 6 | Scheduler class | `scheduler.ts`, `scheduler.test.ts` |
| 7 | Wire scheduler into server | `index.ts` |
| 8 | Demo types | `types.ts` |
| 9 | Pull script rewrite | `pull-scan-data.ts` |
| 10 | Repo detail page + scan history | `[owner]/[repo]/page.tsx` |
| 11 | Scan detail page | `[owner]/[repo]/scan/[scanId]/page.tsx` |
| 12 | Home page + repo card | `page.tsx`, `repo-card.tsx` |
| 13 | Run all API tests | (verification) |
| 14 | Manual integration test | (verification) |
