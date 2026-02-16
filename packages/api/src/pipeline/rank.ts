import type { Job, PR } from "@ossgard/shared";
import type { Database } from "../db/database.js";
import type { Message } from "../services/llm-provider.js";
import { isBatchChatProvider } from "../services/llm-provider.js";
import type { ServiceResolver } from "../services/service-resolver.js";
import type { JobProcessor } from "../queue/worker.js";
import { buildRankPrompt } from "./prompts.js";
import { log } from "../logger.js";

interface VerifiedGroup {
  prIds: number[];
  label: string;
  confidence: number;
  relationship: string;
}

interface RankingResult {
  prNumber: number;
  score: number;
  codeQuality: number;
  completeness: number;
  rationale: string;
}

interface PreparedGroup {
  groupIndex: number;
  group: VerifiedGroup;
  prs: PR[];
  messages: Message[];
}

const rankLog = log.child("rank");

export class RankProcessor implements JobProcessor {
  readonly type = "rank";

  constructor(
    private db: Database,
    private resolver: ServiceResolver
  ) {}

  async process(job: Job): Promise<void> {
    const { repoId, scanId, accountId, verifiedGroups } = job.payload as {
      repoId: number;
      scanId: number;
      accountId: number;
      owner: string;
      repo: string;
      verifiedGroups: VerifiedGroup[];
    };

    // Update scan status to "ranking"
    this.db.updateScanStatus(scanId, "ranking");

    rankLog.info("Rank started", { scanId, groups: verifiedGroups.length });

    // Resolve LLM from account config
    const { llm } = await this.resolver.resolve(accountId);

    // 1. Build all messages upfront
    const prepared: PreparedGroup[] = [];
    for (let i = 0; i < verifiedGroups.length; i++) {
      const group = verifiedGroups[i];
      const prs: PR[] = [];
      for (const prId of group.prIds) {
        const pr = this.db.getPR(prId);
        if (pr) prs.push(pr);
      }
      if (prs.length < 2) continue;
      prepared.push({
        groupIndex: i,
        group,
        prs,
        messages: buildRankPrompt(prs, group.label),
      });
    }

    // 2. Call LLM (batch or sequential)
    let responses: Array<{ rankings: RankingResult[] }>;
    const useBatch = isBatchChatProvider(llm) && prepared.length > 1;
    rankLog.info("LLM mode", { scanId, mode: useBatch ? "batch" : "sequential", prompts: prepared.length });

    if (useBatch) {
      const results = await llm.chatBatch(
        prepared.map((p) => ({
          id: `rank-${p.groupIndex}`,
          messages: p.messages,
        }))
      );
      responses = results.map(
        (r) => r.response as { rankings: RankingResult[] }
      );
    } else {
      responses = [];
      for (const p of prepared) {
        const response = (await llm.chat(p.messages)) as {
          rankings: RankingResult[];
        };
        responses.push(response);
      }
    }

    // 3. Store results
    let totalGroups = 0;

    for (let i = 0; i < prepared.length; i++) {
      const { group, prs } = prepared[i];
      const response = responses[i];

      const sortedRankings = [...response.rankings].sort(
        (a, b) => b.score - a.score
      );

      const dupeGroup = this.db.insertDupeGroup(
        scanId,
        repoId,
        group.label,
        prs.length
      );

      for (let rank = 0; rank < sortedRankings.length; rank++) {
        const ranking = sortedRankings[rank];
        const pr = prs.find((p) => p.number === ranking.prNumber);
        if (!pr) continue;

        this.db.insertDupeGroupMember(
          dupeGroup.id,
          pr.id,
          rank + 1,
          ranking.score,
          ranking.rationale
        );
      }

      totalGroups++;
    }

    // Mark scan as "done" with dupeGroupCount and completedAt
    this.db.updateScanStatus(scanId, "done", {
      dupeGroupCount: totalGroups,
      completedAt: new Date().toISOString(),
    });

    // Update the repo's last_scan_at timestamp
    this.db.updateRepoLastScanAt(repoId, new Date().toISOString());

    rankLog.info("Scan complete", { scanId, dupeGroups: totalGroups });
  }
}
