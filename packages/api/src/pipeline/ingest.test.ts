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

  it("enqueues embed job after completion", async () => {
    (mockGitHub.listOpenPRs as any).mockResolvedValue([makeFetchedPR(1)]);
    (mockGitHub.getPRFiles as any).mockResolvedValue(["file.ts"]);
    (mockGitHub.getPRDiff as any).mockResolvedValue({ diff: makeDiff(1), etag: '"etag1"' });

    await processor.process(makeJob());

    expect(mockQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(mockQueue.enqueue).toHaveBeenCalledWith({
      type: "embed",
      payload: { repoId, scanId, accountId, owner: "facebook", repo: "react" },
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

    expect(mockGitHub.listOpenPRs).toHaveBeenCalledWith("facebook", "react", undefined);
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

    expect(mockGitHub.listOpenPRs).toHaveBeenCalledWith("facebook", "react", 5);
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

    // Embed job was still enqueued
    expect(mockQueue.enqueue).toHaveBeenCalledTimes(1);
  });
});
