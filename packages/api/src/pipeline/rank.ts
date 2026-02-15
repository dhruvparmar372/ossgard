import type { Job, PR } from "@ossgard/shared";
import type { Database } from "../db/database.js";
import type { LLMProvider } from "../services/llm-provider.js";
import type { JobProcessor } from "../queue/worker.js";
import { buildRankPrompt } from "./prompts.js";

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

export class RankProcessor implements JobProcessor {
  readonly type = "rank";

  constructor(
    private db: Database,
    private llm: LLMProvider
  ) {}

  async process(job: Job): Promise<void> {
    const { repoId, scanId, verifiedGroups } = job.payload as {
      repoId: number;
      scanId: number;
      owner: string;
      repo: string;
      verifiedGroups: VerifiedGroup[];
    };

    // Update scan status to "ranking"
    this.db.updateScanStatus(scanId, "ranking");

    let totalGroups = 0;

    for (const group of verifiedGroups) {
      // Look up full PR data
      const prs: PR[] = [];
      for (const prId of group.prIds) {
        const pr = this.db.getPR(prId);
        if (pr) {
          prs.push(pr);
        }
      }

      if (prs.length < 2) continue;

      // Send to LLM with buildRankPrompt
      const messages = buildRankPrompt(prs, group.label);
      const response = (await this.llm.chat(messages)) as {
        rankings: RankingResult[];
      };

      // Sort by score descending
      const sortedRankings = [...response.rankings].sort(
        (a, b) => b.score - a.score
      );

      // Insert dupe_group
      const dupeGroup = this.db.insertDupeGroup(
        scanId,
        repoId,
        group.label,
        prs.length
      );

      // Insert dupe_group_members
      for (let rank = 0; rank < sortedRankings.length; rank++) {
        const ranking = sortedRankings[rank];

        // Find the PR ID for this PR number
        const pr = prs.find((p) => p.number === ranking.prNumber);
        if (!pr) continue;

        this.db.insertDupeGroupMember(
          dupeGroup.id,
          pr.id,
          rank + 1, // 1-indexed rank
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
  }
}
