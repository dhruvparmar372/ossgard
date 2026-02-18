import type { Job, PR } from "@ossgard/shared";
import type { Database } from "../db/database.js";
import type { Message } from "../services/llm-provider.js";
import { isBatchChatProvider } from "../services/llm-provider.js";
import type { ServiceResolver } from "../services/service-resolver.js";
import type { JobProcessor } from "../queue/worker.js";
import { buildRankPrompt } from "./prompts.js";
import { log } from "../logger.js";
import type { StrategyResult, StrategyDupeGroup } from "./strategy.js";

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

/** Options for the standalone runRank function. */
export interface RunRankOpts {
  verifiedGroups: VerifiedGroup[];
  scanId: number;
  repoId: number;
  accountId: number;
  resolver: ServiceResolver;
  db: Database;
}

/**
 * Standalone rank logic: LLM ranking of verified groups.
 * Does NOT update scan status or enqueue jobs — the caller handles that.
 * Stores results in the database (insertDupeGroup/insertDupeGroupMember) for legacy compatibility.
 * Returns a StrategyResult with the ranked groups and token usage.
 */
export async function runRank(opts: RunRankOpts): Promise<StrategyResult> {
  const { verifiedGroups, scanId, repoId, accountId, resolver, db } = opts;

  rankLog.info("Rank started", { scanId, groups: verifiedGroups.length });

  // Resolve LLM from account config
  const { llm } = await resolver.resolve(accountId);

  // 1. Build all messages upfront
  const prepared: PreparedGroup[] = [];
  for (let i = 0; i < verifiedGroups.length; i++) {
    const group = verifiedGroups[i];
    const prs: PR[] = [];
    for (const prId of group.prIds) {
      const pr = db.getPR(prId);
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
  const scan = db.getScan(scanId);
  const existingBatchId = (scan?.phaseCursor as Record<string, unknown> | null)?.rankBatchId as string | undefined;

  if (useBatch) {
    rankLog.info("Sending batch ranking", { scanId, groups: prepared.length });
    const batchStart = Date.now();
    let results;
    try {
      results = await llm.chatBatch(
        prepared.map((p) => ({
          id: `rank-${p.groupIndex}`,
          messages: p.messages,
        })),
        {
          existingBatchId,
          onBatchCreated: (batchId) => {
            db.updateScanStatus(scanId, "ranking", {
              phaseCursor: { rankBatchId: batchId },
            });
          },
        }
      );
    } catch (err) {
      db.updateScanStatus(scanId, "ranking", { phaseCursor: null });
      throw err;
    }
    const errored = results.filter((r) => r.error);
    rankLog.info("Batch ranking complete", {
      scanId,
      durationMs: Date.now() - batchStart,
      succeeded: results.length - errored.length,
      errored: errored.length,
    });
    for (const e of errored) {
      rankLog.warn("Rank item failed", { id: e.id, error: e.error });
    }
    // Filter out errored items and keep matching prepared entries
    const succeededResults = results.filter((r) => !r.error);
    const succeededPrepared: PreparedGroup[] = [];
    responses = [];
    for (const r of succeededResults) {
      const idx = parseInt(r.id.replace("rank-", ""), 10);
      const p = prepared.find((pp) => pp.groupIndex === idx);
      if (p) {
        succeededPrepared.push(p);
        totalInputTokens += r.usage.inputTokens;
        totalOutputTokens += r.usage.outputTokens;
        responses.push(r.response as { rankings: RankingResult[] });
      }
    }
    // Replace prepared with only succeeded entries for storage step
    prepared.length = 0;
    prepared.push(...succeededPrepared);
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

  // 3. Store results and build StrategyResult
  // Clear any previous attempt's groups first for idempotency
  db.deleteDupeGroupsByScan(scanId);
  const strategyGroups: StrategyDupeGroup[] = [];

  for (let i = 0; i < prepared.length; i++) {
    const { group, prs } = prepared[i];
    const response = responses[i];

    // Deduplicate rankings by prNumber (LLM sometimes returns duplicates)
    const seen = new Set<number>();
    const sortedRankings = [...(response.rankings ?? [])].sort(
      (a, b) => b.score - a.score
    ).filter((r) => {
      if (seen.has(r.prNumber)) return false;
      seen.add(r.prNumber);
      return true;
    });

    const dupeGroup = db.insertDupeGroup(
      scanId,
      repoId,
      group.label,
      prs.length
    );

    const members: StrategyDupeGroup["members"] = [];

    for (let rank = 0; rank < sortedRankings.length; rank++) {
      const ranking = sortedRankings[rank];
      const pr = prs.find((p) => p.number === ranking.prNumber);
      if (!pr) continue;

      db.insertDupeGroupMember(
        dupeGroup.id,
        pr.id,
        rank + 1,
        ranking.score,
        ranking.rationale
      );

      members.push({
        prId: pr.id,
        prNumber: pr.number,
        rank: rank + 1,
        score: ranking.score,
        rationale: ranking.rationale,
      });
    }

    strategyGroups.push({
      label: group.label,
      confidence: group.confidence,
      relationship: group.relationship,
      members,
    });

    rankLog.info("Group stored", {
      scanId,
      label: group.label,
      members: sortedRankings.length,
      topScore: sortedRankings[0]?.score ?? 0,
    });
  }

  return {
    groups: strategyGroups,
    tokenUsage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
  };
}

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

    // Delegate to standalone runRank
    const result = await runRank({
      verifiedGroups,
      scanId,
      repoId,
      accountId,
      resolver: this.resolver,
      db: this.db,
    });

    // Store accumulated token usage
    if (result.tokenUsage.inputTokens > 0 || result.tokenUsage.outputTokens > 0) {
      this.db.addScanTokens(scanId, result.tokenUsage.inputTokens, result.tokenUsage.outputTokens);
    }

    // Clear phaseCursor after successful completion
    this.db.updateScanStatus(scanId, "ranking", { phaseCursor: null });

    // Mark scan as "done" with dupeGroupCount and completedAt
    this.db.updateScanStatus(scanId, "done", {
      dupeGroupCount: result.groups.length,
      completedAt: new Date().toISOString(),
    });

    // Update the repo's last_scan_at timestamp
    this.db.updateRepoLastScanAt(repoId, new Date().toISOString());

    rankLog.info("Scan complete", { scanId, dupeGroups: result.groups.length, inputTokens: result.tokenUsage.inputTokens, outputTokens: result.tokenUsage.outputTokens });
  }
}
