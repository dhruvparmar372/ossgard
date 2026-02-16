import type { Job } from "@ossgard/shared";
import type { Database } from "../db/database.js";
import type { ServiceResolver } from "../services/service-resolver.js";
import type { JobQueue } from "../queue/types.js";
import type { JobProcessor } from "../queue/worker.js";
import { hashDiff } from "./normalize-diff.js";

export class IngestProcessor implements JobProcessor {
  readonly type = "ingest";

  constructor(
    private db: Database,
    private resolver: ServiceResolver,
    private queue: JobQueue
  ) {}

  async process(job: Job): Promise<void> {
    const { repoId, scanId, accountId, owner, repo, maxPrs } = job.payload as {
      repoId: number;
      scanId: number;
      accountId: number;
      owner: string;
      repo: string;
      maxPrs?: number;
    };

    // Update scan status to "ingesting"
    this.db.updateScanStatus(scanId, "ingesting");

    // Resolve the GitHub client from the account config
    const { github } = await this.resolver.resolve(accountId);

    // Fetch open PRs from GitHub (optionally limited)
    const fetchedPRs = await github.listOpenPRs(owner, repo, maxPrs);

    // For each PR, fetch files and diff, compute hash, upsert
    for (const pr of fetchedPRs) {
      // Look up existing PR for its stored etag
      const existingPR = this.db.getPRByNumber(repoId, pr.number);
      const storedEtag = existingPR?.githubEtag ?? null;

      const [filePaths, diffResult] = await Promise.all([
        github.getPRFiles(owner, repo, pr.number),
        github.getPRDiff(owner, repo, pr.number, storedEtag),
      ]);

      // If diff hasn't changed (304), skip processing but still upsert metadata
      const diffHash = diffResult ? hashDiff(diffResult.diff) : existingPR?.diffHash ?? null;
      const newEtag = diffResult?.etag ?? storedEtag;

      const upserted = this.db.upsertPR({
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

      // Store the etag
      if (newEtag && upserted) {
        this.db.updatePREtag(upserted.id, newEtag);
      }
    }

    // Update scan with PR count
    this.db.updateScanStatus(scanId, "ingesting", {
      prCount: fetchedPRs.length,
    });

    // Enqueue the next pipeline stage: embed
    await this.queue.enqueue({
      type: "embed",
      payload: { repoId, scanId, accountId, owner, repo },
    });
  }
}
