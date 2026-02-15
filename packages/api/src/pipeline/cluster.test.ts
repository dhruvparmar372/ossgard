import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ClusterProcessor } from "./cluster.js";
import { Database } from "../db/database.js";
import type { VectorStore } from "../services/vector-store.js";
import type { JobQueue } from "../queue/types.js";
import type { Job } from "@ossgard/shared";

function createMockVectorStore(): VectorStore {
  return {
    ensureCollection: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    deleteByFilter: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockQueue(): JobQueue {
  return {
    enqueue: vi.fn().mockResolvedValue("job-id"),
    getStatus: vi.fn(),
    dequeue: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
    pause: vi.fn(),
  };
}

describe("ClusterProcessor", () => {
  let db: Database;
  let mockVectorStore: VectorStore;
  let mockQueue: JobQueue;
  let processor: ClusterProcessor;
  let repoId: number;
  let scanId: number;

  beforeEach(() => {
    db = new Database(":memory:");
    const repo = db.insertRepo("facebook", "react");
    repoId = repo.id;
    const scan = db.createScan(repoId);
    scanId = scan.id;

    mockVectorStore = createMockVectorStore();
    mockQueue = createMockQueue();
    processor = new ClusterProcessor(
      db,
      mockVectorStore,
      { codeSimilarityThreshold: 0.85, intentSimilarityThreshold: 0.80 },
      mockQueue
    );
  });

  afterEach(() => {
    db.close();
  });

  function makeJob(): Job {
    return {
      id: "test-job-1",
      type: "cluster",
      payload: { repoId, scanId, owner: "facebook", repo: "react" },
      status: "running",
      result: null,
      error: null,
      attempts: 1,
      maxRetries: 3,
      runAfter: null,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
  }

  function insertPR(
    number: number,
    opts?: { diffHash?: string; filePaths?: string[] }
  ) {
    return db.upsertPR({
      repoId,
      number,
      title: `PR #${number}`,
      body: `Body of PR #${number}`,
      author: `author${number}`,
      diffHash: opts?.diffHash ?? `unique-hash-${number}`,
      filePaths: opts?.filePaths ?? [`src/file${number}.ts`],
      state: "open",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-02T00:00:00Z",
    });
  }

  it("updates scan status to clustering", async () => {
    await processor.process(makeJob());

    const scan = db.getScan(scanId);
    expect(scan!.status).toBe("clustering");
  });

  it("groups PRs with identical diff hashes", async () => {
    const pr1 = insertPR(1, { diffHash: "same-hash" });
    const pr2 = insertPR(2, { diffHash: "same-hash" });
    insertPR(3, { diffHash: "different-hash" });

    await processor.process(makeJob());

    const enqueueCall = vi.mocked(mockQueue.enqueue).mock.calls[0][0];
    const candidateGroups = (
      enqueueCall.payload as { candidateGroups: Array<{ prNumbers: number[]; prIds: number[] }> }
    ).candidateGroups;

    expect(candidateGroups).toHaveLength(1);
    expect(candidateGroups[0].prNumbers).toEqual([1, 2]);
    expect(candidateGroups[0].prIds).toEqual([pr1.id, pr2.id]);
  });

  it("groups multiple PRs with same diff hash", async () => {
    const pr1 = insertPR(1, { diffHash: "same-hash" });
    const pr2 = insertPR(2, { diffHash: "same-hash" });
    const pr3 = insertPR(3, { diffHash: "same-hash" });

    await processor.process(makeJob());

    const enqueueCall = vi.mocked(mockQueue.enqueue).mock.calls[0][0];
    const candidateGroups = (
      enqueueCall.payload as { candidateGroups: Array<{ prNumbers: number[]; prIds: number[] }> }
    ).candidateGroups;

    expect(candidateGroups).toHaveLength(1);
    expect(candidateGroups[0].prNumbers).toEqual([1, 2, 3]);
  });

  it("groups PRs via embedding similarity", async () => {
    const pr1 = insertPR(1, { diffHash: "hash-1" });
    const pr2 = insertPR(2, { diffHash: "hash-2" });

    // Mock vector search to return high similarity between PR 1 and PR 2
    vi.mocked(mockVectorStore.search).mockImplementation(
      async (collection, _vector, _opts) => {
        if (collection === "ossgard-code") {
          // For PR 1 query, return PR 2 as highly similar
          // For PR 2 query, return PR 1 as highly similar
          return [
            {
              id: `${repoId}-${2}-code`,
              score: 0.92,
              payload: { repoId, prNumber: 2, prId: pr2.id },
            },
            {
              id: `${repoId}-${1}-code`,
              score: 0.92,
              payload: { repoId, prNumber: 1, prId: pr1.id },
            },
          ];
        }
        return [];
      }
    );

    await processor.process(makeJob());

    const enqueueCall = vi.mocked(mockQueue.enqueue).mock.calls[0][0];
    const candidateGroups = (
      enqueueCall.payload as { candidateGroups: Array<{ prNumbers: number[]; prIds: number[] }> }
    ).candidateGroups;

    expect(candidateGroups).toHaveLength(1);
    expect(candidateGroups[0].prNumbers).toEqual([1, 2]);
  });

  it("does not group PRs below similarity threshold", async () => {
    insertPR(1, { diffHash: "hash-1" });
    insertPR(2, { diffHash: "hash-2" });

    // Mock vector search with below-threshold similarity
    vi.mocked(mockVectorStore.search).mockResolvedValue([
      {
        id: `${repoId}-2-code`,
        score: 0.50, // Below both thresholds
        payload: { repoId, prNumber: 2 },
      },
    ]);

    await processor.process(makeJob());

    const enqueueCall = vi.mocked(mockQueue.enqueue).mock.calls[0][0];
    const candidateGroups = (
      enqueueCall.payload as { candidateGroups: Array<{ prNumbers: number[]; prIds: number[] }> }
    ).candidateGroups;

    expect(candidateGroups).toHaveLength(0);
  });

  it("stores candidate groups in scan phaseCursor", async () => {
    insertPR(1, { diffHash: "same-hash" });
    insertPR(2, { diffHash: "same-hash" });

    await processor.process(makeJob());

    const scan = db.getScan(scanId);
    expect(scan!.phaseCursor).toBeDefined();
    expect(
      (scan!.phaseCursor as { candidateGroups: unknown[] }).candidateGroups
    ).toHaveLength(1);
  });

  it("enqueues verify job with candidateGroups payload", async () => {
    insertPR(1, { diffHash: "same-hash" });
    insertPR(2, { diffHash: "same-hash" });

    await processor.process(makeJob());

    expect(mockQueue.enqueue).toHaveBeenCalledTimes(1);
    const enqueueCall = vi.mocked(mockQueue.enqueue).mock.calls[0][0];
    expect(enqueueCall.type).toBe("verify");
    expect(enqueueCall.payload).toMatchObject({
      repoId,
      scanId,
      owner: "facebook",
      repo: "react",
    });
    expect(
      (enqueueCall.payload as { candidateGroups: unknown }).candidateGroups
    ).toBeDefined();
  });

  it("handles no open PRs gracefully", async () => {
    await processor.process(makeJob());

    expect(mockQueue.enqueue).toHaveBeenCalledTimes(1);
    const enqueueCall = vi.mocked(mockQueue.enqueue).mock.calls[0][0];
    const candidateGroups = (
      enqueueCall.payload as { candidateGroups: unknown[] }
    ).candidateGroups;
    expect(candidateGroups).toHaveLength(0);
  });

  it("handles multiple separate duplicate groups", async () => {
    insertPR(1, { diffHash: "hash-a" });
    insertPR(2, { diffHash: "hash-a" });
    insertPR(3, { diffHash: "hash-b" });
    insertPR(4, { diffHash: "hash-b" });
    insertPR(5, { diffHash: "unique" });

    await processor.process(makeJob());

    const enqueueCall = vi.mocked(mockQueue.enqueue).mock.calls[0][0];
    const candidateGroups = (
      enqueueCall.payload as { candidateGroups: Array<{ prNumbers: number[] }> }
    ).candidateGroups;

    expect(candidateGroups).toHaveLength(2);
    const allNumbers = candidateGroups
      .flatMap((g) => g.prNumbers)
      .sort();
    expect(allNumbers).toEqual([1, 2, 3, 4]);
  });
});
