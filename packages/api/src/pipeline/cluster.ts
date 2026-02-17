import type { Job, PR } from "@ossgard/shared";
import type { Database } from "../db/database.js";
import type { ServiceResolver } from "../services/service-resolver.js";
import type { JobQueue } from "../queue/types.js";
import type { JobProcessor } from "../queue/worker.js";
import { UnionFind } from "./union-find.js";
import { log } from "../logger.js";

const CODE_COLLECTION = "ossgard-code";
const INTENT_COLLECTION = "ossgard-intent";

/** Max similar PRs to union per search. Prevents giant transitive components. */
const MAX_NEIGHBORS = 10;

/** Hard cap on candidate group size. Oversized groups get split into chunks. */
const MAX_GROUP_SIZE = 100;

const clusterLog = log.child("cluster");

export class ClusterProcessor implements JobProcessor {
  readonly type = "cluster";

  constructor(
    private db: Database,
    private resolver: ServiceResolver,
    private queue?: JobQueue
  ) {}

  async process(job: Job): Promise<void> {
    const { repoId, scanId, accountId, owner, repo } = job.payload as {
      repoId: number;
      scanId: number;
      accountId: number;
      owner: string;
      repo: string;
    };

    // Update scan status to "clustering"
    this.db.updateScanStatus(scanId, "clustering");

    clusterLog.info("Cluster started", { scanId });

    // Resolve services from account config
    const { vectorStore, scanConfig } = await this.resolver.resolve(accountId);

    // Read all open PRs
    const prs = this.db.listOpenPRs(repoId);

    const uf = new UnionFind<number>();
    for (const pr of prs) {
      uf.add(pr.number);
    }

    // Fast path: group PRs with identical diffHash
    const hashGroups = new Map<string, number[]>();
    for (const pr of prs) {
      if (pr.diffHash) {
        const existing = hashGroups.get(pr.diffHash);
        if (existing) {
          existing.push(pr.number);
        } else {
          hashGroups.set(pr.diffHash, [pr.number]);
        }
      }
    }

    const diffHashGroups = [...hashGroups.values()].filter((g) => g.length > 1).length;
    clusterLog.info("DiffHash groups", { scanId, groups: diffHashGroups });

    for (const group of hashGroups.values()) {
      for (let i = 1; i < group.length; i++) {
        uf.union(group[0], group[i]);
      }
    }

    // Embedding path: for each PR, retrieve actual stored vectors and search
    // both code and intent collections, unioning PRs above the similarity threshold
    for (let i = 0; i < prs.length; i++) {
      const pr = prs[i];
      const codePointId = `${repoId}-${pr.number}-code`;
      const intentPointId = `${repoId}-${pr.number}-intent`;
      const prStart = Date.now();
      let codeMatches = 0;
      let intentMatches = 0;

      // Retrieve actual stored vector for this PR's code embedding
      const codeVector = await vectorStore.getVector(CODE_COLLECTION, codePointId);
      if (codeVector) {
        const codeResults = await vectorStore.search(
          CODE_COLLECTION,
          codeVector,
          {
            limit: MAX_NEIGHBORS * 2,
            filter: {
              must: [{ key: "repoId", match: { value: repoId } }],
            },
          }
        );

        // Sort by score descending and take top MAX_NEIGHBORS to prevent giant components
        const topCode = codeResults
          .filter((r) => r.score >= scanConfig.codeSimilarityThreshold && r.payload.prNumber !== pr.number && uf.has(r.payload.prNumber as number))
          .sort((a, b) => b.score - a.score)
          .slice(0, MAX_NEIGHBORS);

        for (const result of topCode) {
          uf.union(pr.number, result.payload.prNumber as number);
          codeMatches++;
        }
      }

      // Retrieve actual stored vector for this PR's intent embedding
      const intentVector = await vectorStore.getVector(INTENT_COLLECTION, intentPointId);
      if (intentVector) {
        const intentResults = await vectorStore.search(
          INTENT_COLLECTION,
          intentVector,
          {
            limit: MAX_NEIGHBORS * 2,
            filter: {
              must: [{ key: "repoId", match: { value: repoId } }],
            },
          }
        );

        // Sort by score descending and take top MAX_NEIGHBORS to prevent giant components
        const topIntent = intentResults
          .filter((r) => r.score >= scanConfig.intentSimilarityThreshold && r.payload.prNumber !== pr.number && uf.has(r.payload.prNumber as number))
          .sort((a, b) => b.score - a.score)
          .slice(0, MAX_NEIGHBORS);

        for (const result of topIntent) {
          uf.union(pr.number, result.payload.prNumber as number);
          intentMatches++;
        }
      }

      clusterLog.info("PR clustered", {
        scanId,
        pr: pr.number,
        codeMatches,
        intentMatches,
        durationMs: Date.now() - prStart,
        progress: `${i + 1}/${prs.length}`,
      });
    }

    // Extract connected components with 2+ members
    const rawGroups = uf.getGroups(2);
    clusterLog.info("Similarity clusters", { scanId, clusters: rawGroups.length });

    // Hard cap: split oversized groups to prevent context limit issues in LLM verify
    const groups: number[][] = [];
    for (const group of rawGroups) {
      if (group.length <= MAX_GROUP_SIZE) {
        groups.push(group);
      } else {
        clusterLog.warn("Splitting oversized cluster", { scanId, size: group.length, chunks: Math.ceil(group.length / MAX_GROUP_SIZE) });
        const sorted = group.sort((a, b) => a - b);
        for (let i = 0; i < sorted.length; i += MAX_GROUP_SIZE) {
          const chunk = sorted.slice(i, i + MAX_GROUP_SIZE);
          if (chunk.length >= 2) groups.push(chunk);
        }
      }
    }

    // Build candidate groups: map PR numbers back to PR IDs
    const prByNumber = new Map<number, PR>();
    for (const pr of prs) {
      prByNumber.set(pr.number, pr);
    }

    const candidateGroups = groups.map((group) => ({
      prNumbers: group.sort((a, b) => a - b),
      prIds: group
        .map((n) => prByNumber.get(n)!.id)
        .sort((a, b) => a - b),
    }));

    // Store candidate groups in scan phaseCursor
    this.db.updateScanStatus(scanId, "clustering", {
      phaseCursor: { candidateGroups },
    });

    clusterLog.info("Candidate groups", { scanId, count: candidateGroups.length });

    // Enqueue verify job with candidateGroups payload
    if (this.queue) {
      await this.queue.enqueue({
        type: "verify",
        payload: { repoId, scanId, accountId, owner, repo, candidateGroups },
      });
      clusterLog.info("Enqueued verify", { scanId });
    }
  }
}
