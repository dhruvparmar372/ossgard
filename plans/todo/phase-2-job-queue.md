# Phase 2: Async Job Queue System

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the SQLite-backed job queue and in-process worker loop that powers all background operations. This is the backbone for the entire scan pipeline.

**Architecture:** Jobs are rows in SQLite. A worker loop in the API process polls for runnable jobs and dispatches them to registered processors. Each processor handles one job type (ingest, embed, etc.). The `JobQueue` interface is swappable for Cloudflare Queues later.

**Tech Stack:** better-sqlite3, uuid, Vitest

**Depends on:** Phase 1 (database layer)

---

### Task 1: Implement JobQueue interface and LocalJobQueue

**Files:**
- Create: `packages/api/src/queue/types.ts`
- Create: `packages/api/src/queue/local-job-queue.ts`
- Test: `packages/api/src/queue/local-job-queue.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/api/src/queue/local-job-queue.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "../db/database.js";
import { LocalJobQueue } from "./local-job-queue.js";

describe("LocalJobQueue", () => {
  let db: Database;
  let queue: LocalJobQueue;

  beforeEach(() => {
    db = new Database(":memory:");
    queue = new LocalJobQueue(db);
  });

  afterEach(() => {
    db.close();
  });

  it("enqueues a job and returns an ID", async () => {
    const id = await queue.enqueue({ type: "scan", payload: { repoId: 1 } });
    expect(id).toBeDefined();
    expect(typeof id).toBe("string");
  });

  it("gets job status after enqueue", async () => {
    const id = await queue.enqueue({ type: "scan", payload: { repoId: 1 } });
    const status = await queue.getStatus(id);
    expect(status).toBeDefined();
    expect(status!.status).toBe("queued");
    expect(status!.type).toBe("scan");
  });

  it("dequeues the oldest queued job", async () => {
    await queue.enqueue({ type: "ingest", payload: { repoId: 1 } });
    await queue.enqueue({ type: "embed", payload: { repoId: 1 } });

    const job = await queue.dequeue();
    expect(job).toBeDefined();
    expect(job!.type).toBe("ingest");
    expect(job!.status).toBe("running");
  });

  it("returns null when no jobs available", async () => {
    const job = await queue.dequeue();
    expect(job).toBeNull();
  });

  it("does not dequeue jobs with future run_after", async () => {
    const futureDate = new Date(Date.now() + 60000).toISOString();
    await queue.enqueue({
      type: "scan",
      payload: { repoId: 1 },
      runAfter: futureDate,
    });
    const job = await queue.dequeue();
    expect(job).toBeNull();
  });

  it("completes a job", async () => {
    const id = await queue.enqueue({ type: "scan", payload: { repoId: 1 } });
    await queue.dequeue(); // marks as running
    await queue.complete(id, { groups: 5 });

    const status = await queue.getStatus(id);
    expect(status!.status).toBe("done");
    expect(status!.result).toEqual({ groups: 5 });
  });

  it("fails a job", async () => {
    const id = await queue.enqueue({ type: "scan", payload: { repoId: 1 } });
    await queue.dequeue();
    await queue.fail(id, "GitHub API error");

    const status = await queue.getStatus(id);
    expect(status!.status).toBe("failed");
    expect(status!.error).toBe("GitHub API error");
  });

  it("pauses a job with a run_after time", async () => {
    const id = await queue.enqueue({ type: "ingest", payload: { repoId: 1 } });
    await queue.dequeue();
    const resumeAt = new Date(Date.now() + 30000);
    await queue.pause(id, resumeAt);

    const status = await queue.getStatus(id);
    expect(status!.status).toBe("queued");
    expect(status!.runAfter).toBeDefined();
  });

  it("increments attempts on dequeue", async () => {
    const id = await queue.enqueue({ type: "scan", payload: { repoId: 1 } });
    await queue.dequeue();
    const status = await queue.getStatus(id);
    expect(status!.attempts).toBe(1);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @ossgard/api test -- src/queue
```
Expected: FAIL — modules don't exist

**Step 3: Create queue types**

```typescript
// packages/api/src/queue/types.ts
import type { Job, JobType, JobStatus } from "@ossgard/shared";

export interface EnqueueOptions {
  type: JobType | string;
  payload: Record<string, unknown>;
  maxRetries?: number;
  runAfter?: string; // ISO timestamp
}

export interface JobQueue {
  enqueue(opts: EnqueueOptions): Promise<string>;
  getStatus(jobId: string): Promise<Job | null>;
  dequeue(): Promise<Job | null>;
  complete(jobId: string, result?: Record<string, unknown>): Promise<void>;
  fail(jobId: string, error: string): Promise<void>;
  pause(jobId: string, runAfter: Date): Promise<void>;
}
```

**Step 4: Implement LocalJobQueue**

```typescript
// packages/api/src/queue/local-job-queue.ts
import { randomUUID } from "crypto";
import type { Job } from "@ossgard/shared";
import type { Database } from "../db/database.js";
import type { EnqueueOptions, JobQueue } from "./types.js";

export class LocalJobQueue implements JobQueue {
  constructor(private db: Database) {}

  async enqueue(opts: EnqueueOptions): Promise<string> {
    const id = randomUUID();
    this.db.raw
      .prepare(
        `INSERT INTO jobs (id, type, payload, max_retries, run_after)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        id,
        opts.type,
        JSON.stringify(opts.payload),
        opts.maxRetries ?? 3,
        opts.runAfter ?? null
      );
    return id;
  }

  async getStatus(jobId: string): Promise<Job | null> {
    const row = this.db.raw
      .prepare("SELECT * FROM jobs WHERE id = ?")
      .get(jobId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToJob(row);
  }

  async dequeue(): Promise<Job | null> {
    const now = new Date().toISOString();
    // Atomically find and claim the oldest runnable job
    const row = this.db.raw
      .prepare(
        `UPDATE jobs
         SET status = 'running', attempts = attempts + 1, updated_at = datetime('now')
         WHERE id = (
           SELECT id FROM jobs
           WHERE status = 'queued'
             AND (run_after IS NULL OR run_after <= ?)
           ORDER BY created_at ASC
           LIMIT 1
         )
         RETURNING *`
      )
      .get(now) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToJob(row);
  }

  async complete(jobId: string, result?: Record<string, unknown>): Promise<void> {
    this.db.raw
      .prepare(
        `UPDATE jobs SET status = 'done', result = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(result ? JSON.stringify(result) : null, jobId);
  }

  async fail(jobId: string, error: string): Promise<void> {
    this.db.raw
      .prepare(
        `UPDATE jobs SET status = 'failed', error = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(error, jobId);
  }

  async pause(jobId: string, runAfter: Date): Promise<void> {
    this.db.raw
      .prepare(
        `UPDATE jobs SET status = 'queued', run_after = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(runAfter.toISOString(), jobId);
  }

  private rowToJob(row: Record<string, unknown>): Job {
    return {
      id: row.id as string,
      type: row.type as Job["type"],
      payload: JSON.parse(row.payload as string),
      status: row.status as Job["status"],
      result: row.result ? JSON.parse(row.result as string) : null,
      error: (row.error as string) ?? null,
      attempts: row.attempts as number,
      maxRetries: row.max_retries as number,
      runAfter: (row.run_after as string) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
```

**Step 5: Run tests to verify they pass**

```bash
pnpm --filter @ossgard/api test -- src/queue
```
Expected: ALL PASS

**Step 6: Commit**

```bash
git add packages/api/src/queue
git commit -m "feat: add SQLite-backed local job queue"
```

---

### Task 2: Build the worker loop

**Files:**
- Create: `packages/api/src/queue/worker.ts`
- Test: `packages/api/src/queue/worker.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/api/src/queue/worker.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "../db/database.js";
import { LocalJobQueue } from "./local-job-queue.js";
import { WorkerLoop } from "./worker.js";
import type { JobProcessor } from "./types.js";

describe("WorkerLoop", () => {
  let db: Database;
  let queue: LocalJobQueue;

  beforeEach(() => {
    db = new Database(":memory:");
    queue = new LocalJobQueue(db);
  });

  afterEach(() => {
    db.close();
  });

  it("processes a job with the matching processor", async () => {
    const processed: string[] = [];
    const processor: JobProcessor = {
      type: "scan",
      async process(job) {
        processed.push(job.id);
      },
    };

    const worker = new WorkerLoop(queue, [processor]);
    const jobId = await queue.enqueue({ type: "scan", payload: { repoId: 1 } });

    // Run one tick manually
    await worker.tick();

    expect(processed).toHaveLength(1);
    expect(processed[0]).toBe(jobId);

    const status = await queue.getStatus(jobId);
    expect(status!.status).toBe("done");
  });

  it("fails a job when processor throws", async () => {
    const processor: JobProcessor = {
      type: "scan",
      async process() {
        throw new Error("something broke");
      },
    };

    const worker = new WorkerLoop(queue, [processor]);
    const jobId = await queue.enqueue({ type: "scan", payload: {} });

    await worker.tick();

    const status = await queue.getStatus(jobId);
    expect(status!.status).toBe("failed");
    expect(status!.error).toBe("something broke");
  });

  it("does nothing when no jobs are available", async () => {
    const worker = new WorkerLoop(queue, []);
    // Should not throw
    await worker.tick();
  });

  it("skips jobs with no matching processor", async () => {
    const worker = new WorkerLoop(queue, []);
    const jobId = await queue.enqueue({ type: "scan", payload: {} });

    await worker.tick();

    const status = await queue.getStatus(jobId);
    expect(status!.status).toBe("failed");
    expect(status!.error).toContain("No processor");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @ossgard/api test -- src/queue/worker
```
Expected: FAIL — WorkerLoop doesn't exist

**Step 3: Implement WorkerLoop**

```typescript
// packages/api/src/queue/worker.ts
import type { Job } from "@ossgard/shared";
import type { JobQueue } from "./types.js";

export interface JobProcessor {
  type: string;
  process(job: Job): Promise<void>;
}

export class WorkerLoop {
  private processors: Map<string, JobProcessor>;
  private running = false;
  private pollIntervalMs: number;

  constructor(
    private queue: JobQueue,
    processors: JobProcessor[],
    opts?: { pollIntervalMs?: number }
  ) {
    this.processors = new Map(processors.map((p) => [p.type, p]));
    this.pollIntervalMs = opts?.pollIntervalMs ?? 1000;
  }

  async tick(): Promise<void> {
    const job = await this.queue.dequeue();
    if (!job) return;

    const processor = this.processors.get(job.type);
    if (!processor) {
      await this.queue.fail(job.id, `No processor registered for job type: ${job.type}`);
      return;
    }

    try {
      await processor.process(job);
      await this.queue.complete(job.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.queue.fail(job.id, message);
    }
  }

  start(): void {
    this.running = true;
    this.loop();
  }

  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      await this.tick();
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }
}
```

**Step 4: Re-export JobProcessor from types.ts**

Add to `packages/api/src/queue/types.ts`:

```typescript
export interface JobProcessor {
  type: string;
  process(job: Job): Promise<void>;
}
```

**Step 5: Run tests to verify they pass**

```bash
pnpm --filter @ossgard/api test -- src/queue
```
Expected: ALL PASS

**Step 6: Commit**

```bash
git add packages/api/src/queue
git commit -m "feat: add worker loop for processing background jobs"
```

---

### Task 3: Integrate worker loop into API startup

**Files:**
- Modify: `packages/api/src/app.ts`
- Modify: `packages/api/src/index.ts`

**Step 1: Update app.ts to accept and expose the worker**

```typescript
// packages/api/src/app.ts
import { Hono } from "hono";
import { Database } from "./db/database.js";
import { LocalJobQueue } from "./queue/local-job-queue.js";
import { WorkerLoop } from "./queue/worker.js";
import { healthRoutes } from "./routes/health.js";
import { createRepoRoutes } from "./routes/repos.js";

export interface AppContext {
  db: Database;
  queue: LocalJobQueue;
  worker: WorkerLoop;
}

export function createApp(dbPath: string): { app: Hono; ctx: AppContext } {
  const db = new Database(dbPath);
  const queue = new LocalJobQueue(db);
  const worker = new WorkerLoop(queue, []); // processors added in later phases

  const app = new Hono();
  app.route("/", healthRoutes);
  app.route("/", createRepoRoutes(db));

  return { app, ctx: { db, queue, worker } };
}
```

**Step 2: Update index.ts to start the worker**

```typescript
// packages/api/src/index.ts
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const dbPath = process.env.DATABASE_PATH || "./ossgard.db";
const { app, ctx } = createApp(dbPath);

export { app };

const port = parseInt(process.env.PORT || "3400");

serve({ fetch: app.fetch, port }, () => {
  console.log(`ossgard-api running on http://localhost:${port}`);
  ctx.worker.start();
  console.log("Worker loop started");
});
```

**Step 3: Update existing tests to use new createApp return shape**

Update `health.test.ts` and `repos.test.ts`:

```typescript
// Change: const app = createApp(":memory:");
// To:     const { app } = createApp(":memory:");
```

**Step 4: Run all tests**

```bash
pnpm --filter @ossgard/api test
```
Expected: ALL PASS

**Step 5: Commit**

```bash
git add packages/api/src
git commit -m "feat: integrate worker loop into API startup"
```

---

### Task 4: Add scan creation route

**Files:**
- Modify: `packages/api/src/db/database.ts` — add scan CRUD methods
- Create: `packages/api/src/routes/scans.ts`
- Test: `packages/api/src/routes/scans.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/api/src/routes/scans.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createApp } from "../app.js";

describe("Scan routes", () => {
  let app: ReturnType<typeof createApp>["app"];

  beforeEach(async () => {
    const created = createApp(":memory:");
    app = created.app;
    // Track a repo first
    await app.request("/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner: "test", name: "repo" }),
    });
  });

  it("POST /repos/:owner/:name/scan creates a scan and enqueues a job", async () => {
    const res = await app.request("/repos/test/repo/scan", { method: "POST" });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.scanId).toBeDefined();
    expect(body.status).toBe("queued");
  });

  it("GET /scans/:id returns scan progress", async () => {
    const scanRes = await app.request("/repos/test/repo/scan", { method: "POST" });
    const { scanId } = await scanRes.json();

    const res = await app.request(`/scans/${scanId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scanId).toBe(scanId);
    expect(body.status).toBeDefined();
  });

  it("returns 404 for scan on untracked repo", async () => {
    const res = await app.request("/repos/nope/nope/scan", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @ossgard/api test -- src/routes/scans
```
Expected: FAIL

**Step 3: Add scan methods to Database**

Add to `packages/api/src/db/database.ts`:

```typescript
import type { Scan, ScanStatus, ScanProgress } from "@ossgard/shared";

// Inside Database class:
createScan(repoId: number): number {
  const result = this.raw
    .prepare("INSERT INTO scans (repo_id, status) VALUES (?, 'queued')")
    .run(repoId);
  return result.lastInsertRowid as number;
}

getScan(id: number): Scan | undefined {
  const row = this.raw.prepare("SELECT * FROM scans WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return undefined;
  return this.rowToScan(row);
}

updateScanStatus(id: number, status: ScanStatus, extra?: { error?: string; phaseCursor?: Record<string, unknown>; prCount?: number; dupeGroupCount?: number }): void {
  const sets: string[] = ["status = ?", "updated_at = datetime('now')"];
  const params: unknown[] = [status];
  if (extra?.error !== undefined) { sets.push("error = ?"); params.push(extra.error); }
  if (extra?.phaseCursor !== undefined) { sets.push("phase_cursor = ?"); params.push(JSON.stringify(extra.phaseCursor)); }
  if (extra?.prCount !== undefined) { sets.push("pr_count = ?"); params.push(extra.prCount); }
  if (extra?.dupeGroupCount !== undefined) { sets.push("dupe_group_count = ?"); params.push(extra.dupeGroupCount); }
  if (status === "done") { sets.push("completed_at = datetime('now')"); }
  params.push(id);
  this.raw.prepare(`UPDATE scans SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

private rowToScan(row: Record<string, unknown>): Scan {
  return {
    id: row.id as number,
    repoId: row.repo_id as number,
    status: row.status as ScanStatus,
    phaseCursor: row.phase_cursor ? JSON.parse(row.phase_cursor as string) : null,
    prCount: row.pr_count as number,
    dupeGroupCount: row.dupe_group_count as number,
    startedAt: row.started_at as string,
    completedAt: (row.completed_at as string) ?? null,
    error: (row.error as string) ?? null,
  };
}
```

**Step 4: Create scan routes**

```typescript
// packages/api/src/routes/scans.ts
import { Hono } from "hono";
import type { Database } from "../db/database.js";
import type { LocalJobQueue } from "../queue/local-job-queue.js";

export function createScanRoutes(db: Database, queue: LocalJobQueue) {
  const routes = new Hono();

  routes.post("/repos/:owner/:name/scan", async (c) => {
    const { owner, name } = c.req.param();
    const repo = db.getRepoByOwnerName(owner, name);
    if (!repo) return c.json({ error: "Repo not tracked" }, 404);

    const scanId = db.createScan(repo.id);
    await queue.enqueue({
      type: "scan",
      payload: { repoId: repo.id, scanId },
    });

    return c.json({ scanId, status: "queued" }, 202);
  });

  routes.get("/scans/:id", (c) => {
    const id = parseInt(c.req.param("id"));
    const scan = db.getScan(id);
    if (!scan) return c.json({ error: "Scan not found" }, 404);

    return c.json({
      scanId: scan.id,
      status: scan.status,
      prCount: scan.prCount,
      dupeGroupCount: scan.dupeGroupCount,
      startedAt: scan.startedAt,
      completedAt: scan.completedAt,
      error: scan.error,
    });
  });

  return routes;
}
```

**Step 5: Wire scan routes into app.ts**

Add to `createApp`:

```typescript
import { createScanRoutes } from "./routes/scans.js";
// ...
app.route("/", createScanRoutes(db, queue));
```

**Step 6: Run tests to verify they pass**

```bash
pnpm --filter @ossgard/api test
```
Expected: ALL PASS

**Step 7: Commit**

```bash
git add packages/api/src
git commit -m "feat: add scan creation route and scan status polling"
```
