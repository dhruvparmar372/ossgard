import type { Job } from "@ossgard/shared";
import type { Database } from "../db/database.js";
import type { GitHubClient } from "../services/github-client.js";
import type { JobQueue } from "../queue/types.js";
import type { JobProcessor } from "../queue/worker.js";
import { hashDiff } from "./normalize-diff.js";

export class IngestProcessor implements JobProcessor {
  readonly type = "ingest";

  constructor(
    private db: Database,
    private github: GitHubClient,
    private queue: JobQueue
  ) {}

  async process(job: Job): Promise<void> {
    const { repoId, scanId, owner, repo } = job.payload as {
      repoId: number;
      scanId: number;
      owner: string;
      repo: string;
    };

    // Update scan status to "ingesting"
    this.db.updateScanStatus(scanId, "ingesting");

    // Fetch all open PRs from GitHub
    const fetchedPRs = await this.github.listOpenPRs(owner, repo);

    // For each PR, fetch files and diff, compute hash, upsert
    for (const pr of fetchedPRs) {
      const [filePaths, rawDiff] = await Promise.all([
        this.github.getPRFiles(owner, repo, pr.number),
        this.github.getPRDiff(owner, repo, pr.number),
      ]);

      const diffHash = hashDiff(rawDiff);

      this.db.upsertPR({
        repoId,
        number: pr.number,
        title: pr.title,
        body: pr.body,
        author: pr.author,
        diffHash,
        filePaths,
        state: pr.state,
        createdAt: pr.createdAt,
        updatedAt: pr.updatedAt,
      });
    }

    // Update scan with PR count
    this.db.updateScanStatus(scanId, "ingesting", {
      prCount: fetchedPRs.length,
    });

    // Enqueue the next pipeline stage: embed
    await this.queue.enqueue({
      type: "embed",
      payload: { repoId, scanId, owner, repo },
    });
  }
}
