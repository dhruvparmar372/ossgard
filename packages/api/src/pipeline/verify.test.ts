import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VerifyProcessor } from "./verify.js";
import { Database } from "../db/database.js";
import type { LLMProvider } from "../services/llm-provider.js";
import type { JobQueue } from "../queue/types.js";
import type { Job } from "@ossgard/shared";

function createMockLLM(): LLMProvider {
  return {
    embed: vi.fn().mockResolvedValue([]),
    chat: vi.fn().mockResolvedValue({ groups: [], unrelated: [] }),
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

describe("VerifyProcessor", () => {
  let db: Database;
  let mockLLM: LLMProvider;
  let mockQueue: JobQueue;
  let processor: VerifyProcessor;
  let repoId: number;
  let scanId: number;

  beforeEach(() => {
    db = new Database(":memory:");
    const repo = db.insertRepo("facebook", "react");
    repoId = repo.id;
    const scan = db.createScan(repoId);
    scanId = scan.id;

    mockLLM = createMockLLM();
    mockQueue = createMockQueue();
    processor = new VerifyProcessor(db, mockLLM, mockQueue);
  });

  afterEach(() => {
    db.close();
  });

  function insertPR(number: number) {
    return db.upsertPR({
      repoId,
      number,
      title: `PR #${number}`,
      body: `Body of PR #${number}`,
      author: `author${number}`,
      diffHash: `hash${number}`,
      filePaths: [`src/file${number}.ts`],
      state: "open",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-02T00:00:00Z",
    });
  }

  function makeJob(candidateGroups: Array<{ prNumbers: number[]; prIds: number[] }>): Job {
    return {
      id: "test-job-1",
      type: "verify",
      payload: {
        repoId,
        scanId,
        owner: "facebook",
        repo: "react",
        candidateGroups,
      },
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

  it("updates scan status to verifying", async () => {
    await processor.process(makeJob([]));

    const scan = db.getScan(scanId);
    expect(scan!.status).toBe("verifying");
  });

  it("verifies groups via LLM and collects verified groups", async () => {
    const pr1 = insertPR(1);
    const pr2 = insertPR(2);

    vi.mocked(mockLLM.chat).mockResolvedValue({
      groups: [
        {
          prIds: [pr1.id, pr2.id],
          label: "Fix login bug",
          confidence: 0.95,
          relationship: "near_duplicate",
        },
      ],
      unrelated: [],
    });

    await processor.process(
      makeJob([{ prNumbers: [1, 2], prIds: [pr1.id, pr2.id] }])
    );

    expect(mockLLM.chat).toHaveBeenCalledTimes(1);

    const enqueueCall = vi.mocked(mockQueue.enqueue).mock.calls[0][0];
    expect(enqueueCall.type).toBe("rank");

    const verifiedGroups = (
      enqueueCall.payload as {
        verifiedGroups: Array<{
          prIds: number[];
          label: string;
          confidence: number;
          relationship: string;
        }>;
      }
    ).verifiedGroups;

    expect(verifiedGroups).toHaveLength(1);
    expect(verifiedGroups[0]).toEqual({
      prIds: [pr1.id, pr2.id],
      label: "Fix login bug",
      confidence: 0.95,
      relationship: "near_duplicate",
    });
  });

  it("filters false positives (LLM returns group with < 2 PRs)", async () => {
    const pr1 = insertPR(1);
    const pr2 = insertPR(2);

    vi.mocked(mockLLM.chat).mockResolvedValue({
      groups: [
        {
          prIds: [pr1.id], // Only 1 PR - should be filtered
          label: "Solo PR",
          confidence: 0.5,
          relationship: "related",
        },
      ],
      unrelated: [pr2.id],
    });

    await processor.process(
      makeJob([{ prNumbers: [1, 2], prIds: [pr1.id, pr2.id] }])
    );

    const enqueueCall = vi.mocked(mockQueue.enqueue).mock.calls[0][0];
    const verifiedGroups = (
      enqueueCall.payload as { verifiedGroups: unknown[] }
    ).verifiedGroups;

    expect(verifiedGroups).toHaveLength(0);
  });

  it("processes multiple candidate groups", async () => {
    const pr1 = insertPR(1);
    const pr2 = insertPR(2);
    const pr3 = insertPR(3);
    const pr4 = insertPR(4);

    vi.mocked(mockLLM.chat)
      .mockResolvedValueOnce({
        groups: [
          {
            prIds: [pr1.id, pr2.id],
            label: "Group A",
            confidence: 0.9,
            relationship: "exact_duplicate",
          },
        ],
        unrelated: [],
      })
      .mockResolvedValueOnce({
        groups: [
          {
            prIds: [pr3.id, pr4.id],
            label: "Group B",
            confidence: 0.85,
            relationship: "near_duplicate",
          },
        ],
        unrelated: [],
      });

    await processor.process(
      makeJob([
        { prNumbers: [1, 2], prIds: [pr1.id, pr2.id] },
        { prNumbers: [3, 4], prIds: [pr3.id, pr4.id] },
      ])
    );

    expect(mockLLM.chat).toHaveBeenCalledTimes(2);

    const enqueueCall = vi.mocked(mockQueue.enqueue).mock.calls[0][0];
    const verifiedGroups = (
      enqueueCall.payload as {
        verifiedGroups: Array<{ prIds: number[]; label: string }>;
      }
    ).verifiedGroups;

    expect(verifiedGroups).toHaveLength(2);
    expect(verifiedGroups[0].label).toBe("Group A");
    expect(verifiedGroups[1].label).toBe("Group B");
  });

  it("enqueues rank job with correct payload", async () => {
    await processor.process(makeJob([]));

    expect(mockQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(mockQueue.enqueue).toHaveBeenCalledWith({
      type: "rank",
      payload: {
        repoId,
        scanId,
        owner: "facebook",
        repo: "react",
        verifiedGroups: [],
      },
    });
  });

  it("sends PR data in the LLM prompt", async () => {
    const pr1 = insertPR(1);
    const pr2 = insertPR(2);

    vi.mocked(mockLLM.chat).mockResolvedValue({
      groups: [],
      unrelated: [pr1.id, pr2.id],
    });

    await processor.process(
      makeJob([{ prNumbers: [1, 2], prIds: [pr1.id, pr2.id] }])
    );

    // Verify the LLM was called with messages containing PR data
    const chatCall = vi.mocked(mockLLM.chat).mock.calls[0][0];
    expect(chatCall).toHaveLength(2); // system + user
    expect(chatCall[0].role).toBe("system");
    expect(chatCall[1].role).toBe("user");
    expect(chatCall[1].content).toContain("PR #1");
    expect(chatCall[1].content).toContain("PR #2");
  });

  it("skips candidate groups with fewer than 2 PRs found", async () => {
    // Only insert PR 1, PR 2 doesn't exist in DB
    insertPR(1);

    await processor.process(
      makeJob([{ prNumbers: [1, 2], prIds: [1, 999] }])
    );

    // Should not call LLM since only 1 PR was found
    expect(mockLLM.chat).not.toHaveBeenCalled();
  });
});
