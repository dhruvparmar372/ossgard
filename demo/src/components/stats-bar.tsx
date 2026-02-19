import {
  type RepoScanData,
  countDuplicatePrs,
  duplicatePercentage,
} from "@/lib/types";
import { GitPullRequest, Copy } from "lucide-react";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function StatsBar({ data }: { data: RepoScanData }) {
  const dupes = countDuplicatePrs(data);
  const pct = duplicatePercentage(data);

  return (
    <div className="space-y-3">
      {/* Primary stat: duplicates found */}
      <div className="rounded-sm border border-primary/30 bg-primary/5 p-5">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-primary">
          <Copy className="size-3.5" />
          Duplicates Found
        </div>
        <div className="mt-2 flex items-baseline gap-3">
          <span className="font-mono text-3xl font-bold text-foreground">
            {dupes}
          </span>
          <span className="font-mono text-lg text-primary">
            {pct}%
          </span>
          <span className="text-sm text-muted-foreground">
            of open PRs are duplicates
          </span>
        </div>
      </div>

      {/* Secondary stats row */}
      <div className="flex items-center gap-6 rounded-sm border border-border bg-card px-5 py-3 text-sm">
        <div className="flex items-center gap-2 text-muted-foreground">
          <GitPullRequest className="size-3.5" />
          <span className="font-mono font-medium text-foreground">
            {data.scan.prCount.toLocaleString()}
          </span>
          PRs analyzed
        </div>
        <div className="h-4 w-px bg-border" />
        <div className="text-muted-foreground">
          Last scanned {formatDate(data.scan.completedAt)}
        </div>
      </div>
    </div>
  );
}
