import type { Job } from "@ossgard/shared";
import type { Database } from "../db/database.js";
import type { ServiceResolver } from "../services/service-resolver.js";
import type { JobQueue } from "../queue/types.js";
import type { JobProcessor } from "../queue/worker.js";
import { hashDiff } from "./normalize-diff.js";
import { DiffTooLargeError } from "../services/github-client.js";
import { log } from "../logger.js";

const ingestLog = log.child("ingest");
const PR_CONCURRENCY = 10;

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
    let diffTooLarge = 0;
    let skipped = 0;
    let completed = 0;

    // Process a single PR: fetch files + diff, compute hash, upsert
    const ingestPR = async (pr: (typeof fetchedPRs)[number]) => {
      const existingPR = this.db.getPRByNumber(repoId, pr.number);

      // Skip PRs that haven't changed since last ingest
      if (existingPR && existingPR.updatedAt === pr.updatedAt) {
        skipped++;
        completed++;
        ingestLog.info("PR unchanged, skipping", {
          scanId,
          pr: pr.number,
          progress: `${completed}/${fetchedPRs.length}`,
        });
        return;
      }

      const storedEtag = existingPR?.githubEtag ?? null;

      ingestLog.info("Fetching PR data", {
        scanId,
        pr: pr.number,
        author: pr.author,
        hasEtag: !!storedEtag,
      });

      const prStart = Date.now();

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
          diffTooLarge++;
        } else {
          throw err;
        }
      }

      const cached = !diffResult;
      if (cached) etagHits++;
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

      if (newEtag && upserted) {
        this.db.updatePREtag(upserted.id, newEtag);
      }

      completed++;
      ingestLog.info("PR ingested", {
        scanId,
        pr: pr.number,
        files: filePaths.length,
        cached,
        durationMs: Date.now() - prStart,
        progress: `${completed}/${fetchedPRs.length}`,
      });
    };

    // Process PRs concurrently using a worker pool
    // The underlying RateLimitedClient semaphore (maxConcurrent=10) provides HTTP-level backpressure
    const queue = [...fetchedPRs];
    const workers = Array.from(
      { length: Math.min(PR_CONCURRENCY, fetchedPRs.length) },
      async () => {
        while (queue.length > 0) {
          const pr = queue.shift()!;
          await ingestPR(pr);
        }
      }
    );
    await Promise.all(workers);

    ingestLog.info("Ingest complete", { scanId, count: fetchedPRs.length, skipped, etagHits, diffTooLarge });

    // Update scan with PR count
    this.db.updateScanStatus(scanId, "ingesting", {
      prCount: fetchedPRs.length,
    });

    // Collect the PR numbers that were part of this scan (all fetched, including skipped-unchanged)
    const prNumbers = fetchedPRs.map((pr) => pr.number);

    // Enqueue the strategy-based detection scoped to these PRs
    await this.queue.enqueue({
      type: "detect",
      payload: { repoId, scanId, accountId, owner, repo, prNumbers },
    });

    ingestLog.info("Enqueued detect", { scanId, prCount: prNumbers.length });
  }
}
