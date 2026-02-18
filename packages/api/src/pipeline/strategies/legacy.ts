import type { DuplicateStrategy, StrategyContext, StrategyResult } from "../strategy.js";
import { runEmbed } from "../embed.js";
import { runCluster } from "../cluster.js";
import { runVerify } from "../verify.js";
import { runRank } from "../rank.js";

export class LegacyStrategy implements DuplicateStrategy {
  readonly name = "legacy" as const;

  async execute(ctx: StrategyContext): Promise<StrategyResult> {
    // 1. Embed
    await runEmbed(ctx);

    // 2. Cluster
    const candidateGroups = await runCluster(ctx);

    // 3. Verify
    const { verifiedGroups, tokenUsage: verifyTokens } = await runVerify({
      ...ctx,
      candidateGroups,
    });

    // 4. Rank
    const result = await runRank({
      ...ctx,
      verifiedGroups,
    });

    // Combine token usage from verify + rank
    return {
      groups: result.groups,
      tokenUsage: {
        inputTokens: verifyTokens.inputTokens + result.tokenUsage.inputTokens,
        outputTokens: verifyTokens.outputTokens + result.tokenUsage.outputTokens,
      },
    };
  }
}
