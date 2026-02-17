import type { Job, PR } from "@ossgard/shared";
import type { Database } from "../db/database.js";
import type { Message } from "../services/llm-provider.js";
import { isBatchChatProvider } from "../services/llm-provider.js";
import type { ServiceResolver } from "../services/service-resolver.js";
import type { JobQueue } from "../queue/types.js";
import type { JobProcessor } from "../queue/worker.js";
import { buildVerifyPrompt } from "./prompts.js";
import { log } from "../logger.js";

interface CandidateGroup {
  prNumbers: number[];
  prIds: number[];
}

interface VerifiedGroup {
  prIds: number[];
  label: string;
  confidence: number;
  relationship: string;
}

interface PreparedCandidate {
  index: number;
  messages: Message[];
}

type VerifyResponse = {
  groups: Array<{
    prIds: number[];
    label: string;
    confidence: number;
    relationship: string;
  }>;
  unrelated: number[];
};

function collectVerifiedGroups(
  response: VerifyResponse
): VerifiedGroup[] {
  const result: VerifiedGroup[] = [];
  const groups = Array.isArray(response.groups) ? response.groups : [];
  for (const group of groups) {
    if (Array.isArray(group.prIds) && group.prIds.length >= 2) {
      result.push({
        prIds: group.prIds,
        label: group.label ?? "Unknown",
        confidence: group.confidence ?? 0,
        relationship: group.relationship ?? "unknown",
      });
    }
  }
  return result;
}

const verifyLog = log.child("verify");

export class VerifyProcessor implements JobProcessor {
  readonly type = "verify";

  constructor(
    private db: Database,
    private resolver: ServiceResolver,
    private queue?: JobQueue
  ) {}

  async process(job: Job): Promise<void> {
    const { repoId, scanId, accountId, owner, repo, candidateGroups } = job.payload as {
      repoId: number;
      scanId: number;
      accountId: number;
      owner: string;
      repo: string;
      candidateGroups: CandidateGroup[];
    };

    // Update scan status to "verifying"
    this.db.updateScanStatus(scanId, "verifying");

    verifyLog.info("Verify started", { scanId, candidates: candidateGroups.length });

    // Resolve LLM from account config
    const { llm } = await this.resolver.resolve(accountId);

    // 1. Build all messages upfront
    const prepared: PreparedCandidate[] = [];
    for (let i = 0; i < candidateGroups.length; i++) {
      const candidate = candidateGroups[i];
      const prs: PR[] = [];
      for (const prNumber of candidate.prNumbers) {
        const pr = this.db.getPRByNumber(repoId, prNumber);
        if (pr) prs.push(pr);
      }
      if (prs.length < 2) continue;
      prepared.push({ index: i, messages: buildVerifyPrompt(prs) });
    }

    // 2. Call LLM (batch or sequential)
    const verifiedGroups: VerifiedGroup[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const useBatch = isBatchChatProvider(llm) && prepared.length > 1;
    verifyLog.info("LLM mode", { scanId, mode: useBatch ? "batch" : "sequential", prompts: prepared.length });

    if (useBatch) {
      verifyLog.info("Sending batch verification", { scanId, groups: prepared.length });
      const batchStart = Date.now();
      const results = await llm.chatBatch(
        prepared.map((p) => ({
          id: `verify-${p.index}`,
          messages: p.messages,
        }))
      );
      verifyLog.info("Batch verification complete", { scanId, durationMs: Date.now() - batchStart });
      for (const result of results) {
        totalInputTokens += result.usage.inputTokens;
        totalOutputTokens += result.usage.outputTokens;
        verifiedGroups.push(
          ...collectVerifiedGroups(result.response as VerifyResponse)
        );
      }
    } else {
      for (let i = 0; i < prepared.length; i++) {
        const p = prepared[i];
        const candidate = candidateGroups[p.index];
        verifyLog.info("Verifying group", {
          scanId,
          group: `${i + 1}/${prepared.length}`,
          prs: candidate.prNumbers,
        });
        const groupStart = Date.now();
        const chatResult = await llm.chat(p.messages);
        totalInputTokens += chatResult.usage.inputTokens;
        totalOutputTokens += chatResult.usage.outputTokens;
        const verified = collectVerifiedGroups(chatResult.response as VerifyResponse);
        verifiedGroups.push(...verified);
        verifyLog.info("Group verified", {
          scanId,
          group: `${i + 1}/${prepared.length}`,
          confirmed: verified.length > 0,
          durationMs: Date.now() - groupStart,
        });
      }
    }

    // Store accumulated token usage
    if (totalInputTokens > 0 || totalOutputTokens > 0) {
      this.db.addScanTokens(scanId, totalInputTokens, totalOutputTokens);
    }

    verifyLog.info("Verified groups", { scanId, count: verifiedGroups.length, inputTokens: totalInputTokens, outputTokens: totalOutputTokens });

    // Enqueue rank job with verifiedGroups
    if (this.queue) {
      await this.queue.enqueue({
        type: "rank",
        payload: { repoId, scanId, accountId, owner, repo, verifiedGroups },
      });
      verifyLog.info("Enqueued rank", { scanId });
    }
  }
}
