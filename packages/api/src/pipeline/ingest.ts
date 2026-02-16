import type { Job } from "@ossgard/shared";
import type { Database } from "../db/database.js";
import type { ServiceResolver } from "../services/service-resolver.js";
import type { JobQueue } from "../queue/types.js";
import type { JobProcessor } from "../queue/worker.js";
import { hashDiff } from "./normalize-diff.js";
import { DiffTooLargeError } from "../services/github-client.js";
import { log } from "../logger.js";

const ingestLog = log.child("ingest");

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

    ingestLog.info("Ingest started", { scanId, repo: `${owner}/${repo}` });

    // Resolve the GitHub client from the account config
    const { github } = await this.resolver.resolve(accountId);

    // Fetch open PRs from GitHub (optionally limited)
    const fetchedPRs = await github.listOpenPRs(owner, repo, maxPrs);

    ingestLog.info("Fetched PR list", { scanId, total: fetchedPRs.length });

    let etagHits = 0;

    // For each PR, fetch files and diff, compute hash, upsert
    for (let i = 0; i < fetchedPRs.length; i++) {
      const pr = fetchedPRs[i];
      // Look up existing PR for its stored etag
      const existingPR = this.db.getPRByNumber(repoId, pr.number);
      const storedEtag = existingPR?.githubEtag ?? null;

      let filePaths: string[];
      let diffResult: { diff: string; etag: string | null } | null;
      try {
        [filePaths, diffResult] = await Promise.all([
          github.getPRFiles(owner, repo, pr.number),
          github.getPRDiff(owner, repo, pr.number, storedEtag),
        ]);
      } catch (err) {
        if (err instanceof DiffTooLargeError) {
          ingestLog.warn("Diff too large, skipping diff", { scanId, pr: pr.number });
          filePaths = await github.getPRFiles(owner, repo, pr.number);
          diffResult = null;
        } else {
          throw err;
        }
      }

      // If diff hasn't changed (304) or was too large, skip processing but still upsert metadata
      if (!diffResult) etagHits++;
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

      if (i % 10 === 0 || i === fetchedPRs.length - 1) {
        ingestLog.info("Ingesting PRs", { scanId, progress: `${i + 1}/${fetchedPRs.length}` });
      }
    }

    ingestLog.info("PRs fetched", { scanId, count: fetchedPRs.length, etagHits });

    // Update scan with PR count
    this.db.updateScanStatus(scanId, "ingesting", {
      prCount: fetchedPRs.length,
    });

    // Enqueue the next pipeline stage: embed
    await this.queue.enqueue({
      type: "embed",
      payload: { repoId, scanId, accountId, owner, repo },
    });

    ingestLog.info("Enqueued embed", { scanId });
  }
}
