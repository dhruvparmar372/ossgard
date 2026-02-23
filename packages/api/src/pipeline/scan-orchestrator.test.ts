import { ScanOrchestrator } from "./scan-orchestrator.js";
import { Database } from "../db/database.js";
import type { JobQueue } from "../queue/types.js";
import type { Job } from "@ossgard/shared";

const TEST_CONFIG = {
  github: { token: "ghp_test" },
  llm: { provider: "ollama", url: "http://localhost:11434", model: "llama3", api_key: "" },
  embedding: { provider: "ollama", url: "http://localhost:11434", model: "nomic-embed-text", api_key: "" },
  vector_store: { url: "http://localhost:6333", api_key: "" },
};

describe("ScanOrchestrator", () => {
  let db: Database;
  let mockQueue: JobQueue;
  let orchestrator: ScanOrchestrator;
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

    mockQueue = {
      enqueue: vi.fn().mockResolvedValue("job-456"),
      getStatus: vi.fn(),
      dequeue: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
      pause: vi.fn(),
    };

    orchestrator = new ScanOrchestrator(db, mockQueue);
  });

  afterEach(() => {
    db.close();
  });

  function makeJob(): Job {
    return {
      id: "scan-job-1",
      type: "scan",
      payload: { repoId, scanId, accountId },
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

  it("enqueues ingest job with correct payload", async () => {
    await orchestrator.process(makeJob());

    expect(mockQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(mockQueue.enqueue).toHaveBeenCalledWith({
      type: "ingest",
      payload: {
        repoId,
        scanId,
        accountId,
        owner: "facebook",
        repo: "react",
      },
    });
  });

  it("looks up repo to get owner and name", async () => {
    // Insert a different repo to verify the correct one is used
    const repo2 = db.insertRepo("vercel", "next.js");
    const scan2 = db.createScan(repo2.id, accountId);

    const job: Job = {
      ...makeJob(),
      payload: { repoId: repo2.id, scanId: scan2.id, accountId },
    };

    await orchestrator.process(job);

    expect(mockQueue.enqueue).toHaveBeenCalledWith({
      type: "ingest",
      payload: {
        repoId: repo2.id,
        scanId: scan2.id,
        accountId,
        owner: "vercel",
        repo: "next.js",
      },
    });
  });

  it("throws if repo is not found", async () => {
    const job: Job = {
      ...makeJob(),
      payload: { repoId: 9999, scanId, accountId },
    };

    await expect(orchestrator.process(job)).rejects.toThrow(
      "Repo not found: 9999"
    );
    expect(mockQueue.enqueue).not.toHaveBeenCalled();
  });

  it("forwards maxPrs when present in payload", async () => {
    const job: Job = {
      ...makeJob(),
      payload: { repoId, scanId, accountId, maxPrs: 10 },
    };

    await orchestrator.process(job);

    expect(mockQueue.enqueue).toHaveBeenCalledWith({
      type: "ingest",
      payload: {
        repoId,
        scanId,
        accountId,
        owner: "facebook",
        repo: "react",
        maxPrs: 10,
      },
    });
  });

  it("omits maxPrs when not present in payload", async () => {
    await orchestrator.process(makeJob());

    const call = (mockQueue.enqueue as any).mock.calls[0][0];
    expect(call.payload).not.toHaveProperty("maxPrs");
  });

  it("includes lastScanAt in ingest payload when repo has been scanned before", async () => {
    // Set a lastScanAt on the repo
    db.updateRepoLastScanAt(repoId, "2025-06-01T12:00:00Z");

    await orchestrator.process(makeJob());

    expect(mockQueue.enqueue).toHaveBeenCalledWith({
      type: "ingest",
      payload: {
        repoId,
        scanId,
        accountId,
        owner: "facebook",
        repo: "react",
        lastScanAt: "2025-06-01T12:00:00Z",
      },
    });
  });

  it("omits lastScanAt when repo has never been scanned", async () => {
    await orchestrator.process(makeJob());

    const call = (mockQueue.enqueue as any).mock.calls[0][0];
    expect(call.payload).not.toHaveProperty("lastScanAt");
  });

  it("has type 'scan'", () => {
    expect(orchestrator.type).toBe("scan");
  });
});
