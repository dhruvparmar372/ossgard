import { IngestProcessor } from "./ingest.js";
import { Database } from "../db/database.js";
import type { GitHubClient, FetchedPR } from "../services/github-client.js";
import { DiffTooLargeError } from "../services/github-client.js";
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

const TEST_CONFIG = {
  github: { token: "ghp_test" },
  llm: { provider: "ollama", url: "http://localhost:11434", model: "llama3", api_key: "" },
  embedding: { provider: "ollama", url: "http://localhost:11434", model: "nomic-embed-text", api_key: "" },
  vector_store: { url: "http://localhost:6333", api_key: "" },
};

describe("IngestProcessor", () => {
  let db: Database;
  let mockGitHub: GitHubClient;
  let mockQueue: JobQueue;
  let processor: IngestProcessor;
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

    mockGitHub = {
      listOpenPRs: vi.fn(),
      getPRFiles: vi.fn(),
      getPRDiff: vi.fn(),
      rateLimitRemaining: 5000,
      rateLimitReset: 0,
    } as unknown as GitHubClient;

    const mockResolver = {
      resolve: vi.fn().mockResolvedValue({ github: mockGitHub }),
    } as any;

    mockQueue = {
      enqueue: vi.fn().mockResolvedValue("job-123"),
      getStatus: vi.fn(),
      dequeue: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
      pause: vi.fn(),
    };

    processor = new IngestProcessor(db, mockResolver, mockQueue);
  });

  afterEach(() => {
    db.close();
  });

  function makeJob(): Job {
    return {
      id: "test-job-1",
      type: "ingest",
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

  it("fetches PRs and stores them in the database", async () => {
    const prs = [makeFetchedPR(1), makeFetchedPR(2)];
    (mockGitHub.listOpenPRs as any).mockResolvedValue(prs);
    (mockGitHub.getPRFiles as any).mockResolvedValue([
      "src/index.ts",
      "src/utils.ts",
    ]);
    (mockGitHub.getPRDiff as any)
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
    (mockGitHub.listOpenPRs as any).mockResolvedValue(prs);
    (mockGitHub.getPRFiles as any).mockResolvedValue(["file1.ts"]);
    (mockGitHub.getPRDiff as any).mockResolvedValue({ diff, etag: '"etag1"' });

    await processor.process(makeJob());

    const storedPR = db.getPRByNumber(repoId, 1);
    expect(storedPR).not.toBeNull();
    expect(storedPR!.diffHash).toBe(hashDiff(diff));
    expect(storedPR!.diffHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("enqueues detect job after completion", async () => {
    (mockGitHub.listOpenPRs as any).mockResolvedValue([makeFetchedPR(1)]);
    (mockGitHub.getPRFiles as any).mockResolvedValue(["file.ts"]);
    (mockGitHub.getPRDiff as any).mockResolvedValue({ diff: makeDiff(1), etag: '"etag1"' });

    await processor.process(makeJob());

    expect(mockQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(mockQueue.enqueue).toHaveBeenCalledWith({
      type: "detect",
      payload: { repoId, scanId, accountId, owner: "facebook", repo: "react", prNumbers: [1] },
    });
  });

  it("updates scan status to ingesting", async () => {
    (mockGitHub.listOpenPRs as any).mockResolvedValue([]);

    await processor.process(makeJob());

    const scan = db.getScan(scanId);
    expect(scan!.status).toBe("ingesting");
  });

  it("updates scan prCount", async () => {
    const prs = [makeFetchedPR(1), makeFetchedPR(2), makeFetchedPR(3)];
    (mockGitHub.listOpenPRs as any).mockResolvedValue(prs);
    (mockGitHub.getPRFiles as any).mockResolvedValue([]);
    (mockGitHub.getPRDiff as any).mockResolvedValue({ diff: makeDiff(1), etag: null });

    await processor.process(makeJob());

    const scan = db.getScan(scanId);
    expect(scan!.prCount).toBe(3);
  });

  it("calls GitHub API with correct owner and repo", async () => {
    (mockGitHub.listOpenPRs as any).mockResolvedValue([]);

    await processor.process(makeJob());

    expect(mockGitHub.listOpenPRs).toHaveBeenCalledWith("facebook", "react", undefined, undefined);
  });

  it("passes maxPrs to listOpenPRs when present", async () => {
    (mockGitHub.listOpenPRs as any).mockResolvedValue([makeFetchedPR(1)]);
    (mockGitHub.getPRFiles as any).mockResolvedValue([]);
    (mockGitHub.getPRDiff as any).mockResolvedValue({ diff: makeDiff(1), etag: null });

    const job: Job = {
      ...makeJob(),
      payload: { repoId, scanId, accountId, owner: "facebook", repo: "react", maxPrs: 5 },
    };

    await processor.process(job);

    expect(mockGitHub.listOpenPRs).toHaveBeenCalledWith("facebook", "react", 5, undefined);
  });

  it("passes lastScanAt to listOpenPRs when present", async () => {
    (mockGitHub.listOpenPRs as any).mockResolvedValue([]);

    const job: Job = {
      ...makeJob(),
      payload: { repoId, scanId, accountId, owner: "facebook", repo: "react", lastScanAt: "2025-06-01T00:00:00Z" },
    };

    await processor.process(job);

    expect(mockGitHub.listOpenPRs).toHaveBeenCalledWith("facebook", "react", undefined, "2025-06-01T00:00:00Z");
  });

  it("sends all DB open PRs to detect job on incremental ingest", async () => {
    // First ingest: store PR 1 and PR 2 in DB
    const prs = [makeFetchedPR(1), makeFetchedPR(2)];
    (mockGitHub.listOpenPRs as any).mockResolvedValue(prs);
    (mockGitHub.getPRFiles as any).mockResolvedValue(["src/index.ts"]);
    (mockGitHub.getPRDiff as any)
      .mockResolvedValueOnce({ diff: makeDiff(1), etag: '"etag1"' })
      .mockResolvedValueOnce({ diff: makeDiff(2), etag: '"etag2"' });

    await processor.process(makeJob());

    // Second (incremental) ingest: only PR 3 is fetched (new since last scan)
    const newPR = makeFetchedPR(3);
    (mockGitHub.listOpenPRs as any).mockResolvedValue([newPR]);
    (mockGitHub.getPRFiles as any).mockClear().mockResolvedValue(["src/new.ts"]);
    (mockGitHub.getPRDiff as any).mockClear().mockResolvedValue({ diff: makeDiff(3), etag: '"etag3"' });
    (mockQueue.enqueue as any).mockClear();

    const incrementalJob: Job = {
      ...makeJob(),
      payload: { repoId, scanId, accountId, owner: "facebook", repo: "react", lastScanAt: "2025-01-01T00:00:00Z" },
    };

    await processor.process(incrementalJob);

    // Detect job should receive all 3 open PRs from DB, not just the 1 fetched
    const detectCall = (mockQueue.enqueue as any).mock.calls[0][0];
    expect(detectCall.type).toBe("detect");
    expect(detectCall.payload.prNumbers).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(detectCall.payload.prNumbers).toHaveLength(3);
  });

  it("calls getPRFiles and getPRDiff for each PR", async () => {
    const prs = [makeFetchedPR(10), makeFetchedPR(20)];
    (mockGitHub.listOpenPRs as any).mockResolvedValue(prs);
    (mockGitHub.getPRFiles as any).mockResolvedValue([]);
    (mockGitHub.getPRDiff as any).mockResolvedValue({ diff: makeDiff(1), etag: null });

    await processor.process(makeJob());

    expect(mockGitHub.getPRFiles).toHaveBeenCalledTimes(2);
    expect(mockGitHub.getPRFiles).toHaveBeenCalledWith("facebook", "react", 10);
    expect(mockGitHub.getPRFiles).toHaveBeenCalledWith("facebook", "react", 20);
    expect(mockGitHub.getPRDiff).toHaveBeenCalledTimes(2);
    expect(mockGitHub.getPRDiff).toHaveBeenCalledWith("facebook", "react", 10, null);
    expect(mockGitHub.getPRDiff).toHaveBeenCalledWith("facebook", "react", 20, null);
  });

  it("skips PRs that have not changed since last ingest", async () => {
    // First ingest: PR 1 and PR 2
    const prs = [makeFetchedPR(1), makeFetchedPR(2)];
    (mockGitHub.listOpenPRs as any).mockResolvedValue(prs);
    (mockGitHub.getPRFiles as any).mockResolvedValue(["src/index.ts"]);
    (mockGitHub.getPRDiff as any)
      .mockResolvedValueOnce({ diff: makeDiff(1), etag: '"etag1"' })
      .mockResolvedValueOnce({ diff: makeDiff(2), etag: '"etag2"' });

    await processor.process(makeJob());

    expect(mockGitHub.getPRFiles).toHaveBeenCalledTimes(2);
    expect(mockGitHub.getPRDiff).toHaveBeenCalledTimes(2);

    // Second ingest: same PRs with same updatedAt — should skip both
    (mockGitHub.listOpenPRs as any).mockResolvedValue(prs);
    (mockGitHub.getPRFiles as any).mockClear();
    (mockGitHub.getPRDiff as any).mockClear();

    await processor.process(makeJob());

    expect(mockGitHub.getPRFiles).not.toHaveBeenCalled();
    expect(mockGitHub.getPRDiff).not.toHaveBeenCalled();
  });

  it("re-fetches PRs whose updatedAt has changed", async () => {
    // First ingest
    const prs = [makeFetchedPR(1)];
    (mockGitHub.listOpenPRs as any).mockResolvedValue(prs);
    (mockGitHub.getPRFiles as any).mockResolvedValue(["src/index.ts"]);
    (mockGitHub.getPRDiff as any).mockResolvedValue({ diff: makeDiff(1), etag: '"etag1"' });

    await processor.process(makeJob());

    // Second ingest: PR 1 has a newer updatedAt
    const updatedPR = { ...makeFetchedPR(1), updatedAt: "2025-01-03T00:00:00Z" };
    (mockGitHub.listOpenPRs as any).mockResolvedValue([updatedPR]);
    (mockGitHub.getPRFiles as any).mockClear().mockResolvedValue(["src/index.ts", "src/new.ts"]);
    (mockGitHub.getPRDiff as any).mockClear().mockResolvedValue({ diff: makeDiff(1), etag: '"etag1-v2"' });

    await processor.process(makeJob());

    expect(mockGitHub.getPRFiles).toHaveBeenCalledTimes(1);
    expect(mockGitHub.getPRDiff).toHaveBeenCalledTimes(1);

    const storedPR = db.getPRByNumber(repoId, 1);
    expect(storedPR!.filePaths).toEqual(["src/index.ts", "src/new.ts"]);
  });

  it("marks stale DB PRs as closed during full ingest", async () => {
    // First: seed DB with PRs 1, 2, 3 (all open)
    const prs = [makeFetchedPR(1), makeFetchedPR(2), makeFetchedPR(3)];
    (mockGitHub.listOpenPRs as any).mockResolvedValue(prs);
    (mockGitHub.getPRFiles as any).mockResolvedValue(["src/index.ts"]);
    (mockGitHub.getPRDiff as any).mockResolvedValue({ diff: makeDiff(1), etag: null });

    await processor.process(makeJob());

    expect(db.listOpenPRs(repoId)).toHaveLength(3);

    // Second full ingest: only PR 1 and PR 3 are still open on GitHub
    const fullIngestPRs = [makeFetchedPR(1), makeFetchedPR(3)];
    (mockGitHub.listOpenPRs as any).mockResolvedValue(fullIngestPRs);
    (mockGitHub.getPRFiles as any).mockClear().mockResolvedValue(["src/index.ts"]);
    (mockGitHub.getPRDiff as any).mockClear().mockResolvedValue({ diff: makeDiff(1), etag: null });
    (mockQueue.enqueue as any).mockClear();

    // Full ingest (no lastScanAt)
    await processor.process(makeJob());

    // PR 2 should now be marked as closed
    const openPRs = db.listOpenPRs(repoId);
    expect(openPRs).toHaveLength(2);
    expect(openPRs.map((p) => p.number).sort()).toEqual([1, 3]);

    const pr2 = db.getPRByNumber(repoId, 2);
    expect(pr2!.state).toBe("closed");

    // Detect job should only include the 2 open PRs
    const detectCall = (mockQueue.enqueue as any).mock.calls[0][0];
    expect(detectCall.payload.prNumbers).toEqual([1, 3]);
  });

  it("does not mark stale PRs during incremental ingest", async () => {
    // Seed DB with PRs 1, 2
    const prs = [makeFetchedPR(1), makeFetchedPR(2)];
    (mockGitHub.listOpenPRs as any).mockResolvedValue(prs);
    (mockGitHub.getPRFiles as any).mockResolvedValue(["src/index.ts"]);
    (mockGitHub.getPRDiff as any).mockResolvedValue({ diff: makeDiff(1), etag: null });

    await processor.process(makeJob());

    expect(db.listOpenPRs(repoId)).toHaveLength(2);

    // Incremental ingest: only fetches PR 3 (new)
    (mockGitHub.listOpenPRs as any).mockResolvedValue([makeFetchedPR(3)]);
    (mockGitHub.getPRFiles as any).mockClear().mockResolvedValue(["src/new.ts"]);
    (mockGitHub.getPRDiff as any).mockClear().mockResolvedValue({ diff: makeDiff(3), etag: null });
    (mockQueue.enqueue as any).mockClear();

    const incrementalJob: Job = {
      ...makeJob(),
      payload: { repoId, scanId, accountId, owner: "facebook", repo: "react", lastScanAt: "2025-01-01T00:00:00Z" },
    };

    await processor.process(incrementalJob);

    // All 3 PRs should still be open — no stale reconciliation on incremental
    const openPRs = db.listOpenPRs(repoId);
    expect(openPRs).toHaveLength(3);
  });

  it("upserts closed/merged PRs from incremental ingest with correct state", async () => {
    // Seed DB with open PRs 1 and 2
    const prs = [makeFetchedPR(1), makeFetchedPR(2)];
    (mockGitHub.listOpenPRs as any).mockResolvedValue(prs);
    (mockGitHub.getPRFiles as any).mockResolvedValue(["src/index.ts"]);
    (mockGitHub.getPRDiff as any).mockResolvedValue({ diff: makeDiff(1), etag: null });

    await processor.process(makeJob());

    // Incremental ingest: PR 2 was closed, PR 3 was merged
    const closedPR: FetchedPR = { ...makeFetchedPR(2), state: "closed", updatedAt: "2025-01-03T00:00:00Z" };
    const mergedPR: FetchedPR = { ...makeFetchedPR(3), state: "merged", updatedAt: "2025-01-03T00:00:00Z" };
    (mockGitHub.listOpenPRs as any).mockResolvedValue([closedPR, mergedPR]);
    (mockGitHub.getPRFiles as any).mockClear().mockResolvedValue(["src/index.ts"]);
    (mockGitHub.getPRDiff as any).mockClear().mockResolvedValue({ diff: makeDiff(2), etag: null });
    (mockQueue.enqueue as any).mockClear();

    const incrementalJob: Job = {
      ...makeJob(),
      payload: { repoId, scanId, accountId, owner: "facebook", repo: "react", lastScanAt: "2025-01-01T00:00:00Z" },
    };

    await processor.process(incrementalJob);

    // PR 2 should be closed, PR 3 should be merged
    const pr2 = db.getPRByNumber(repoId, 2);
    expect(pr2!.state).toBe("closed");

    const pr3 = db.getPRByNumber(repoId, 3);
    expect(pr3!.state).toBe("merged");

    // Only PR 1 should be open — detect should only include it
    const openPRs = db.listOpenPRs(repoId);
    expect(openPRs).toHaveLength(1);
    expect(openPRs[0].number).toBe(1);
  });

  it("continues ingesting when a PR diff is too large", async () => {
    const prs = [makeFetchedPR(1), makeFetchedPR(2)];
    (mockGitHub.listOpenPRs as any).mockResolvedValue(prs);
    (mockGitHub.getPRFiles as any).mockResolvedValue(["src/index.ts"]);
    (mockGitHub.getPRDiff as any)
      .mockRejectedValueOnce(new DiffTooLargeError("facebook", "react", 1))
      .mockResolvedValueOnce({ diff: makeDiff(2), etag: '"etag2"' });

    await processor.process(makeJob());

    // Both PRs should be stored despite the first one's diff failing
    const storedPRs = db.listOpenPRs(repoId);
    expect(storedPRs).toHaveLength(2);

    // PR 1 has no diff hash (diff was too large)
    const pr1 = db.getPRByNumber(repoId, 1);
    expect(pr1!.diffHash).toBeNull();

    // PR 2 has a normal diff hash
    const pr2 = db.getPRByNumber(repoId, 2);
    expect(pr2!.diffHash).toBe(hashDiff(makeDiff(2)));

    // Detect job was still enqueued
    expect(mockQueue.enqueue).toHaveBeenCalledTimes(1);
  });
});
