# Phase 6: Clustering

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the cluster pipeline phase that queries Qdrant for similar PRs, builds a similarity graph, and extracts connected components as candidate duplicate groups.

**Architecture:** The `ClusterProcessor` queries both code and intent collections in Qdrant for each PR's nearest neighbors. Pairs exceeding the similarity threshold form edges in an adjacency graph. A union-find algorithm extracts connected components as candidate groups. Also includes a fast-path that groups PRs with identical diff hashes before embedding lookup.

**Tech Stack:** Qdrant queries, union-find algorithm, Vitest

**Depends on:** Phase 5 (embeddings in Qdrant, PRs in SQLite)

---

### Task 1: Implement union-find for connected components

**Files:**
- Create: `packages/api/src/pipeline/union-find.ts`
- Test: `packages/api/src/pipeline/union-find.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/api/src/pipeline/union-find.test.ts
import { describe, it, expect } from "vitest";
import { UnionFind } from "./union-find.js";

describe("UnionFind", () => {
  it("initially each element is its own component", () => {
    const uf = new UnionFind<string>();
    uf.add("a");
    uf.add("b");
    expect(uf.connected("a", "b")).toBe(false);
    expect(uf.getGroups()).toHaveLength(2);
  });

  it("unions two elements into one component", () => {
    const uf = new UnionFind<string>();
    uf.add("a");
    uf.add("b");
    uf.union("a", "b");
    expect(uf.connected("a", "b")).toBe(true);
    expect(uf.getGroups()).toHaveLength(1);
  });

  it("handles transitive unions", () => {
    const uf = new UnionFind<string>();
    uf.add("a");
    uf.add("b");
    uf.add("c");
    uf.union("a", "b");
    uf.union("b", "c");
    expect(uf.connected("a", "c")).toBe(true);
    expect(uf.getGroups()).toHaveLength(1);
    expect(uf.getGroups()[0]).toHaveLength(3);
  });

  it("returns groups with 2+ members only", () => {
    const uf = new UnionFind<string>();
    uf.add("a");
    uf.add("b");
    uf.add("c"); // singleton
    uf.union("a", "b");
    const groups = uf.getGroups(2);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("handles large graphs", () => {
    const uf = new UnionFind<number>();
    for (let i = 0; i < 1000; i++) uf.add(i);
    // Chain: 0-1-2-3-...-99
    for (let i = 0; i < 99; i++) uf.union(i, i + 1);
    const groups = uf.getGroups(2);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(100);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @ossgard/api test -- src/pipeline/union-find
```

**Step 3: Implement UnionFind**

```typescript
// packages/api/src/pipeline/union-find.ts
export class UnionFind<T> {
  private parent = new Map<T, T>();
  private rank = new Map<T, number>();

  add(x: T): void {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
    }
  }

  find(x: T): T {
    let root = x;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    // Path compression
    let current = x;
    while (current !== root) {
      const next = this.parent.get(current)!;
      this.parent.set(current, root);
      current = next;
    }
    return root;
  }

  union(a: T, b: T): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;

    const rankA = this.rank.get(rootA)!;
    const rankB = this.rank.get(rootB)!;
    if (rankA < rankB) {
      this.parent.set(rootA, rootB);
    } else if (rankA > rankB) {
      this.parent.set(rootB, rootA);
    } else {
      this.parent.set(rootB, rootA);
      this.rank.set(rootA, rankA + 1);
    }
  }

  connected(a: T, b: T): boolean {
    return this.find(a) === this.find(b);
  }

  getGroups(minSize = 1): T[][] {
    const groups = new Map<T, T[]>();
    for (const item of this.parent.keys()) {
      const root = this.find(item);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root)!.push(item);
    }
    return Array.from(groups.values()).filter((g) => g.length >= minSize);
  }
}
```

**Step 4: Run tests**

```bash
pnpm --filter @ossgard/api test -- src/pipeline/union-find
```
Expected: ALL PASS

**Step 5: Commit**

```bash
git add packages/api/src/pipeline/union-find.ts packages/api/src/pipeline/union-find.test.ts
git commit -m "feat: add union-find data structure for graph clustering"
```

---

### Task 2: Build the ClusterProcessor

**Files:**
- Create: `packages/api/src/pipeline/cluster.ts`
- Test: `packages/api/src/pipeline/cluster.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/api/src/pipeline/cluster.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "../db/database.js";
import { ClusterProcessor } from "./cluster.js";
import type { VectorStore, SearchResult } from "../services/vector-store.js";
import type { Job } from "@ossgard/shared";

function makeMockVectorStore(searchResults: Map<string, SearchResult[]>): VectorStore {
  return {
    ensureCollection: vi.fn(async () => {}),
    upsert: vi.fn(async () => {}),
    search: vi.fn(async (_col: string, _vec: number[], _opts) => {
      // Return pre-configured results based on collection
      return searchResults.get(_col) ?? [];
    }),
    deleteByFilter: vi.fn(async () => {}),
  };
}

describe("ClusterProcessor", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.insertRepo("test", "repo");
    db.createScan(1);
    // Insert PRs
    for (let i = 1; i <= 5; i++) {
      db.upsertPR({
        repoId: 1, number: i, title: `PR ${i}`, body: `Desc ${i}`,
        author: "alice", diffHash: i <= 2 ? "same-hash" : `hash-${i}`,
        filePaths: ["src/file.ts"], state: "open",
        createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z",
      });
    }
  });

  afterEach(() => db.close());

  it("groups PRs with identical diff hashes (fast path)", async () => {
    const vs = makeMockVectorStore(new Map());
    const processor = new ClusterProcessor(db, vs, {
      codeSimilarityThreshold: 0.85,
      intentSimilarityThreshold: 0.80,
    });

    const job: Job = {
      id: "job-1", type: "cluster",
      payload: { repoId: 1, scanId: 1 },
      status: "running", result: null, error: null,
      attempts: 1, maxRetries: 3, runAfter: null, createdAt: "", updatedAt: "",
    };

    const groups = await processor.findCandidateGroups(job);

    // PRs 1 and 2 share "same-hash"
    const hashGroup = groups.find((g) =>
      g.some((id) => {
        const pr = db.listOpenPRs(1).find((p) => p.id === id);
        return pr?.number === 1;
      })
    );
    expect(hashGroup).toBeDefined();
    expect(hashGroup!.length).toBeGreaterThanOrEqual(2);
  });

  it("updates scan status to clustering", async () => {
    const vs = makeMockVectorStore(new Map());
    const processor = new ClusterProcessor(db, vs, {
      codeSimilarityThreshold: 0.85,
      intentSimilarityThreshold: 0.80,
    });

    const job: Job = {
      id: "job-1", type: "cluster",
      payload: { repoId: 1, scanId: 1 },
      status: "running", result: null, error: null,
      attempts: 1, maxRetries: 3, runAfter: null, createdAt: "", updatedAt: "",
    };

    await processor.process(job);

    const scan = db.getScan(1);
    expect(scan!.status).toBe("clustering");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @ossgard/api test -- src/pipeline/cluster
```

**Step 3: Implement ClusterProcessor**

```typescript
// packages/api/src/pipeline/cluster.ts
import type { Job, PR } from "@ossgard/shared";
import type { Database } from "../db/database.js";
import type { VectorStore } from "../services/vector-store.js";
import type { JobQueue } from "../queue/types.js";
import { UnionFind } from "./union-find.js";

const CODE_COLLECTION = "ossgard-code";
const INTENT_COLLECTION = "ossgard-intent";

interface ClusterConfig {
  codeSimilarityThreshold: number;
  intentSimilarityThreshold: number;
}

export class ClusterProcessor {
  readonly type = "cluster";

  constructor(
    private db: Database,
    private vectorStore: VectorStore,
    private config: ClusterConfig,
    private queue?: JobQueue
  ) {}

  async process(job: Job): Promise<void> {
    const { repoId, scanId } = job.payload as { repoId: number; scanId: number };
    this.db.updateScanStatus(scanId, "clustering");

    const groups = await this.findCandidateGroups(job);

    // Store candidate groups in scan cursor for the verify phase
    this.db.updateScanStatus(scanId, "clustering", {
      phaseCursor: { candidateGroups: groups },
    });

    // Chain to verify phase
    if (this.queue) {
      await this.queue.enqueue({
        type: "verify",
        payload: { repoId, scanId, candidateGroups: groups },
      });
    }
  }

  async findCandidateGroups(job: Job): Promise<number[][]> {
    const { repoId } = job.payload as { repoId: number };
    const prs = this.db.listOpenPRs(repoId);
    const uf = new UnionFind<number>();

    for (const pr of prs) {
      uf.add(pr.id);
    }

    // Fast path: identical diff hashes
    const hashGroups = new Map<string, number[]>();
    for (const pr of prs) {
      if (pr.diffHash) {
        if (!hashGroups.has(pr.diffHash)) hashGroups.set(pr.diffHash, []);
        hashGroups.get(pr.diffHash)!.push(pr.id);
      }
    }
    for (const group of hashGroups.values()) {
      for (let i = 1; i < group.length; i++) {
        uf.union(group[0], group[i]);
      }
    }

    // Embedding-based similarity search
    for (const pr of prs) {
      const codeVectorId = `${repoId}-${pr.number}-code`;
      const intentVectorId = `${repoId}-${pr.number}-intent`;

      // Search code similarity
      try {
        const codeResults = await this.vectorStore.search(CODE_COLLECTION, [], {
          limit: 20,
          filter: { repoId },
        });
        for (const result of codeResults) {
          if (result.score >= this.config.codeSimilarityThreshold && result.payload.prId !== pr.id) {
            uf.union(pr.id, result.payload.prId as number);
          }
        }
      } catch {
        // Vector not found — skip
      }

      // Search intent similarity
      try {
        const intentResults = await this.vectorStore.search(INTENT_COLLECTION, [], {
          limit: 20,
          filter: { repoId },
        });
        for (const result of intentResults) {
          if (result.score >= this.config.intentSimilarityThreshold && result.payload.prId !== pr.id) {
            uf.union(pr.id, result.payload.prId as number);
          }
        }
      } catch {
        // Vector not found — skip
      }
    }

    // Extract groups with 2+ members
    return uf.getGroups(2);
  }
}
```

**Step 4: Run tests**

```bash
pnpm --filter @ossgard/api test -- src/pipeline/cluster
```
Expected: ALL PASS

**Step 5: Commit**

```bash
git add packages/api/src/pipeline/cluster.ts packages/api/src/pipeline/cluster.test.ts
git commit -m "feat: add cluster pipeline phase with diff hash fast path and vector similarity"
```
