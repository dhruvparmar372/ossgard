import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EmbedProcessor } from "./embed.js";
import { Database } from "../db/database.js";
import type { EmbeddingProvider, BatchEmbeddingProvider } from "../services/llm-provider.js";
import type { VectorStore } from "../services/vector-store.js";
import type { JobQueue } from "../queue/types.js";
import type { Job } from "@ossgard/shared";

function createMockEmbeddingProvider(): EmbeddingProvider {
  return {
    dimensions: 768,
    embed: vi.fn().mockResolvedValue([]),
  };
}

function createMockBatchEmbeddingProvider(): BatchEmbeddingProvider {
  return {
    batch: true as const,
    dimensions: 768,
    embed: vi.fn().mockResolvedValue([]),
    embedBatch: vi.fn().mockResolvedValue([]),
  };
}

function createMockVectorStore(): VectorStore {
  return {
    ensureCollection: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    deleteByFilter: vi.fn().mockResolvedValue(undefined),
    getVector: vi.fn().mockResolvedValue(null),
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

function makeVector(seed: number): number[] {
  return Array.from({ length: 768 }, (_, i) => seed * 0.01 + i * 0.001);
}

describe("EmbedProcessor", () => {
  let db: Database;
  let mockEmbedding: EmbeddingProvider;
  let mockVectorStore: VectorStore;
  let mockQueue: JobQueue;
  let processor: EmbedProcessor;
  let repoId: number;
  let scanId: number;

  beforeEach(() => {
    db = new Database(":memory:");
    const repo = db.insertRepo("facebook", "react");
    repoId = repo.id;
    const scan = db.createScan(repoId);
    scanId = scan.id;

    mockEmbedding = createMockEmbeddingProvider();
    mockVectorStore = createMockVectorStore();
    mockQueue = createMockQueue();
    processor = new EmbedProcessor(db, mockEmbedding, mockVectorStore, mockQueue);
  });

  afterEach(() => {
    db.close();
  });

  function makeJob(): Job {
    return {
      id: "test-job-1",
      type: "embed",
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

  function insertPR(number: number, opts?: { diffHash?: string; filePaths?: string[] }) {
    return db.upsertPR({
      repoId,
      number,
      title: `PR #${number}`,
      body: `Body of PR #${number}`,
      author: `author${number}`,
      diffHash: opts?.diffHash ?? `hash${number}`,
      filePaths: opts?.filePaths ?? [`src/file${number}.ts`],
      state: "open",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-02T00:00:00Z",
    });
  }

  it("updates scan status to embedding", async () => {
    await processor.process(makeJob());

    const scan = db.getScan(scanId);
    expect(scan!.status).toBe("embedding");
  });

  it("ensures both code and intent collections exist with provider dimensions", async () => {
    await processor.process(makeJob());

    expect(mockVectorStore.ensureCollection).toHaveBeenCalledTimes(2);
    expect(mockVectorStore.ensureCollection).toHaveBeenCalledWith(
      "ossgard-code",
      768
    );
    expect(mockVectorStore.ensureCollection).toHaveBeenCalledWith(
      "ossgard-intent",
      768
    );
  });

  it("uses provider dimensions for collections", async () => {
    (mockEmbedding as any).dimensions = 3072;
    const processor3072 = new EmbedProcessor(db, mockEmbedding, mockVectorStore, mockQueue);

    await processor3072.process(makeJob());

    expect(mockVectorStore.ensureCollection).toHaveBeenCalledWith(
      "ossgard-code",
      3072
    );
    expect(mockVectorStore.ensureCollection).toHaveBeenCalledWith(
      "ossgard-intent",
      3072
    );
  });

  it("generates embeddings for each PR", async () => {
    insertPR(1);
    insertPR(2);

    const vec1 = makeVector(1);
    const vec2 = makeVector(2);
    vi.mocked(mockEmbedding.embed)
      .mockResolvedValueOnce([vec1, vec2]) // code embeddings
      .mockResolvedValueOnce([vec1, vec2]); // intent embeddings

    await processor.process(makeJob());

    expect(mockEmbedding.embed).toHaveBeenCalledTimes(2);
  });

  it("upserts to both code and intent collections", async () => {
    const pr1 = insertPR(1, { filePaths: ["src/a.ts"], diffHash: "abc123" });
    const vec1 = makeVector(1);

    vi.mocked(mockEmbedding.embed)
      .mockResolvedValueOnce([vec1]) // code
      .mockResolvedValueOnce([vec1]); // intent

    await processor.process(makeJob());

    expect(mockVectorStore.upsert).toHaveBeenCalledTimes(2);

    // Code collection
    expect(mockVectorStore.upsert).toHaveBeenCalledWith("ossgard-code", [
      {
        id: `${repoId}-1-code`,
        vector: vec1,
        payload: { repoId, prNumber: 1, prId: pr1.id },
      },
    ]);

    // Intent collection
    expect(mockVectorStore.upsert).toHaveBeenCalledWith("ossgard-intent", [
      {
        id: `${repoId}-1-intent`,
        vector: vec1,
        payload: { repoId, prNumber: 1, prId: pr1.id },
      },
    ]);
  });

  it("builds correct code and intent input strings", async () => {
    insertPR(1, { filePaths: ["src/a.ts", "src/b.ts"], diffHash: "diffhash1" });

    const vec = makeVector(1);
    vi.mocked(mockEmbedding.embed)
      .mockResolvedValueOnce([vec])
      .mockResolvedValueOnce([vec]);

    await processor.process(makeJob());

    // Code input: filePaths joined
    const codeCall = vi.mocked(mockEmbedding.embed).mock.calls[0];
    expect(codeCall[0]).toEqual(["src/a.ts\nsrc/b.ts"]);

    // Intent input: title + body + filePaths
    const intentCall = vi.mocked(mockEmbedding.embed).mock.calls[1];
    expect(intentCall[0]).toEqual([
      "PR #1\nBody of PR #1\nsrc/a.ts\nsrc/b.ts",
    ]);
  });

  it("enqueues cluster job after completion", async () => {
    await processor.process(makeJob());

    expect(mockQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(mockQueue.enqueue).toHaveBeenCalledWith({
      type: "cluster",
      payload: { repoId, scanId, owner: "facebook", repo: "react" },
    });
  });

  it("processes PRs in batches of 50", async () => {
    // Insert 75 PRs
    for (let i = 1; i <= 75; i++) {
      insertPR(i);
    }

    // First batch: 50 code + 50 intent, second batch: 25 code + 25 intent
    vi.mocked(mockEmbedding.embed).mockImplementation(async (texts) => {
      return texts.map((_, i) => makeVector(i));
    });

    await processor.process(makeJob());

    // 2 batches * 2 types = 4 embed calls
    expect(mockEmbedding.embed).toHaveBeenCalledTimes(4);

    // First batch code: 50 texts
    expect(vi.mocked(mockEmbedding.embed).mock.calls[0][0]).toHaveLength(50);
    // First batch intent: 50 texts
    expect(vi.mocked(mockEmbedding.embed).mock.calls[1][0]).toHaveLength(50);
    // Second batch code: 25 texts
    expect(vi.mocked(mockEmbedding.embed).mock.calls[2][0]).toHaveLength(25);
    // Second batch intent: 25 texts
    expect(vi.mocked(mockEmbedding.embed).mock.calls[3][0]).toHaveLength(25);
  });

  it("handles no open PRs gracefully", async () => {
    await processor.process(makeJob());

    expect(mockEmbedding.embed).not.toHaveBeenCalled();
    expect(mockVectorStore.upsert).not.toHaveBeenCalled();
    // Still enqueues cluster job
    expect(mockQueue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("works without a queue (queue is optional)", async () => {
    const processorNoQueue = new EmbedProcessor(
      db,
      mockEmbedding,
      mockVectorStore
    );

    insertPR(1);
    vi.mocked(mockEmbedding.embed).mockResolvedValue([makeVector(1)]);

    // Should not throw
    await processorNoQueue.process(makeJob());

    expect(mockVectorStore.upsert).toHaveBeenCalled();
  });

  describe("batch path", () => {
    let batchEmbedding: BatchEmbeddingProvider;
    let batchProcessor: EmbedProcessor;

    beforeEach(() => {
      batchEmbedding = createMockBatchEmbeddingProvider();
      batchProcessor = new EmbedProcessor(db, batchEmbedding, mockVectorStore, mockQueue);
    });

    it("uses embedBatch when provider is batch and PRs exist", async () => {
      insertPR(1);
      insertPR(2);

      const vec1 = makeVector(1);
      const vec2 = makeVector(2);

      vi.mocked(batchEmbedding.embedBatch).mockResolvedValue([
        { id: "code-0", embeddings: [vec1, vec2] },
        { id: "intent-0", embeddings: [vec1, vec2] },
      ]);

      await batchProcessor.process(makeJob());

      expect(batchEmbedding.embedBatch).toHaveBeenCalledTimes(1);
      expect(batchEmbedding.embed).not.toHaveBeenCalled();

      // 2 requests: code-0, intent-0
      const batchCall = vi.mocked(batchEmbedding.embedBatch).mock.calls[0][0];
      expect(batchCall).toHaveLength(2);
      expect(batchCall[0].id).toBe("code-0");
      expect(batchCall[1].id).toBe("intent-0");

      // Vectors upserted
      expect(mockVectorStore.upsert).toHaveBeenCalledTimes(2);
    });

    it("creates multiple batch requests for many PRs", async () => {
      for (let i = 1; i <= 75; i++) {
        insertPR(i);
      }

      vi.mocked(batchEmbedding.embedBatch).mockImplementation(
        async (requests) => {
          return requests.map((req) => ({
            id: req.id,
            embeddings: req.texts.map((_, i) => makeVector(i)),
          }));
        }
      );

      await batchProcessor.process(makeJob());

      expect(batchEmbedding.embedBatch).toHaveBeenCalledTimes(1);

      // 2 batches * 2 types = 4 requests
      const batchCall = vi.mocked(batchEmbedding.embedBatch).mock.calls[0][0];
      expect(batchCall).toHaveLength(4);
      expect(batchCall[0].id).toBe("code-0");
      expect(batchCall[0].texts).toHaveLength(50);
      expect(batchCall[1].id).toBe("intent-0");
      expect(batchCall[1].texts).toHaveLength(50);
      expect(batchCall[2].id).toBe("code-1");
      expect(batchCall[2].texts).toHaveLength(25);
      expect(batchCall[3].id).toBe("intent-1");
      expect(batchCall[3].texts).toHaveLength(25);
    });

    it("does not use batch path when no PRs exist", async () => {
      await batchProcessor.process(makeJob());

      expect(batchEmbedding.embedBatch).not.toHaveBeenCalled();
      expect(batchEmbedding.embed).not.toHaveBeenCalled();
    });
  });
});
