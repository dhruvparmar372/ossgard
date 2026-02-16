import type { Job, PR } from "@ossgard/shared";
import type { Database } from "../db/database.js";
import type { ServiceResolver } from "../services/service-resolver.js";
import type { JobQueue } from "../queue/types.js";
import type { JobProcessor } from "../queue/worker.js";
import { UnionFind } from "./union-find.js";

const CODE_COLLECTION = "ossgard-code";
const INTENT_COLLECTION = "ossgard-intent";

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

    for (const group of hashGroups.values()) {
      for (let i = 1; i < group.length; i++) {
        uf.union(group[0], group[i]);
      }
    }

    // Embedding path: for each PR, retrieve actual stored vectors and search
    // both code and intent collections, unioning PRs above the similarity threshold
    for (const pr of prs) {
      const codePointId = `${repoId}-${pr.number}-code`;
      const intentPointId = `${repoId}-${pr.number}-intent`;

      // Retrieve actual stored vector for this PR's code embedding
      const codeVector = await vectorStore.getVector(CODE_COLLECTION, codePointId);
      if (codeVector) {
        const codeResults = await vectorStore.search(
          CODE_COLLECTION,
          codeVector,
          {
            limit: prs.length,
            filter: {
              must: [{ key: "repoId", match: { value: repoId } }],
            },
          }
        );

        for (const result of codeResults) {
          const neighborPR = result.payload.prNumber as number;
          if (
            result.score >= scanConfig.codeSimilarityThreshold &&
            neighborPR !== pr.number &&
            uf.has(neighborPR)
          ) {
            uf.union(pr.number, neighborPR);
          }
        }
      }

      // Retrieve actual stored vector for this PR's intent embedding
      const intentVector = await vectorStore.getVector(INTENT_COLLECTION, intentPointId);
      if (intentVector) {
        const intentResults = await vectorStore.search(
          INTENT_COLLECTION,
          intentVector,
          {
            limit: prs.length,
            filter: {
              must: [{ key: "repoId", match: { value: repoId } }],
            },
          }
        );

        for (const result of intentResults) {
          const neighborPR = result.payload.prNumber as number;
          if (
            result.score >= scanConfig.intentSimilarityThreshold &&
            neighborPR !== pr.number &&
            uf.has(neighborPR)
          ) {
            uf.union(pr.number, neighborPR);
          }
        }
      }
    }

    // Extract connected components with 2+ members
    const groups = uf.getGroups(2);

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

    // Enqueue verify job with candidateGroups payload
    if (this.queue) {
      await this.queue.enqueue({
        type: "verify",
        payload: { repoId, scanId, accountId, owner, repo, candidateGroups },
      });
    }
  }
}
