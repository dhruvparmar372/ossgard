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
    getVector: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
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

const TEST_CONFIG = {
  github: { token: "ghp_test" },
  llm: { provider: "ollama", url: "http://localhost:11434", model: "llama3", api_key: "" },
  embedding: { provider: "ollama", url: "http://localhost:11434", model: "nomic-embed-text", api_key: "" },
  vector_store: { url: "http://localhost:6333", api_key: "" },
};

describe("ClusterProcessor", () => {
  let db: Database;
  let mockVectorStore: VectorStore;
  let mockQueue: JobQueue;
  let processor: ClusterProcessor;
  let repoId: number;
  let scanId: number;
  let accountId: number;

  beforeEach(() => {
    db = new Database(":memory:");
    const account = db.createAccount("key-1", "test", TEST_CONFIG as any);
    accountId = account.id;
    const repo = db.insertRepo("facebook", "react");
    repoId = repo.id;
    const scan = db.createScan(repoId, accountId);
    scanId = scan.id;

    mockVectorStore = createMockVectorStore();
    mockQueue = createMockQueue();
    const mockResolver = {
      resolve: vi.fn().mockResolvedValue({
        vectorStore: mockVectorStore,
        scanConfig: { codeSimilarityThreshold: 0.85, intentSimilarityThreshold: 0.80 },
      }),
    };
    processor = new ClusterProcessor(db, mockResolver as any, mockQueue);
  });

  afterEach(() => {
    db.close();
  });

  function makeJob(): Job {
    return {
      id: "test-job-1",
      type: "cluster",
      payload: { repoId, scanId, accountId, owner: "facebook", repo: "react" },
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

    const enqueueCall = (mockQueue.enqueue as any).mock.calls[0][0];
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

    const enqueueCall = (mockQueue.enqueue as any).mock.calls[0][0];
    const candidateGroups = (
      enqueueCall.payload as { candidateGroups: Array<{ prNumbers: number[]; prIds: number[] }> }
    ).candidateGroups;

    expect(candidateGroups).toHaveLength(1);
    expect(candidateGroups[0].prNumbers).toEqual([1, 2, 3]);
  });

  it("groups PRs via embedding similarity", async () => {
    const pr1 = insertPR(1, { diffHash: "hash-1" });
    const pr2 = insertPR(2, { diffHash: "hash-2" });

    // Mock getVector to return a fake vector
    (mockVectorStore.getVector as any).mockResolvedValue([0.1, 0.2, 0.3]);

    // Mock vector search to return high similarity between PR 1 and PR 2
    (mockVectorStore.search as any).mockImplementation(
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

    // Verify search is called with actual vectors, NOT []
    const searchCalls = (mockVectorStore.search as any).mock.calls;
    for (const call of searchCalls) {
      expect(call[1]).toEqual([0.1, 0.2, 0.3]);
    }

    const enqueueCall = (mockQueue.enqueue as any).mock.calls[0][0];
    const candidateGroups = (
      enqueueCall.payload as { candidateGroups: Array<{ prNumbers: number[]; prIds: number[] }> }
    ).candidateGroups;

    expect(candidateGroups).toHaveLength(1);
    expect(candidateGroups[0].prNumbers).toEqual([1, 2]);
  });

  it("skips vector search when getVector returns null (no embedding)", async () => {
    insertPR(1, { diffHash: "hash-1" });
    insertPR(2, { diffHash: "hash-2" });

    // No embeddings stored for any PR
    (mockVectorStore.getVector as any).mockResolvedValue(null);

    await processor.process(makeJob());

    // search should never be called since no vectors are available
    expect(mockVectorStore.search).not.toHaveBeenCalled();

    const enqueueCall = (mockQueue.enqueue as any).mock.calls[0][0];
    const candidateGroups = (
      enqueueCall.payload as { candidateGroups: unknown[] }
    ).candidateGroups;
    expect(candidateGroups).toHaveLength(0);
  });

  it("does not group PRs below similarity threshold", async () => {
    insertPR(1, { diffHash: "hash-1" });
    insertPR(2, { diffHash: "hash-2" });

    // Mock vector search with below-threshold similarity
    (mockVectorStore.search as any).mockResolvedValue([
      {
        id: `${repoId}-2-code`,
        score: 0.50, // Below both thresholds
        payload: { repoId, prNumber: 2 },
      },
    ]);

    await processor.process(makeJob());

    const enqueueCall = (mockQueue.enqueue as any).mock.calls[0][0];
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
    const enqueueCall = (mockQueue.enqueue as any).mock.calls[0][0];
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
    const enqueueCall = (mockQueue.enqueue as any).mock.calls[0][0];
    const candidateGroups = (
      enqueueCall.payload as { candidateGroups: unknown[] }
    ).candidateGroups;
    expect(candidateGroups).toHaveLength(0);
  });

  it("skips stale vectors for PRs not in current open set", async () => {
    insertPR(1, { diffHash: "hash-1" });
    insertPR(2, { diffHash: "hash-2" });
    // PR #999 is NOT in the database — simulates a stale Qdrant vector

    (mockVectorStore.getVector as any).mockResolvedValue([0.1, 0.2, 0.3]);

    (mockVectorStore.search as any).mockImplementation(
      async (collection: string) => {
        if (collection === "ossgard-code") {
          return [
            {
              id: `${repoId}-999-code`,
              score: 0.95,
              payload: { repoId, prNumber: 999 }, // stale PR not in UnionFind
            },
            {
              id: `${repoId}-2-code`,
              score: 0.90,
              payload: { repoId, prNumber: 2 },
            },
          ];
        }
        return [];
      }
    );

    // Should NOT throw "Element not found in UnionFind: 999"
    await processor.process(makeJob());

    const enqueueCall = (mockQueue.enqueue as any).mock.calls[0][0];
    const candidateGroups = (
      enqueueCall.payload as { candidateGroups: Array<{ prNumbers: number[] }> }
    ).candidateGroups;

    // PRs 1 and 2 should be grouped (via code similarity), PR 999 should be ignored
    expect(candidateGroups).toHaveLength(1);
    expect(candidateGroups[0].prNumbers).toEqual([1, 2]);
  });

  it("handles multiple separate duplicate groups", async () => {
    insertPR(1, { diffHash: "hash-a" });
    insertPR(2, { diffHash: "hash-a" });
    insertPR(3, { diffHash: "hash-b" });
    insertPR(4, { diffHash: "hash-b" });
    insertPR(5, { diffHash: "unique" });

    await processor.process(makeJob());

    const enqueueCall = (mockQueue.enqueue as any).mock.calls[0][0];
    const candidateGroups = (
      enqueueCall.payload as { candidateGroups: Array<{ prNumbers: number[] }> }
    ).candidateGroups;

    expect(candidateGroups).toHaveLength(2);
    const allNumbers = candidateGroups
      .flatMap((g) => g.prNumbers)
      .sort();
    expect(allNumbers).toEqual([1, 2, 3, 4]);
  });

  it("splits oversized groups into chunks of MAX_GROUP_SIZE", async () => {
    // Create 150 PRs all sharing the same diffHash → one giant group
    for (let i = 1; i <= 150; i++) {
      insertPR(i, { diffHash: "same-hash-for-all" });
    }

    await processor.process(makeJob());

    const enqueueCall = (mockQueue.enqueue as any).mock.calls[0][0];
    const candidateGroups = (
      enqueueCall.payload as { candidateGroups: Array<{ prNumbers: number[] }> }
    ).candidateGroups;

    // 150 PRs with MAX_GROUP_SIZE=50 → should be split into 3 groups (50 + 50 + 50)
    expect(candidateGroups).toHaveLength(3);
    expect(candidateGroups[0].prNumbers).toHaveLength(50);
    expect(candidateGroups[1].prNumbers).toHaveLength(50);
    expect(candidateGroups[2].prNumbers).toHaveLength(50);

    // All 150 PRs should be present across all groups
    const allNumbers = candidateGroups
      .flatMap((g) => g.prNumbers)
      .sort((a, b) => a - b);
    expect(allNumbers).toHaveLength(150);
    expect(allNumbers[0]).toBe(1);
    expect(allNumbers[149]).toBe(150);
  });
});
