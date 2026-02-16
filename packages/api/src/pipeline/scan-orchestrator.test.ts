import { ScanOrchestrator } from "./scan-orchestrator.js";
import { Database } from "../db/database.js";
import type { JobQueue } from "../queue/types.js";
import type { Job } from "@ossgard/shared";

describe("ScanOrchestrator", () => {
  let db: Database;
  let mockQueue: JobQueue;
  let orchestrator: ScanOrchestrator;
  let repoId: number;
  let scanId: number;

  beforeEach(() => {
    db = new Database(":memory:");
    const repo = db.insertRepo("facebook", "react");
    repoId = repo.id;
    const scan = db.createScan(repoId);
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
      payload: { repoId, scanId },
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
        owner: "facebook",
        repo: "react",
      },
    });
  });

  it("looks up repo to get owner and name", async () => {
    // Insert a different repo to verify the correct one is used
    const repo2 = db.insertRepo("vercel", "next.js");
    const scan2 = db.createScan(repo2.id);

    const job: Job = {
      ...makeJob(),
      payload: { repoId: repo2.id, scanId: scan2.id },
    };

    await orchestrator.process(job);

    expect(mockQueue.enqueue).toHaveBeenCalledWith({
      type: "ingest",
      payload: {
        repoId: repo2.id,
        scanId: scan2.id,
        owner: "vercel",
        repo: "next.js",
      },
    });
  });

  it("throws if repo is not found", async () => {
    const job: Job = {
      ...makeJob(),
      payload: { repoId: 9999, scanId },
    };

    await expect(orchestrator.process(job)).rejects.toThrow(
      "Repo not found: 9999"
    );
    expect(mockQueue.enqueue).not.toHaveBeenCalled();
  });

  it("forwards maxPrs when present in payload", async () => {
    const job: Job = {
      ...makeJob(),
      payload: { repoId, scanId, maxPrs: 10 },
    };

    await orchestrator.process(job);

    expect(mockQueue.enqueue).toHaveBeenCalledWith({
      type: "ingest",
      payload: {
        repoId,
        scanId,
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

  it("has type 'scan'", () => {
    expect(orchestrator.type).toBe("scan");
  });
});
