import type { Job } from "@ossgard/shared";
import type { Database } from "../db/database.js";
import type { ServiceResolver } from "../services/service-resolver.js";
import type { JobProcessor } from "../queue/worker.js";
import { getStrategy } from "./strategy-registry.js";
import { log } from "../logger.js";

const detectLog = log.child("detect");

export class DetectProcessor implements JobProcessor {
  readonly type = "detect";

  constructor(
    private db: Database,
    private resolver: ServiceResolver
  ) {}

  async process(job: Job): Promise<void> {
    const { repoId, scanId, accountId, prNumbers } = job.payload as {
      repoId: number;
      scanId: number;
      accountId: number;
      prNumbers?: number[];
    };

    const scan = this.db.getScan(scanId);
    if (!scan) throw new Error(`Scan not found: ${scanId}`);

    // Always use pairwise-llm — legacy strategy has been removed.
    // Old DB rows may still have strategy="legacy", so ignore scan.strategy.
    const strategy = getStrategy("pairwise-llm");

    // Use only the PRs from this scan's ingest, not all PRs in the DB
    const prs = prNumbers?.length
      ? this.db.getPRsByNumbers(repoId, prNumbers)
      : this.db.listOpenPRs(repoId);

    detectLog.info("Running strategy", { scanId, strategy: "pairwise-llm", prs: prs.length });

    const result = await strategy.execute({
      prs,
      scanId,
      repoId,
      accountId,
      resolver: this.resolver,
      db: this.db,
    });

    // Store results
    this.db.deleteDupeGroupsByScan(scanId);
    for (const group of result.groups) {
      const dupeGroup = this.db.insertDupeGroup(scanId, repoId, group.label, group.members.length);
      for (const member of group.members) {
        this.db.insertDupeGroupMember(dupeGroup.id, member.prId, member.rank, member.score, member.rationale);
      }
    }

    // Track token usage
    if (result.tokenUsage.inputTokens > 0 || result.tokenUsage.outputTokens > 0) {
      this.db.addScanTokens(scanId, result.tokenUsage.inputTokens, result.tokenUsage.outputTokens);
    }

    // Store per-phase token breakdown + provider info
    this.db.setScanTokenUsage(scanId, result.phaseTokenUsage, result.providerInfo);

    // Mark scan done
    this.db.updateScanStatus(scanId, "done", {
      dupeGroupCount: result.groups.length,
      completedAt: new Date().toISOString(),
    });

    this.db.updateRepoLastScanAt(repoId, new Date().toISOString());

    detectLog.info("Strategy complete", {
      scanId,
      strategy: "pairwise-llm",
      groups: result.groups.length,
      inputTokens: result.tokenUsage.inputTokens,
      outputTokens: result.tokenUsage.outputTokens,
      phaseTokenUsage: result.phaseTokenUsage,
      provider: `${result.providerInfo.llmProvider}/${result.providerInfo.llmModel}`,
      embeddingProvider: `${result.providerInfo.embeddingProvider}/${result.providerInfo.embeddingModel}`,
    });
  }
}
