import type { Job } from "@ossgard/shared";
import type { Database } from "../db/database.js";
import type { JobQueue } from "../queue/types.js";
import type { JobProcessor } from "../queue/worker.js";

export class ScanOrchestrator implements JobProcessor {
  readonly type = "scan";

  constructor(
    private db: Database,
    private queue: JobQueue
  ) {}

  async process(job: Job): Promise<void> {
    const { repoId, scanId } = job.payload as {
      repoId: number;
      scanId: number;
    };

    // Look up the repo to get owner/name
    const repo = this.db.getRepo(repoId);
    if (!repo) {
      throw new Error(`Repo not found: ${repoId}`);
    }

    // Enqueue the ingest job
    await this.queue.enqueue({
      type: "ingest",
      payload: {
        repoId,
        scanId,
        owner: repo.owner,
        repo: repo.name,
      },
    });
  }
}
