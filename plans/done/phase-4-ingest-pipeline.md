# Phase 4: Ingest Pipeline Phase

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the ingest job processor — the first phase of the scan pipeline. It fetches all open PRs from GitHub, stores them in SQLite, computes diff hashes, and supports incremental scanning.

**Architecture:** The `IngestProcessor` implements `JobProcessor`. When a scan job fires, the orchestrator enqueues an ingest job. The ingest processor pages through GitHub PRs, fetches files and diffs for each, stores everything in SQLite, and updates the scan cursor for resumability.

**Tech Stack:** GitHubClient, Database, normalize-diff, Vitest

**Depends on:** Phase 2 (job queue), Phase 3 (GitHub client, diff normalization)

---

### Task 1: Add PR CRUD methods to Database

**Files:**
- Modify: `packages/api/src/db/database.ts`
- Test: `packages/api/src/db/database.test.ts`

**Step 1: Write the failing test**

```typescript
// Add to packages/api/src/db/database.test.ts
describe("PR operations", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.insertRepo("test", "repo");
  });

  afterEach(() => db.close());

  it("upserts a PR", () => {
    db.upsertPR({
      repoId: 1,
      number: 42,
      title: "Add feature",
      body: "Description",
      author: "alice",
      diffHash: "abc123",
      filePaths: ["src/a.ts", "src/b.ts"],
      state: "open",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    });

    const pr = db.getPRByNumber(1, 42);
    expect(pr).toBeDefined();
    expect(pr!.title).toBe("Add feature");
    expect(pr!.filePaths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("updates existing PR on upsert", () => {
    db.upsertPR({
      repoId: 1, number: 42, title: "v1", body: null,
      author: "alice", diffHash: null, filePaths: [],
      state: "open", createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    db.upsertPR({
      repoId: 1, number: 42, title: "v2", body: "updated",
      author: "alice", diffHash: "hash2", filePaths: ["new.ts"],
      state: "open", createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-03T00:00:00Z",
    });

    const pr = db.getPRByNumber(1, 42);
    expect(pr!.title).toBe("v2");
    expect(pr!.diffHash).toBe("hash2");
  });

  it("lists open PRs for a repo", () => {
    db.upsertPR({
      repoId: 1, number: 1, title: "Open", body: null,
      author: "a", diffHash: null, filePaths: [],
      state: "open", createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    db.upsertPR({
      repoId: 1, number: 2, title: "Closed", body: null,
      author: "b", diffHash: null, filePaths: [],
      state: "closed", createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const open = db.listOpenPRs(1);
    expect(open).toHaveLength(1);
    expect(open[0].number).toBe(1);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @ossgard/api test -- src/db/database
```

**Step 3: Add PR methods to Database class**

```typescript
// Add to packages/api/src/db/database.ts

interface UpsertPRInput {
  repoId: number;
  number: number;
  title: string;
  body: string | null;
  author: string;
  diffHash: string | null;
  filePaths: string[];
  state: string;
  createdAt: string;
  updatedAt: string;
}

// Inside Database class:
upsertPR(input: UpsertPRInput): number {
  const stmt = this.raw.prepare(`
    INSERT INTO prs (repo_id, number, title, body, author, diff_hash, file_paths, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(repo_id, number) DO UPDATE SET
      title = excluded.title,
      body = excluded.body,
      author = excluded.author,
      diff_hash = excluded.diff_hash,
      file_paths = excluded.file_paths,
      state = excluded.state,
      updated_at = excluded.updated_at
  `);
  const result = stmt.run(
    input.repoId, input.number, input.title, input.body,
    input.author, input.diffHash, JSON.stringify(input.filePaths),
    input.state, input.createdAt, input.updatedAt
  );
  return result.lastInsertRowid as number;
}

getPRByNumber(repoId: number, number: number): PR | undefined {
  const row = this.raw
    .prepare("SELECT * FROM prs WHERE repo_id = ? AND number = ?")
    .get(repoId, number) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return this.rowToPR(row);
}

listOpenPRs(repoId: number): PR[] {
  const rows = this.raw
    .prepare("SELECT * FROM prs WHERE repo_id = ? AND state = 'open' ORDER BY number")
    .all(repoId) as Record<string, unknown>[];
  return rows.map((r) => this.rowToPR(r));
}

private rowToPR(row: Record<string, unknown>): PR {
  return {
    id: row.id as number,
    repoId: row.repo_id as number,
    number: row.number as number,
    title: row.title as string,
    body: (row.body as string) ?? null,
    author: row.author as string,
    diffHash: (row.diff_hash as string) ?? null,
    filePaths: row.file_paths ? JSON.parse(row.file_paths as string) : [],
    state: row.state as PR["state"],
    githubEtag: (row.github_etag as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
```

**Step 4: Run tests**

```bash
pnpm --filter @ossgard/api test -- src/db/database
```
Expected: ALL PASS

**Step 5: Commit**

```bash
git add packages/api/src/db
git commit -m "feat: add PR upsert and query methods to database"
```

---

### Task 2: Build the IngestProcessor

**Files:**
- Create: `packages/api/src/pipeline/ingest.ts`
- Test: `packages/api/src/pipeline/ingest.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/api/src/pipeline/ingest.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "../db/database.js";
import { IngestProcessor } from "./ingest.js";
import type { GitHubClient } from "../services/github-client.js";
import type { Job } from "@ossgard/shared";

function makeMockGitHub(prs: Array<{ number: number; title: string }>): GitHubClient {
  return {
    listOpenPRs: vi.fn(async () =>
      prs.map((pr) => ({
        number: pr.number,
        title: pr.title,
        body: "desc",
        author: "alice",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
      }))
    ),
    getPRFiles: vi.fn(async () => ["src/file.ts"]),
    getPRDiff: vi.fn(async () => "+added line\n-removed line"),
    rateLimitRemaining: 5000,
    rateLimitReset: 0,
  } as unknown as GitHubClient;
}

describe("IngestProcessor", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.insertRepo("test", "repo");
    db.createScan(1);
  });

  afterEach(() => db.close());

  it("fetches PRs and stores them in the database", async () => {
    const gh = makeMockGitHub([
      { number: 1, title: "PR 1" },
      { number: 2, title: "PR 2" },
    ]);

    const processor = new IngestProcessor(db, gh);
    const job: Job = {
      id: "job-1",
      type: "ingest",
      payload: { repoId: 1, scanId: 1, owner: "test", repo: "repo" },
      status: "running",
      result: null,
      error: null,
      attempts: 1,
      maxRetries: 3,
      runAfter: null,
      createdAt: "",
      updatedAt: "",
    };

    await processor.process(job);

    const prs = db.listOpenPRs(1);
    expect(prs).toHaveLength(2);
    expect(prs[0].title).toBe("PR 1");
    expect(prs[0].diffHash).toBeDefined();

    // Scan should be updated with PR count
    const scan = db.getScan(1);
    expect(scan!.prCount).toBe(2);
    expect(scan!.status).toBe("ingesting");
  });

  it("computes diff hashes for each PR", async () => {
    const gh = makeMockGitHub([{ number: 1, title: "PR 1" }]);
    const processor = new IngestProcessor(db, gh);
    const job: Job = {
      id: "job-1", type: "ingest",
      payload: { repoId: 1, scanId: 1, owner: "test", repo: "repo" },
      status: "running", result: null, error: null,
      attempts: 1, maxRetries: 3, runAfter: null, createdAt: "", updatedAt: "",
    };

    await processor.process(job);

    const pr = db.getPRByNumber(1, 1);
    expect(pr!.diffHash).toBeTruthy();
    expect(pr!.filePaths).toContain("src/file.ts");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @ossgard/api test -- src/pipeline/ingest
```

**Step 3: Implement IngestProcessor**

```typescript
// packages/api/src/pipeline/ingest.ts
import type { Job } from "@ossgard/shared";
import type { Database } from "../db/database.js";
import type { GitHubClient } from "../services/github-client.js";
import { hashDiff } from "./normalize-diff.js";

export class IngestProcessor {
  readonly type = "ingest";

  constructor(
    private db: Database,
    private github: GitHubClient
  ) {}

  async process(job: Job): Promise<void> {
    const { repoId, scanId, owner, repo } = job.payload as {
      repoId: number;
      scanId: number;
      owner: string;
      repo: string;
    };

    this.db.updateScanStatus(scanId, "ingesting");

    // Fetch all open PRs
    const fetchedPRs = await this.github.listOpenPRs(owner, repo);

    // For each PR, fetch files and diff, then store
    for (const fetched of fetchedPRs) {
      const files = await this.github.getPRFiles(owner, repo, fetched.number);
      const diff = await this.github.getPRDiff(owner, repo, fetched.number);
      const diffHash = hashDiff(diff);

      this.db.upsertPR({
        repoId,
        number: fetched.number,
        title: fetched.title,
        body: fetched.body,
        author: fetched.author,
        diffHash,
        filePaths: files,
        state: "open",
        createdAt: fetched.createdAt,
        updatedAt: fetched.updatedAt,
      });
    }

    this.db.updateScanStatus(scanId, "ingesting", { prCount: fetchedPRs.length });
  }
}
```

**Step 4: Run tests**

```bash
pnpm --filter @ossgard/api test -- src/pipeline/ingest
```
Expected: ALL PASS

**Step 5: Commit**

```bash
git add packages/api/src/pipeline/ingest.ts packages/api/src/pipeline/ingest.test.ts
git commit -m "feat: add ingest pipeline processor for fetching PRs from GitHub"
```

---

### Task 3: Build the ScanOrchestrator

**Files:**
- Create: `packages/api/src/pipeline/scan-orchestrator.ts`
- Test: `packages/api/src/pipeline/scan-orchestrator.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/api/src/pipeline/scan-orchestrator.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "../db/database.js";
import { LocalJobQueue } from "../queue/local-job-queue.js";
import { ScanOrchestrator } from "./scan-orchestrator.js";
import type { Job } from "@ossgard/shared";

describe("ScanOrchestrator", () => {
  let db: Database;
  let queue: LocalJobQueue;

  beforeEach(() => {
    db = new Database(":memory:");
    queue = new LocalJobQueue(db);
    db.insertRepo("test", "repo");
  });

  afterEach(() => db.close());

  it("enqueues ingest job as first phase", async () => {
    db.createScan(1);
    const orchestrator = new ScanOrchestrator(db, queue);

    const job: Job = {
      id: "scan-1", type: "scan",
      payload: { repoId: 1, scanId: 1 },
      status: "running", result: null, error: null,
      attempts: 1, maxRetries: 3, runAfter: null, createdAt: "", updatedAt: "",
    };

    await orchestrator.process(job);

    // Should have enqueued an ingest job
    const ingestJob = await queue.dequeue();
    expect(ingestJob).toBeDefined();
    expect(ingestJob!.type).toBe("ingest");
    expect(ingestJob!.payload).toMatchObject({ repoId: 1, scanId: 1 });
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @ossgard/api test -- src/pipeline/scan-orchestrator
```

**Step 3: Implement ScanOrchestrator**

```typescript
// packages/api/src/pipeline/scan-orchestrator.ts
import type { Job } from "@ossgard/shared";
import type { Database } from "../db/database.js";
import type { JobQueue } from "../queue/types.js";

export class ScanOrchestrator {
  readonly type = "scan";

  constructor(
    private db: Database,
    private queue: JobQueue
  ) {}

  async process(job: Job): Promise<void> {
    const { repoId, scanId } = job.payload as { repoId: number; scanId: number };
    const repo = this.db.getRepo(repoId);
    if (!repo) throw new Error(`Repo ${repoId} not found`);

    // Enqueue the first pipeline phase
    await this.queue.enqueue({
      type: "ingest",
      payload: { repoId, scanId, owner: repo.owner, repo: repo.name },
    });
  }
}
```

**Step 4: Run tests**

```bash
pnpm --filter @ossgard/api test -- src/pipeline/scan-orchestrator
```
Expected: ALL PASS

**Step 5: Commit**

```bash
git add packages/api/src/pipeline/scan-orchestrator.ts packages/api/src/pipeline/scan-orchestrator.test.ts
git commit -m "feat: add scan orchestrator that chains pipeline phases"
```

---

### Task 4: Wire phase chaining — ingest enqueues embed

**Files:**
- Modify: `packages/api/src/pipeline/ingest.ts`
- Update: `packages/api/src/pipeline/ingest.test.ts`

**Step 1: Update IngestProcessor to accept a queue and enqueue next phase**

Add a `JobQueue` parameter to the constructor. At the end of `process()`, enqueue an `embed` job:

```typescript
// At end of process():
await this.queue.enqueue({
  type: "embed",
  payload: { repoId, scanId },
});
```

**Step 2: Update test to verify embed job is enqueued**

```typescript
it("enqueues embed job after ingest completes", async () => {
  const gh = makeMockGitHub([{ number: 1, title: "PR 1" }]);
  const queue = new LocalJobQueue(db);
  const processor = new IngestProcessor(db, gh, queue);
  // ... process the job ...
  const embedJob = await queue.dequeue();
  expect(embedJob).toBeDefined();
  expect(embedJob!.type).toBe("embed");
});
```

**Step 3: Run tests**

```bash
pnpm --filter @ossgard/api test -- src/pipeline/ingest
```
Expected: ALL PASS

**Step 4: Commit**

```bash
git add packages/api/src/pipeline
git commit -m "feat: chain ingest → embed in pipeline"
```
