import type { Job, PR } from "@ossgard/shared";
import type { Database } from "../db/database.js";
import type { LLMProvider } from "../services/llm-provider.js";
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

export class VerifyProcessor implements JobProcessor {
  readonly type = "verify";

  constructor(
    private db: Database,
    private llm: LLMProvider,
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

    const verifiedGroups: VerifiedGroup[] = [];

    for (const candidate of candidateGroups) {
      // Look up full PR data from DB
      const prs: PR[] = [];
      for (const prNumber of candidate.prNumbers) {
        const pr = this.db.getPRByNumber(repoId, prNumber);
        if (pr) {
          prs.push(pr);
        }
      }

      if (prs.length < 2) continue;

      // Send to LLM with buildVerifyPrompt
      const messages = buildVerifyPrompt(prs);
      const response = (await this.llm.chat(messages)) as {
        groups: Array<{
          prIds: number[];
          label: string;
          confidence: number;
          relationship: string;
        }>;
        unrelated: number[];
      };

      // Collect verified groups (only groups with 2+ PRs)
      const groups = Array.isArray(response.groups) ? response.groups : [];
      for (const group of groups) {
        if (Array.isArray(group.prIds) && group.prIds.length >= 2) {
          verifiedGroups.push({
            prIds: group.prIds,
            label: group.label ?? "Unknown",
            confidence: group.confidence ?? 0,
            relationship: group.relationship ?? "unknown",
          });
        }
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
