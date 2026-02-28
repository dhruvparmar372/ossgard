import { Activity, GitPullRequest, Coins, Zap } from "lucide-react";
import type { ScanSummary } from "@/lib/types";
import { formatTokens, formatCost, estimateTokenCost } from "@/lib/utils";

interface CumulativeStatsProps {
  scans: ScanSummary[];
}

export function CumulativeStats({ scans }: CumulativeStatsProps) {
  const totalScans = scans.length;
  const totalPrs = scans.reduce((s, scan) => s + scan.prCount, 0);
  const totalTokens = scans.reduce(
    (s, scan) => s + (scan.inputTokens ?? 0) + (scan.outputTokens ?? 0),
    0
  );

  // Estimate cost — use each scan's own model info when available
  const totalCost = scans.reduce((s, scan) => {
    const llmCost = estimateTokenCost(
      (scan.inputTokens ?? 0) - (scan.tokenUsage?.embedding?.input ?? 0),
      scan.outputTokens ?? 0,
      scan.llmModel
    );
    const embCost = estimateTokenCost(
      scan.tokenUsage?.embedding?.input ?? 0,
      0,
      scan.embeddingModel
    );
    return s + llmCost + embCost;
  }, 0);

  const stats = [
    { icon: Activity, label: "Total Scans", value: String(totalScans) },
    { icon: GitPullRequest, label: "PRs Analyzed", value: formatTokens(totalPrs) },
    { icon: Zap, label: "Tokens Used", value: formatTokens(totalTokens) },
    { icon: Coins, label: "Est. Cost", value: totalCost > 0 ? `~${formatCost(totalCost)}` : "—" },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {stats.map((stat) => (
        <div
          key={stat.label}
          className="rounded-sm border border-border bg-card px-4 py-3"
        >
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <stat.icon className="size-3" />
            {stat.label}
          </div>
          <div className="mt-1 font-mono text-lg font-semibold text-foreground">
            {stat.value}
          </div>
        </div>
      ))}
    </div>
  );
}
