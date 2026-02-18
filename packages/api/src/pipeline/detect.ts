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
    const { repoId, scanId, accountId } = job.payload as {
      repoId: number;
      scanId: number;
      accountId: number;
    };

    const scan = this.db.getScan(scanId);
    if (!scan) throw new Error(`Scan not found: ${scanId}`);

    const strategyName = scan.strategy;
    const strategy = getStrategy(strategyName);

    detectLog.info("Running strategy", { scanId, strategy: strategyName });

    const prs = this.db.listOpenPRs(repoId);

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

    // Mark scan done
    this.db.updateScanStatus(scanId, "done", {
      dupeGroupCount: result.groups.length,
      completedAt: new Date().toISOString(),
    });

    this.db.updateRepoLastScanAt(repoId, new Date().toISOString());

    detectLog.info("Strategy complete", {
      scanId,
      strategy: strategyName,
      groups: result.groups.length,
    });
  }
}
