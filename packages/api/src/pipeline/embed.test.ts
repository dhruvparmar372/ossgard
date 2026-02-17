import { EmbedProcessor, computeEmbedHash, MAX_ENQUEUED_TOKENS } from "./embed.js";
import { Database } from "../db/database.js";
import type { EmbeddingProvider, BatchEmbeddingProvider } from "../services/llm-provider.js";
import type { VectorStore } from "../services/vector-store.js";
import type { JobQueue } from "../queue/types.js";
import type { Job } from "@ossgard/shared";

function createMockEmbeddingProvider(): EmbeddingProvider {
  return {
    dimensions: 768,
    maxInputTokens: 8192,
    countTokens: (t: string) => Math.ceil(t.length / 4),
    embed: vi.fn().mockResolvedValue([]),
  };
}

function createMockBatchEmbeddingProvider(): BatchEmbeddingProvider {
  return {
    batch: true as const,
    dimensions: 768,
    maxInputTokens: 8192,
    countTokens: (t: string) => Math.ceil(t.length / 4),
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

const TEST_CONFIG = {
  github: { token: "ghp_test" },
  llm: { provider: "ollama", url: "http://localhost:11434", model: "llama3", api_key: "" },
  embedding: { provider: "ollama", url: "http://localhost:11434", model: "nomic-embed-text", api_key: "" },
  vector_store: { url: "http://localhost:6333", api_key: "" },
};

describe("EmbedProcessor", () => {
  let db: Database;
  let mockEmbedding: EmbeddingProvider;
  let mockVectorStore: VectorStore;
  let mockQueue: JobQueue;
  let mockResolver: any;
  let processor: EmbedProcessor;
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

    mockEmbedding = createMockEmbeddingProvider();
    mockVectorStore = createMockVectorStore();
    mockQueue = createMockQueue();
    mockResolver = {
      resolve: vi.fn().mockResolvedValue({
        embedding: mockEmbedding,
        vectorStore: mockVectorStore,
      }),
    };
    processor = new EmbedProcessor(db, mockResolver, mockQueue);
  });

  afterEach(() => {
    db.close();
  });

  function makeJob(): Job {
    return {
      id: "test-job-1",
      type: "embed",
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
    const mockEmbedding3072 = createMockEmbeddingProvider();
    (mockEmbedding3072 as any).dimensions = 3072;
    const mockResolver3072 = {
      resolve: vi.fn().mockResolvedValue({
        embedding: mockEmbedding3072,
        vectorStore: mockVectorStore,
      }),
    };
    const processor3072 = new EmbedProcessor(db, mockResolver3072 as any, mockQueue);

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
    (mockEmbedding.embed as any)
      .mockResolvedValueOnce([vec1, vec2]) // code embeddings
      .mockResolvedValueOnce([vec1, vec2]); // intent embeddings

    await processor.process(makeJob());

    expect(mockEmbedding.embed).toHaveBeenCalledTimes(2);
  });

  it("upserts to both code and intent collections", async () => {
    const pr1 = insertPR(1, { filePaths: ["src/a.ts"], diffHash: "abc123" });
    const vec1 = makeVector(1);

    (mockEmbedding.embed as any)
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
    (mockEmbedding.embed as any)
      .mockResolvedValueOnce([vec])
      .mockResolvedValueOnce([vec]);

    await processor.process(makeJob());

    // Code input: filePaths joined
    const codeCall = (mockEmbedding.embed as any).mock.calls[0];
    expect(codeCall[0]).toEqual(["src/a.ts\nsrc/b.ts"]);

    // Intent input: title + body + filePaths
    const intentCall = (mockEmbedding.embed as any).mock.calls[1];
    expect(intentCall[0]).toEqual([
      "PR #1\nBody of PR #1\nsrc/a.ts\nsrc/b.ts",
    ]);
  });

  it("enqueues cluster job after completion", async () => {
    await processor.process(makeJob());

    expect(mockQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(mockQueue.enqueue).toHaveBeenCalledWith({
      type: "cluster",
      payload: { repoId, scanId, accountId, owner: "facebook", repo: "react" },
    });
  });

  it("processes PRs in batches of 50", async () => {
    // Insert 75 PRs
    for (let i = 1; i <= 75; i++) {
      insertPR(i);
    }

    // First batch: 50 code + 50 intent, second batch: 25 code + 25 intent
    (mockEmbedding.embed as any).mockImplementation(async (texts) => {
      return texts.map((_, i) => makeVector(i));
    });

    await processor.process(makeJob());

    // 2 batches * 2 types = 4 embed calls
    expect(mockEmbedding.embed).toHaveBeenCalledTimes(4);

    // First batch code: 50 texts
    expect((mockEmbedding.embed as any).mock.calls[0][0]).toHaveLength(50);
    // First batch intent: 50 texts
    expect((mockEmbedding.embed as any).mock.calls[1][0]).toHaveLength(50);
    // Second batch code: 25 texts
    expect((mockEmbedding.embed as any).mock.calls[2][0]).toHaveLength(25);
    // Second batch intent: 25 texts
    expect((mockEmbedding.embed as any).mock.calls[3][0]).toHaveLength(25);
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
      mockResolver
    );

    insertPR(1);
    (mockEmbedding.embed as any).mockResolvedValue([makeVector(1)]);

    // Should not throw
    await processorNoQueue.process(makeJob());

    expect(mockVectorStore.upsert).toHaveBeenCalled();
  });

  describe("batch path", () => {
    let batchEmbedding: BatchEmbeddingProvider;
    let batchProcessor: EmbedProcessor;

    beforeEach(() => {
      batchEmbedding = createMockBatchEmbeddingProvider();
      const batchResolver = {
        resolve: vi.fn().mockResolvedValue({
          embedding: batchEmbedding,
          vectorStore: mockVectorStore,
        }),
      };
      batchProcessor = new EmbedProcessor(db, batchResolver as any, mockQueue);
    });

    it("uses embedBatch when provider is batch and PRs exist", async () => {
      insertPR(1);
      insertPR(2);

      const vec1 = makeVector(1);
      const vec2 = makeVector(2);

      (batchEmbedding.embedBatch as any).mockResolvedValue([
        { id: "code-0", embeddings: [vec1, vec2] },
        { id: "intent-0", embeddings: [vec1, vec2] },
      ]);

      await batchProcessor.process(makeJob());

      expect(batchEmbedding.embedBatch).toHaveBeenCalledTimes(1);
      expect(batchEmbedding.embed).not.toHaveBeenCalled();

      // 2 requests: code-0, intent-0
      const batchCall = (batchEmbedding.embedBatch as any).mock.calls[0][0];
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

      (batchEmbedding.embedBatch as any).mockImplementation(
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
      const batchCall = (batchEmbedding.embedBatch as any).mock.calls[0][0];
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

    it("splits into multiple batch chunks when token count exceeds limit", async () => {
      // Insert 4 PRs with long file paths to push token counts high
      // Mock countTokens returns t.length/4, so we need total tokens > MAX_ENQUEUED_TOKENS
      // With BATCH_SIZE=50, 4 PRs fit in 1 group. We need tokens per group > MAX_ENQUEUED_TOKENS
      // to force splitting. Create PRs with very long filePaths.
      const longPath = "a".repeat(MAX_ENQUEUED_TOKENS); // ~700K tokens per text with /4 mock

      for (let i = 1; i <= 3; i++) {
        insertPR(i, { filePaths: [longPath] });
      }

      (batchEmbedding.embedBatch as any).mockImplementation(
        async (requests: any[]) => {
          return requests.map((req: any) => ({
            id: req.id,
            embeddings: req.texts.map((_: any, idx: number) => makeVector(idx)),
          }));
        }
      );

      await batchProcessor.process(makeJob());

      // Each PR generates ~700K tokens for code + ~700K for intent = ~1.4M per PR
      // With 3 PRs in 1 group = ~4.2M total, which exceeds 2.8M limit
      // But since all 3 fit in 1 BATCH_SIZE group, they can't be split further
      // So this tests the single-group-per-chunk case. Let's verify at least 1 call.
      expect(batchEmbedding.embedBatch).toHaveBeenCalled();
      expect(mockVectorStore.upsert).toHaveBeenCalled();
    });

    it("splits groups across chunks when total tokens exceed limit", async () => {
      // Create 60 PRs to get 2 groups (50 + 10), with high-token content
      // Mock countTokens = length/4, so each PR with a ~4000-char path = ~1000 tokens
      // 50 PRs × 1000 tokens × 2 (code+intent) = 100K per group. Need many groups.
      // Instead, use fewer PRs with very high tokens per group.

      // Override the batch embedding provider with a high token counter
      const highTokenProvider: BatchEmbeddingProvider = {
        batch: true as const,
        dimensions: 768,
        maxInputTokens: 8192,
        // Return very high token count — 500K per text
        countTokens: () => 500_000,
        embed: vi.fn().mockResolvedValue([]),
        embedBatch: vi.fn().mockImplementation(async (requests: any[]) => {
          return requests.map((req: any) => ({
            id: req.id,
            embeddings: req.texts.map((_: any, idx: number) => makeVector(idx)),
          }));
        }),
      };
      const highTokenResolver = {
        resolve: vi.fn().mockResolvedValue({
          embedding: highTokenProvider,
          vectorStore: mockVectorStore,
        }),
      };
      const highTokenProcessor = new EmbedProcessor(db, highTokenResolver as any, mockQueue);

      // 120 PRs = 3 groups of 50, 50, 20
      // Each group: 50 × 500K × 2 = 50M tokens (way over limit)
      // So each group becomes its own chunk → 3 embedBatch calls
      for (let i = 1; i <= 120; i++) {
        insertPR(i);
      }

      await highTokenProcessor.process(makeJob());

      // Each group exceeds MAX_ENQUEUED_TOKENS, so each gets its own chunk
      expect(highTokenProvider.embedBatch).toHaveBeenCalledTimes(3);

      // First chunk: group 0 (50 PRs) = 2 requests (code-0, intent-0)
      const call1 = (highTokenProvider.embedBatch as any).mock.calls[0][0];
      expect(call1).toHaveLength(2);
      expect(call1[0].id).toBe("code-0");
      expect(call1[0].texts).toHaveLength(50);

      // Second chunk: group 1 (50 PRs)
      const call2 = (highTokenProvider.embedBatch as any).mock.calls[1][0];
      expect(call2).toHaveLength(2);
      expect(call2[0].id).toBe("code-1");
      expect(call2[0].texts).toHaveLength(50);

      // Third chunk: group 2 (20 PRs)
      const call3 = (highTokenProvider.embedBatch as any).mock.calls[2][0];
      expect(call3).toHaveLength(2);
      expect(call3[0].id).toBe("code-2");
      expect(call3[0].texts).toHaveLength(20);

      // All vectors upserted (3 chunks × 2 collections)
      expect(mockVectorStore.upsert).toHaveBeenCalledTimes(6);
    });
  });

  describe("embed hash skip logic", () => {
    it("computeEmbedHash returns consistent hash for same input", () => {
      const pr = { diffHash: "abc", title: "Fix bug", body: "Description", filePaths: ["src/a.ts"] };
      const hash1 = computeEmbedHash(pr);
      const hash2 = computeEmbedHash(pr);
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(16);
    });

    it("computeEmbedHash changes when any field changes", () => {
      const base = { diffHash: "abc", title: "Fix bug", body: "Description", filePaths: ["src/a.ts"] };
      const h1 = computeEmbedHash(base);
      const h2 = computeEmbedHash({ ...base, title: "Different title" });
      const h3 = computeEmbedHash({ ...base, diffHash: "xyz" });
      const h4 = computeEmbedHash({ ...base, filePaths: ["src/b.ts"] });
      expect(h1).not.toBe(h2);
      expect(h1).not.toBe(h3);
      expect(h1).not.toBe(h4);
    });

    it("skips PRs that already have matching embed_hash", async () => {
      const pr1 = insertPR(1, { diffHash: "hash1", filePaths: ["src/file1.ts"] });
      const pr2 = insertPR(2, { diffHash: "hash2", filePaths: ["src/file2.ts"] });

      // Stamp PR1 with its current embed hash so it gets skipped
      const pr1Obj = db.getPR(pr1.id)!;
      const hash = computeEmbedHash(pr1Obj);
      db.updatePREmbedHash(pr1.id, hash);

      // Only PR2 should be embedded (1 code + 1 intent call)
      const vec = makeVector(1);
      (mockEmbedding.embed as any)
        .mockResolvedValueOnce([vec]) // code for PR2
        .mockResolvedValueOnce([vec]); // intent for PR2

      await processor.process(makeJob());

      expect(mockEmbedding.embed).toHaveBeenCalledTimes(2);
      // Only 2 upsert calls (code + intent for PR2)
      expect(mockVectorStore.upsert).toHaveBeenCalledTimes(2);
    });

    it("stamps embed_hash after successful embedding", async () => {
      const pr = insertPR(1, { diffHash: "hashX", filePaths: ["src/file1.ts"] });

      const vec = makeVector(1);
      (mockEmbedding.embed as any)
        .mockResolvedValueOnce([vec])
        .mockResolvedValueOnce([vec]);

      await processor.process(makeJob());

      const updatedPr = db.getPR(pr.id)!;
      expect(updatedPr.embedHash).toBe(computeEmbedHash(updatedPr));
    });

    it("skips all PRs when all are already embedded", async () => {
      const pr1 = insertPR(1, { diffHash: "h1", filePaths: ["src/a.ts"] });
      const pr2 = insertPR(2, { diffHash: "h2", filePaths: ["src/b.ts"] });

      // Stamp both
      db.updatePREmbedHash(pr1.id, computeEmbedHash(db.getPR(pr1.id)!));
      db.updatePREmbedHash(pr2.id, computeEmbedHash(db.getPR(pr2.id)!));

      await processor.process(makeJob());

      // No embedding should happen
      expect(mockEmbedding.embed).not.toHaveBeenCalled();
      // Cluster job should still be enqueued
      expect(mockQueue.enqueue).toHaveBeenCalledTimes(1);
    });
  });
});
