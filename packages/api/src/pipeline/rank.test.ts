import { RankProcessor } from "./rank.js";
import { Database } from "../db/database.js";
import type { ChatProvider, BatchChatProvider } from "../services/llm-provider.js";
import type { Job } from "@ossgard/shared";

function createMockChat(): ChatProvider {
  return {
    chat: vi.fn().mockResolvedValue({
      response: { rankings: [] },
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
  };
}

function createMockBatchChat(): BatchChatProvider {
  return {
    batch: true as const,
    chat: vi.fn().mockResolvedValue({
      response: { rankings: [] },
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
    chatBatch: vi.fn().mockResolvedValue([]),
  };
}

const TEST_CONFIG = {
  github: { token: "ghp_test" },
  llm: { provider: "ollama", url: "http://localhost:11434", model: "llama3", api_key: "" },
  embedding: { provider: "ollama", url: "http://localhost:11434", model: "nomic-embed-text", api_key: "" },
  vector_store: { url: "http://localhost:6333", api_key: "" },
};

describe("RankProcessor", () => {
  let db: Database;
  let mockChat: ChatProvider;
  let processor: RankProcessor;
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

    mockChat = createMockChat();
    const mockResolver = {
      resolve: vi.fn().mockResolvedValue({ llm: mockChat }),
    };
    processor = new RankProcessor(db, mockResolver as any);
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

  function makeJob(
    verifiedGroups: Array<{
      prIds: number[];
      label: string;
      confidence: number;
      relationship: string;
    }>
  ): Job {
    return {
      id: "test-job-1",
      type: "rank",
      payload: {
        repoId,
        scanId,
        accountId,
        owner: "facebook",
        repo: "react",
        verifiedGroups,
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

  it("updates scan status to ranking", async () => {
    await processor.process(makeJob([]));

    // Status will be "done" at the end, but it was "ranking" during processing
    const scan = db.getScan(scanId);
    expect(scan!.status).toBe("done");
  });

  it("ranks PRs and stores results in the database", async () => {
    const pr1 = insertPR(1);
    const pr2 = insertPR(2);

    (mockChat.chat as any).mockResolvedValue({
      response: {
        rankings: [
          {
            prNumber: 1,
            score: 85,
            codeQuality: 45,
            completeness: 40,
            rationale: "Well-structured code with tests",
          },
          {
            prNumber: 2,
            score: 70,
            codeQuality: 35,
            completeness: 35,
            rationale: "Good but missing edge cases",
          },
        ],
      },
      usage: { inputTokens: 500, outputTokens: 100 },
    });

    await processor.process(
      makeJob([
        {
          prIds: [pr1.id, pr2.id],
          label: "Fix login bug",
          confidence: 0.95,
          relationship: "near_duplicate",
        },
      ])
    );

    // Check dupe_groups
    const groups = db.listDupeGroups(scanId);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Fix login bug");
    expect(groups[0].prCount).toBe(2);
    expect(groups[0].scanId).toBe(scanId);
    expect(groups[0].repoId).toBe(repoId);

    // Check dupe_group_members (sorted by score desc)
    const members = db.listDupeGroupMembers(groups[0].id);
    expect(members).toHaveLength(2);
    expect(members[0].rank).toBe(1);
    expect(members[0].prId).toBe(pr1.id);
    expect(members[0].score).toBe(85);
    expect(members[0].rationale).toBe("Well-structured code with tests");
    expect(members[1].rank).toBe(2);
    expect(members[1].prId).toBe(pr2.id);
    expect(members[1].score).toBe(70);
  });

  it("sorts rankings by score descending", async () => {
    const pr1 = insertPR(1);
    const pr2 = insertPR(2);

    // Return rankings in ascending order from LLM
    (mockChat.chat as any).mockResolvedValue({
      response: {
        rankings: [
          {
            prNumber: 2,
            score: 60,
            codeQuality: 30,
            completeness: 30,
            rationale: "Basic implementation",
          },
          {
            prNumber: 1,
            score: 90,
            codeQuality: 45,
            completeness: 45,
            rationale: "Excellent implementation",
          },
        ],
      },
      usage: { inputTokens: 400, outputTokens: 80 },
    });

    await processor.process(
      makeJob([
        {
          prIds: [pr1.id, pr2.id],
          label: "Feature X",
          confidence: 0.9,
          relationship: "exact_duplicate",
        },
      ])
    );

    const groups = db.listDupeGroups(scanId);
    const members = db.listDupeGroupMembers(groups[0].id);

    // PR 1 should be rank 1 (higher score)
    expect(members[0].rank).toBe(1);
    expect(members[0].prId).toBe(pr1.id);
    expect(members[0].score).toBe(90);

    expect(members[1].rank).toBe(2);
    expect(members[1].prId).toBe(pr2.id);
    expect(members[1].score).toBe(60);
  });

  it("marks scan as done with dupeGroupCount", async () => {
    const pr1 = insertPR(1);
    const pr2 = insertPR(2);
    const pr3 = insertPR(3);
    const pr4 = insertPR(4);

    (mockChat.chat as any).mockResolvedValue({
      response: {
        rankings: [
          { prNumber: 1, score: 80, codeQuality: 40, completeness: 40, rationale: "Good" },
          { prNumber: 2, score: 70, codeQuality: 35, completeness: 35, rationale: "OK" },
        ],
      },
      usage: { inputTokens: 300, outputTokens: 60 },
    });

    await processor.process(
      makeJob([
        {
          prIds: [pr1.id, pr2.id],
          label: "Group A",
          confidence: 0.9,
          relationship: "near_duplicate",
        },
        {
          prIds: [pr3.id, pr4.id],
          label: "Group B",
          confidence: 0.85,
          relationship: "exact_duplicate",
        },
      ])
    );

    const scan = db.getScan(scanId);
    expect(scan!.status).toBe("done");
    expect(scan!.dupeGroupCount).toBe(2);
    expect(scan!.completedAt).toBeTruthy();
  });

  it("handles multiple verified groups", async () => {
    const pr1 = insertPR(1);
    const pr2 = insertPR(2);
    const pr3 = insertPR(3);
    const pr4 = insertPR(4);

    (mockChat.chat as any)
      .mockResolvedValueOnce({
        response: {
          rankings: [
            { prNumber: 1, score: 80, codeQuality: 40, completeness: 40, rationale: "Good" },
            { prNumber: 2, score: 70, codeQuality: 35, completeness: 35, rationale: "OK" },
          ],
        },
        usage: { inputTokens: 300, outputTokens: 60 },
      })
      .mockResolvedValueOnce({
        response: {
          rankings: [
            { prNumber: 3, score: 90, codeQuality: 45, completeness: 45, rationale: "Excellent" },
            { prNumber: 4, score: 50, codeQuality: 25, completeness: 25, rationale: "Basic" },
          ],
        },
        usage: { inputTokens: 300, outputTokens: 60 },
      });

    await processor.process(
      makeJob([
        {
          prIds: [pr1.id, pr2.id],
          label: "Group A",
          confidence: 0.9,
          relationship: "near_duplicate",
        },
        {
          prIds: [pr3.id, pr4.id],
          label: "Group B",
          confidence: 0.85,
          relationship: "exact_duplicate",
        },
      ])
    );

    expect(mockChat.chat).toHaveBeenCalledTimes(2);

    const groups = db.listDupeGroups(scanId);
    expect(groups).toHaveLength(2);
    expect(groups[0].label).toBe("Group A");
    expect(groups[1].label).toBe("Group B");
  });

  it("sends correct prompt with group label", async () => {
    const pr1 = insertPR(1);
    const pr2 = insertPR(2);

    (mockChat.chat as any).mockResolvedValue({
      response: {
        rankings: [
          { prNumber: 1, score: 80, codeQuality: 40, completeness: 40, rationale: "Good" },
          { prNumber: 2, score: 70, codeQuality: 35, completeness: 35, rationale: "OK" },
        ],
      },
      usage: { inputTokens: 300, outputTokens: 60 },
    });

    await processor.process(
      makeJob([
        {
          prIds: [pr1.id, pr2.id],
          label: "Fix login bug",
          confidence: 0.95,
          relationship: "near_duplicate",
        },
      ])
    );

    const chatCall = (mockChat.chat as any).mock.calls[0][0];
    expect(chatCall[0].role).toBe("system");
    expect(chatCall[0].content).toContain("Fix login bug");
    expect(chatCall[1].role).toBe("user");
    expect(chatCall[1].content).toContain("PR #1");
    expect(chatCall[1].content).toContain("PR #2");
  });

  it("handles empty verifiedGroups", async () => {
    await processor.process(makeJob([]));

    const scan = db.getScan(scanId);
    expect(scan!.status).toBe("done");
    expect(scan!.dupeGroupCount).toBe(0);

    const groups = db.listDupeGroups(scanId);
    expect(groups).toHaveLength(0);
  });

  it("stores accumulated token usage on scan", async () => {
    const pr1 = insertPR(1);
    const pr2 = insertPR(2);
    const pr3 = insertPR(3);
    const pr4 = insertPR(4);

    (mockChat.chat as any)
      .mockResolvedValueOnce({
        response: {
          rankings: [
            { prNumber: 1, score: 80, codeQuality: 40, completeness: 40, rationale: "Good" },
            { prNumber: 2, score: 70, codeQuality: 35, completeness: 35, rationale: "OK" },
          ],
        },
        usage: { inputTokens: 400, outputTokens: 80 },
      })
      .mockResolvedValueOnce({
        response: {
          rankings: [
            { prNumber: 3, score: 90, codeQuality: 45, completeness: 45, rationale: "Excellent" },
            { prNumber: 4, score: 50, codeQuality: 25, completeness: 25, rationale: "Basic" },
          ],
        },
        usage: { inputTokens: 300, outputTokens: 60 },
      });

    await processor.process(
      makeJob([
        { prIds: [pr1.id, pr2.id], label: "Group A", confidence: 0.9, relationship: "near_duplicate" },
        { prIds: [pr3.id, pr4.id], label: "Group B", confidence: 0.85, relationship: "exact_duplicate" },
      ])
    );

    const scan = db.getScan(scanId);
    expect(scan!.inputTokens).toBe(700);
    expect(scan!.outputTokens).toBe(140);
  });

  it("updates repo last_scan_at after scan completes", async () => {
    await processor.process(makeJob([]));

    const repo = db.getRepo(repoId);
    expect(repo).not.toBeNull();
    expect(repo!.lastScanAt).toBeTruthy();
    // Verify it's a valid ISO timestamp
    expect(new Date(repo!.lastScanAt!).toISOString()).toBe(repo!.lastScanAt);
  });

  it("skips groups where fewer than 2 PRs are found", async () => {
    const pr1 = insertPR(1);
    // pr2 doesn't exist in DB

    await processor.process(
      makeJob([
        {
          prIds: [pr1.id, 9999],
          label: "Broken group",
          confidence: 0.9,
          relationship: "near_duplicate",
        },
      ])
    );

    // LLM should not be called
    expect(mockChat.chat).not.toHaveBeenCalled();

    const groups = db.listDupeGroups(scanId);
    expect(groups).toHaveLength(0);
  });

  describe("batch path", () => {
    let batchChat: BatchChatProvider;
    let batchProcessor: RankProcessor;

    beforeEach(() => {
      batchChat = createMockBatchChat();
      const batchResolver = {
        resolve: vi.fn().mockResolvedValue({ llm: batchChat }),
      };
      batchProcessor = new RankProcessor(db, batchResolver as any);
    });

    it("uses chatBatch when provider is batch and multiple groups exist", async () => {
      const pr1 = insertPR(1);
      const pr2 = insertPR(2);
      const pr3 = insertPR(3);
      const pr4 = insertPR(4);

      (batchChat.chatBatch as any).mockResolvedValue([
        {
          id: "rank-0",
          response: {
            rankings: [
              { prNumber: 1, score: 85, codeQuality: 45, completeness: 40, rationale: "Good" },
              { prNumber: 2, score: 70, codeQuality: 35, completeness: 35, rationale: "OK" },
            ],
          },
          usage: { inputTokens: 400, outputTokens: 80 },
        },
        {
          id: "rank-1",
          response: {
            rankings: [
              { prNumber: 3, score: 90, codeQuality: 45, completeness: 45, rationale: "Excellent" },
              { prNumber: 4, score: 50, codeQuality: 25, completeness: 25, rationale: "Basic" },
            ],
          },
          usage: { inputTokens: 400, outputTokens: 80 },
        },
      ]);

      await batchProcessor.process(
        makeJob([
          { prIds: [pr1.id, pr2.id], label: "Group A", confidence: 0.9, relationship: "near_duplicate" },
          { prIds: [pr3.id, pr4.id], label: "Group B", confidence: 0.85, relationship: "exact_duplicate" },
        ])
      );

      expect(batchChat.chatBatch).toHaveBeenCalledTimes(1);
      expect(batchChat.chat).not.toHaveBeenCalled();

      const groups = db.listDupeGroups(scanId);
      expect(groups).toHaveLength(2);
      expect(groups[0].label).toBe("Group A");
      expect(groups[1].label).toBe("Group B");

      // Verify rankings stored correctly
      const membersA = db.listDupeGroupMembers(groups[0].id);
      expect(membersA[0].score).toBe(85);
      expect(membersA[1].score).toBe(70);
    });

    it("falls back to sequential chat when only one group", async () => {
      const pr1 = insertPR(1);
      const pr2 = insertPR(2);

      (batchChat.chat as any).mockResolvedValue({
        response: {
          rankings: [
            { prNumber: 1, score: 80, codeQuality: 40, completeness: 40, rationale: "Good" },
            { prNumber: 2, score: 60, codeQuality: 30, completeness: 30, rationale: "Fair" },
          ],
        },
        usage: { inputTokens: 300, outputTokens: 60 },
      });

      await batchProcessor.process(
        makeJob([
          { prIds: [pr1.id, pr2.id], label: "Solo", confidence: 0.9, relationship: "near_duplicate" },
        ])
      );

      expect(batchChat.chat).toHaveBeenCalledTimes(1);
      expect(batchChat.chatBatch).not.toHaveBeenCalled();

      const groups = db.listDupeGroups(scanId);
      expect(groups).toHaveLength(1);
    });
  });
});
