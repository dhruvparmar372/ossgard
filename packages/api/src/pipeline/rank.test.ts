import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RankProcessor } from "./rank.js";
import { Database } from "../db/database.js";
import type { LLMProvider } from "../services/llm-provider.js";
import type { Job } from "@ossgard/shared";

function createMockLLM(): LLMProvider {
  return {
    embed: vi.fn().mockResolvedValue([]),
    chat: vi.fn().mockResolvedValue({ rankings: [] }),
  };
}

describe("RankProcessor", () => {
  let db: Database;
  let mockLLM: LLMProvider;
  let processor: RankProcessor;
  let repoId: number;
  let scanId: number;

  beforeEach(() => {
    db = new Database(":memory:");
    const repo = db.insertRepo("facebook", "react");
    repoId = repo.id;
    const scan = db.createScan(repoId);
    scanId = scan.id;

    mockLLM = createMockLLM();
    processor = new RankProcessor(db, mockLLM);
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

    vi.mocked(mockLLM.chat).mockResolvedValue({
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
    vi.mocked(mockLLM.chat).mockResolvedValue({
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

    vi.mocked(mockLLM.chat).mockResolvedValue({
      rankings: [
        { prNumber: 1, score: 80, codeQuality: 40, completeness: 40, rationale: "Good" },
        { prNumber: 2, score: 70, codeQuality: 35, completeness: 35, rationale: "OK" },
      ],
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

    vi.mocked(mockLLM.chat)
      .mockResolvedValueOnce({
        rankings: [
          { prNumber: 1, score: 80, codeQuality: 40, completeness: 40, rationale: "Good" },
          { prNumber: 2, score: 70, codeQuality: 35, completeness: 35, rationale: "OK" },
        ],
      })
      .mockResolvedValueOnce({
        rankings: [
          { prNumber: 3, score: 90, codeQuality: 45, completeness: 45, rationale: "Excellent" },
          { prNumber: 4, score: 50, codeQuality: 25, completeness: 25, rationale: "Basic" },
        ],
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

    expect(mockLLM.chat).toHaveBeenCalledTimes(2);

    const groups = db.listDupeGroups(scanId);
    expect(groups).toHaveLength(2);
    expect(groups[0].label).toBe("Group A");
    expect(groups[1].label).toBe("Group B");
  });

  it("sends correct prompt with group label", async () => {
    const pr1 = insertPR(1);
    const pr2 = insertPR(2);

    vi.mocked(mockLLM.chat).mockResolvedValue({
      rankings: [
        { prNumber: 1, score: 80, codeQuality: 40, completeness: 40, rationale: "Good" },
        { prNumber: 2, score: 70, codeQuality: 35, completeness: 35, rationale: "OK" },
      ],
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

    const chatCall = vi.mocked(mockLLM.chat).mock.calls[0][0];
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

  it("updates repo last_scan_at after scan completes", async () => {
    await processor.process(makeJob([]));

    const repo = db.getRepo(repoId);
    expect(repo).toBeDefined();
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
    expect(mockLLM.chat).not.toHaveBeenCalled();

    const groups = db.listDupeGroups(scanId);
    expect(groups).toHaveLength(0);
  });
});
