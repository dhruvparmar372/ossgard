import type { Job } from "@ossgard/shared";
import type { Database } from "../db/database.js";
import type { JobQueue } from "../queue/types.js";
import type { JobProcessor } from "../queue/worker.js";
import { log } from "../logger.js";

const scanLog = log.child("scan");

export class ScanOrchestrator implements JobProcessor {
  readonly type = "scan";

  constructor(
    private db: Database,
    private queue: JobQueue
  ) {}

  async process(job: Job): Promise<void> {
    const { repoId, scanId, accountId, maxPrs } = job.payload as {
      repoId: number;
      scanId: number;
      accountId: number;
      maxPrs?: number;
    };

    // Look up the repo to get owner/name
    const repo = this.db.getRepo(repoId);
    if (!repo) {
      throw new Error(`Repo not found: ${repoId}`);
    }

    scanLog.info("Scan started", { scanId, repo: `${repo.owner}/${repo.name}` });

    // Enqueue the ingest job
    await this.queue.enqueue({
      type: "ingest",
      payload: {
        repoId,
        scanId,
        accountId,
        owner: repo.owner,
        repo: repo.name,
        ...(maxPrs !== undefined && { maxPrs }),
      },
    });

    scanLog.info("Enqueued ingest", { scanId });
  }
}
