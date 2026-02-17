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
        messages: buildRankPrompt(prs, group.label, llm),
      });
    }

    // 2. Call LLM (batch or sequential)
    let responses: Array<{ rankings: RankingResult[] }>;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const useBatch = isBatchChatProvider(llm) && prepared.length > 1;
    rankLog.info("LLM mode", { scanId, mode: useBatch ? "batch" : "sequential", prompts: prepared.length });

    // Check for existing batch ID from phaseCursor (resume support)
    const scan = this.db.getScan(scanId);
    const existingBatchId = (scan?.phaseCursor as Record<string, unknown> | null)?.rankBatchId as string | undefined;

    if (useBatch) {
      rankLog.info("Sending batch ranking", { scanId, groups: prepared.length });
      const batchStart = Date.now();
      const results = await llm.chatBatch(
        prepared.map((p) => ({
          id: `rank-${p.groupIndex}`,
          messages: p.messages,
        })),
        {
          existingBatchId,
          onBatchCreated: (batchId) => {
            this.db.updateScanStatus(scanId, "ranking", {
              phaseCursor: { rankBatchId: batchId },
            });
          },
        }
      );
      rankLog.info("Batch ranking complete", { scanId, durationMs: Date.now() - batchStart });
      responses = results.map((r) => {
        totalInputTokens += r.usage.inputTokens;
        totalOutputTokens += r.usage.outputTokens;
        return r.response as { rankings: RankingResult[] };
      });
    } else {
      responses = [];
      for (let i = 0; i < prepared.length; i++) {
        const p = prepared[i];
        rankLog.info("Ranking group", {
          scanId,
          group: `${i + 1}/${prepared.length}`,
          label: p.group.label,
          prs: p.prs.length,
        });
        const groupStart = Date.now();
        const chatResult = await llm.chat(p.messages);
        totalInputTokens += chatResult.usage.inputTokens;
        totalOutputTokens += chatResult.usage.outputTokens;
        responses.push(chatResult.response as { rankings: RankingResult[] });
        rankLog.info("Group ranked", {
          scanId,
          group: `${i + 1}/${prepared.length}`,
          durationMs: Date.now() - groupStart,
        });
      }
    }

    // Store accumulated token usage
    if (totalInputTokens > 0 || totalOutputTokens > 0) {
      this.db.addScanTokens(scanId, totalInputTokens, totalOutputTokens);
    }

    // Clear phaseCursor after successful completion
    this.db.updateScanStatus(scanId, "ranking", { phaseCursor: null });

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

      rankLog.info("Group stored", {
        scanId,
        label: group.label,
        members: sortedRankings.length,
        topScore: sortedRankings[0]?.score ?? 0,
      });

      totalGroups++;
    }

    // Mark scan as "done" with dupeGroupCount and completedAt
    this.db.updateScanStatus(scanId, "done", {
      dupeGroupCount: totalGroups,
      completedAt: new Date().toISOString(),
    });

    // Update the repo's last_scan_at timestamp
    this.db.updateRepoLastScanAt(repoId, new Date().toISOString());

    rankLog.info("Scan complete", { scanId, dupeGroups: totalGroups, inputTokens: totalInputTokens, outputTokens: totalOutputTokens });
  }
}
