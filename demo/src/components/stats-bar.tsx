import {
  type RepoScanData,
  countDuplicatePrs,
  duplicatePercentage,
} from "@/lib/types";
import { Calendar, GitPullRequest, Copy } from "lucide-react";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function StatCard({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-sm border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        <span>{label}</span>
      </div>
      <div className="mt-2 font-mono text-lg font-semibold text-foreground">
        {value}
        {detail && (
          <span className="ml-1.5 text-sm font-normal text-muted-foreground">
            {detail}
          </span>
        )}
      </div>
    </div>
  );
}

export function StatsBar({ data }: { data: RepoScanData }) {
  const dupes = countDuplicatePrs(data);
  const pct = duplicatePercentage(data);

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <StatCard
        icon={Calendar}
        label="Scanned"
        value={formatDate(data.scan.completedAt)}
      />
      <StatCard
        icon={GitPullRequest}
        label="PRs Analyzed"
        value={data.scan.prCount.toLocaleString()}
      />
      <StatCard
        icon={Copy}
        label="Duplicates Found"
        value={String(dupes)}
        detail={`(${pct}%)`}
      />
    </div>
  );
}
