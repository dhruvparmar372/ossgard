import type { Job, PR } from "@ossgard/shared";
import type { Database } from "../db/database.js";
import type { Message } from "../services/llm-provider.js";
import { isBatchChatProvider } from "../services/llm-provider.js";
import type { ServiceResolver } from "../services/service-resolver.js";
import type { JobQueue } from "../queue/types.js";
import type { JobProcessor } from "../queue/worker.js";
import { buildVerifyPrompt } from "./prompts.js";
import { log } from "../logger.js";

export interface CandidateGroup {
  prNumbers: number[];
  prIds: number[];
}

export interface VerifiedGroup {
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

/** Options for the standalone runVerify function. */
export interface RunVerifyOpts {
  candidateGroups: CandidateGroup[];
  scanId: number;
  repoId: number;
  accountId: number;
  resolver: ServiceResolver;
  db: Database;
}

/** Result of the standalone runVerify function. */
export interface RunVerifyResult {
  verifiedGroups: VerifiedGroup[];
  tokenUsage: { inputTokens: number; outputTokens: number };
}

/**
 * Standalone verify logic: LLM verification of candidate groups.
 * Does NOT update scan status or enqueue jobs — the caller handles that.
 * Returns verified groups and token usage.
 */
export async function runVerify(opts: RunVerifyOpts): Promise<RunVerifyResult> {
  const { candidateGroups, scanId, repoId, accountId, resolver, db } = opts;

  verifyLog.info("Verify started", { scanId, candidates: candidateGroups.length });

  // Resolve LLM from account config
  const { llm } = await resolver.resolve(accountId);

  // 1. Build all messages upfront
  const prepared: PreparedCandidate[] = [];
  for (let i = 0; i < candidateGroups.length; i++) {
    const candidate = candidateGroups[i];
    const prs: PR[] = [];
    for (const prNumber of candidate.prNumbers) {
      const pr = db.getPRByNumber(repoId, prNumber);
      if (pr) prs.push(pr);
    }
    if (prs.length < 2) continue;
    prepared.push({ index: i, messages: buildVerifyPrompt(prs, llm) });
  }

  // 2. Call LLM (batch or sequential)
  const verifiedGroups: VerifiedGroup[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const useBatch = isBatchChatProvider(llm) && prepared.length > 1;
  verifyLog.info("LLM mode", { scanId, mode: useBatch ? "batch" : "sequential", prompts: prepared.length });

  // Check for existing batch ID from phaseCursor (resume support)
  const scan = db.getScan(scanId);
  const existingBatchId = (scan?.phaseCursor as Record<string, unknown> | null)?.verifyBatchId as string | undefined;

  if (useBatch) {
    verifyLog.info("Sending batch verification", { scanId, groups: prepared.length });
    const batchStart = Date.now();
    let results;
    try {
      results = await llm.chatBatch(
        prepared.map((p) => ({
          id: `verify-${p.index}`,
          messages: p.messages,
        })),
        {
          existingBatchId,
          onBatchCreated: (batchId) => {
            db.updateScanStatus(scanId, "verifying", {
              phaseCursor: { verifyBatchId: batchId },
            });
          },
        }
      );
    } catch (err) {
      db.updateScanStatus(scanId, "verifying", { phaseCursor: null });
      throw err;
    }
    const errored = results.filter((r) => r.error);
    verifyLog.info("Batch verification complete", {
      scanId,
      durationMs: Date.now() - batchStart,
      succeeded: results.length - errored.length,
      errored: errored.length,
    });
    for (const e of errored) {
      verifyLog.warn("Verify item failed", { id: e.id, error: e.error });
    }
    for (const result of results) {
      if (result.error) continue;
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

  verifyLog.info("Verified groups", { scanId, count: verifiedGroups.length, inputTokens: totalInputTokens, outputTokens: totalOutputTokens });

  return {
    verifiedGroups,
    tokenUsage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
  };
}

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

    // Delegate to standalone runVerify
    const { verifiedGroups, tokenUsage } = await runVerify({
      candidateGroups,
      scanId,
      repoId,
      accountId,
      resolver: this.resolver,
      db: this.db,
    });

    // Store accumulated token usage
    if (tokenUsage.inputTokens > 0 || tokenUsage.outputTokens > 0) {
      this.db.addScanTokens(scanId, tokenUsage.inputTokens, tokenUsage.outputTokens);
    }

    // Clear phaseCursor after successful completion
    this.db.updateScanStatus(scanId, "verifying", { phaseCursor: null });

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
