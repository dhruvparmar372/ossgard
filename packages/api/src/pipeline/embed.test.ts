import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EmbedProcessor } from "./embed.js";
import { Database } from "../db/database.js";
import type { LLMProvider } from "../services/llm-provider.js";
import type { VectorStore } from "../services/vector-store.js";
import type { JobQueue } from "../queue/types.js";
import type { Job } from "@ossgard/shared";

function createMockLLM(): LLMProvider {
  return {
    embed: vi.fn().mockResolvedValue([]),
    chat: vi.fn().mockResolvedValue({}),
  };
}

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

function makeVector(seed: number): number[] {
  return Array.from({ length: 768 }, (_, i) => seed * 0.01 + i * 0.001);
}

describe("EmbedProcessor", () => {
  let db: Database;
  let mockLLM: LLMProvider;
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

    mockLLM = createMockLLM();
    mockVectorStore = createMockVectorStore();
    mockQueue = createMockQueue();
    processor = new EmbedProcessor(db, mockLLM, mockVectorStore, mockQueue);
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

  it("ensures both code and intent collections exist", async () => {
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

  it("generates embeddings for each PR", async () => {
    insertPR(1);
    insertPR(2);

    const vec1 = makeVector(1);
    const vec2 = makeVector(2);
    vi.mocked(mockLLM.embed)
      .mockResolvedValueOnce([vec1, vec2]) // code embeddings
      .mockResolvedValueOnce([vec1, vec2]); // intent embeddings

    await processor.process(makeJob());

    expect(mockLLM.embed).toHaveBeenCalledTimes(2);
  });

  it("upserts to both code and intent collections", async () => {
    const pr1 = insertPR(1, { filePaths: ["src/a.ts"], diffHash: "abc123" });
    const vec1 = makeVector(1);

    vi.mocked(mockLLM.embed)
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
    vi.mocked(mockLLM.embed)
      .mockResolvedValueOnce([vec])
      .mockResolvedValueOnce([vec]);

    await processor.process(makeJob());

    // Code input: filePaths joined + diffHash
    const codeCall = vi.mocked(mockLLM.embed).mock.calls[0];
    expect(codeCall[0]).toEqual(["src/a.ts\nsrc/b.ts\ndiffhash1"]);

    // Intent input: title + body + filePaths
    const intentCall = vi.mocked(mockLLM.embed).mock.calls[1];
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
    vi.mocked(mockLLM.embed).mockImplementation(async (texts) => {
      return texts.map((_, i) => makeVector(i));
    });

    await processor.process(makeJob());

    // 2 batches * 2 types = 4 embed calls
    expect(mockLLM.embed).toHaveBeenCalledTimes(4);

    // First batch code: 50 texts
    expect(vi.mocked(mockLLM.embed).mock.calls[0][0]).toHaveLength(50);
    // First batch intent: 50 texts
    expect(vi.mocked(mockLLM.embed).mock.calls[1][0]).toHaveLength(50);
    // Second batch code: 25 texts
    expect(vi.mocked(mockLLM.embed).mock.calls[2][0]).toHaveLength(25);
    // Second batch intent: 25 texts
    expect(vi.mocked(mockLLM.embed).mock.calls[3][0]).toHaveLength(25);
  });

  it("handles no open PRs gracefully", async () => {
    await processor.process(makeJob());

    expect(mockLLM.embed).not.toHaveBeenCalled();
    expect(mockVectorStore.upsert).not.toHaveBeenCalled();
    // Still enqueues cluster job
    expect(mockQueue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("works without a queue (queue is optional)", async () => {
    const processorNoQueue = new EmbedProcessor(
      db,
      mockLLM,
      mockVectorStore
    );

    insertPR(1);
    vi.mocked(mockLLM.embed).mockResolvedValue([makeVector(1)]);

    // Should not throw
    await processorNoQueue.process(makeJob());

    expect(mockVectorStore.upsert).toHaveBeenCalled();
  });
});
