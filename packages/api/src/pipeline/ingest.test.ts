import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { IngestProcessor } from "./ingest.js";
import { Database } from "../db/database.js";
import type { GitHubClient, FetchedPR } from "../services/github-client.js";
import type { JobQueue } from "../queue/types.js";
import type { Job } from "@ossgard/shared";
import { hashDiff } from "./normalize-diff.js";

function makeFetchedPR(n: number): FetchedPR {
  return {
    number: n,
    title: `PR #${n}`,
    body: `Body of PR #${n}`,
    author: `author${n}`,
    state: "open",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-02T00:00:00Z",
  };
}

function makeDiff(prNumber: number): string {
  return `diff --git a/file${prNumber}.ts b/file${prNumber}.ts
index abc..def 100644
--- a/file${prNumber}.ts
+++ b/file${prNumber}.ts
@@ -1,1 +1,2 @@
+change in PR ${prNumber}
`;
}

describe("IngestProcessor", () => {
  let db: Database;
  let mockGitHub: GitHubClient;
  let mockQueue: JobQueue;
  let processor: IngestProcessor;
  let repoId: number;
  let scanId: number;

  beforeEach(() => {
    db = new Database(":memory:");
    const repo = db.insertRepo("facebook", "react");
    repoId = repo.id;
    const scan = db.createScan(repoId);
    scanId = scan.id;

    mockGitHub = {
      listOpenPRs: vi.fn<GitHubClient["listOpenPRs"]>(),
      getPRFiles: vi.fn<GitHubClient["getPRFiles"]>(),
      getPRDiff: vi.fn<GitHubClient["getPRDiff"]>(),
      rateLimitRemaining: 5000,
      rateLimitReset: 0,
    } as unknown as GitHubClient;

    mockQueue = {
      enqueue: vi.fn<JobQueue["enqueue"]>().mockResolvedValue("job-123"),
      getStatus: vi.fn(),
      dequeue: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
      pause: vi.fn(),
    };

    processor = new IngestProcessor(db, mockGitHub, mockQueue);
  });

  afterEach(() => {
    db.close();
  });

  function makeJob(): Job {
    return {
      id: "test-job-1",
      type: "ingest",
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

  it("fetches PRs and stores them in the database", async () => {
    const prs = [makeFetchedPR(1), makeFetchedPR(2)];
    vi.mocked(mockGitHub.listOpenPRs).mockResolvedValue(prs);
    vi.mocked(mockGitHub.getPRFiles).mockResolvedValue([
      "src/index.ts",
      "src/utils.ts",
    ]);
    vi.mocked(mockGitHub.getPRDiff)
      .mockResolvedValueOnce({ diff: makeDiff(1), etag: '"etag1"' })
      .mockResolvedValueOnce({ diff: makeDiff(2), etag: '"etag2"' });

    await processor.process(makeJob());

    // Verify PRs were stored
    const storedPRs = db.listOpenPRs(repoId);
    expect(storedPRs).toHaveLength(2);
    expect(storedPRs[0].number).toBe(1);
    expect(storedPRs[0].title).toBe("PR #1");
    expect(storedPRs[0].author).toBe("author1");
    expect(storedPRs[0].filePaths).toEqual(["src/index.ts", "src/utils.ts"]);
    expect(storedPRs[1].number).toBe(2);
  });

  it("computes diff hashes correctly", async () => {
    const prs = [makeFetchedPR(1)];
    const diff = makeDiff(1);
    vi.mocked(mockGitHub.listOpenPRs).mockResolvedValue(prs);
    vi.mocked(mockGitHub.getPRFiles).mockResolvedValue(["file1.ts"]);
    vi.mocked(mockGitHub.getPRDiff).mockResolvedValue({ diff, etag: '"etag1"' });

    await processor.process(makeJob());

    const storedPR = db.getPRByNumber(repoId, 1);
    expect(storedPR).toBeDefined();
    expect(storedPR!.diffHash).toBe(hashDiff(diff));
    expect(storedPR!.diffHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("enqueues embed job after completion", async () => {
    vi.mocked(mockGitHub.listOpenPRs).mockResolvedValue([makeFetchedPR(1)]);
    vi.mocked(mockGitHub.getPRFiles).mockResolvedValue(["file.ts"]);
    vi.mocked(mockGitHub.getPRDiff).mockResolvedValue({ diff: makeDiff(1), etag: '"etag1"' });

    await processor.process(makeJob());

    expect(mockQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(mockQueue.enqueue).toHaveBeenCalledWith({
      type: "embed",
      payload: { repoId, scanId, owner: "facebook", repo: "react" },
    });
  });

  it("updates scan status to ingesting", async () => {
    vi.mocked(mockGitHub.listOpenPRs).mockResolvedValue([]);

    await processor.process(makeJob());

    const scan = db.getScan(scanId);
    expect(scan!.status).toBe("ingesting");
  });

  it("updates scan prCount", async () => {
    const prs = [makeFetchedPR(1), makeFetchedPR(2), makeFetchedPR(3)];
    vi.mocked(mockGitHub.listOpenPRs).mockResolvedValue(prs);
    vi.mocked(mockGitHub.getPRFiles).mockResolvedValue([]);
    vi.mocked(mockGitHub.getPRDiff).mockResolvedValue({ diff: makeDiff(1), etag: null });

    await processor.process(makeJob());

    const scan = db.getScan(scanId);
    expect(scan!.prCount).toBe(3);
  });

  it("calls GitHub API with correct owner and repo", async () => {
    vi.mocked(mockGitHub.listOpenPRs).mockResolvedValue([]);

    await processor.process(makeJob());

    expect(mockGitHub.listOpenPRs).toHaveBeenCalledWith("facebook", "react", undefined);
  });

  it("passes maxPrs to listOpenPRs when present", async () => {
    vi.mocked(mockGitHub.listOpenPRs).mockResolvedValue([makeFetchedPR(1)]);
    vi.mocked(mockGitHub.getPRFiles).mockResolvedValue([]);
    vi.mocked(mockGitHub.getPRDiff).mockResolvedValue({ diff: makeDiff(1), etag: null });

    const job: Job = {
      ...makeJob(),
      payload: { repoId, scanId, owner: "facebook", repo: "react", maxPrs: 5 },
    };

    await processor.process(job);

    expect(mockGitHub.listOpenPRs).toHaveBeenCalledWith("facebook", "react", 5);
  });

  it("calls getPRFiles and getPRDiff for each PR", async () => {
    const prs = [makeFetchedPR(10), makeFetchedPR(20)];
    vi.mocked(mockGitHub.listOpenPRs).mockResolvedValue(prs);
    vi.mocked(mockGitHub.getPRFiles).mockResolvedValue([]);
    vi.mocked(mockGitHub.getPRDiff).mockResolvedValue({ diff: makeDiff(1), etag: null });

    await processor.process(makeJob());

    expect(mockGitHub.getPRFiles).toHaveBeenCalledTimes(2);
    expect(mockGitHub.getPRFiles).toHaveBeenCalledWith("facebook", "react", 10);
    expect(mockGitHub.getPRFiles).toHaveBeenCalledWith("facebook", "react", 20);
    expect(mockGitHub.getPRDiff).toHaveBeenCalledTimes(2);
    expect(mockGitHub.getPRDiff).toHaveBeenCalledWith("facebook", "react", 10, null);
    expect(mockGitHub.getPRDiff).toHaveBeenCalledWith("facebook", "react", 20, null);
  });
});
