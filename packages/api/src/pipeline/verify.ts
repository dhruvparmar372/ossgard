import type { Job, PR } from "@ossgard/shared";
import type { Database } from "../db/database.js";
import type { ChatProvider, Message } from "../services/llm-provider.js";
import { isBatchChatProvider } from "../services/llm-provider.js";
import type { JobQueue } from "../queue/types.js";
import type { JobProcessor } from "../queue/worker.js";
import { buildVerifyPrompt } from "./prompts.js";

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

export class VerifyProcessor implements JobProcessor {
  readonly type = "verify";

  constructor(
    private db: Database,
    private llm: ChatProvider,
    private queue?: JobQueue
  ) {}

  async process(job: Job): Promise<void> {
    const { repoId, scanId, owner, repo, candidateGroups } = job.payload as {
      repoId: number;
      scanId: number;
      owner: string;
      repo: string;
      candidateGroups: CandidateGroup[];
    };

    // Update scan status to "verifying"
    this.db.updateScanStatus(scanId, "verifying");

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

    if (isBatchChatProvider(this.llm) && prepared.length > 1) {
      const results = await this.llm.chatBatch(
        prepared.map((p) => ({
          id: `verify-${p.index}`,
          messages: p.messages,
        }))
      );
      for (const result of results) {
        verifiedGroups.push(
          ...collectVerifiedGroups(result.response as VerifyResponse)
        );
      }
    } else {
      for (const p of prepared) {
        const response = (await this.llm.chat(
          p.messages
        )) as VerifyResponse;
        verifiedGroups.push(...collectVerifiedGroups(response));
      }
    }

    // Enqueue rank job with verifiedGroups
    if (this.queue) {
      await this.queue.enqueue({
        type: "rank",
        payload: { repoId, scanId, owner, repo, verifiedGroups },
      });
    }
  }
}
