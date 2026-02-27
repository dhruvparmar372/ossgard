import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { RepoScanIndex } from "@/lib/types";
import { formatTokens } from "@/lib/utils";

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function RepoCard({ data }: { data: RepoScanIndex }) {
  const { owner, name } = data.repo;
  const latest = data.scans[0];
  const totalTokens = data.scans.reduce(
    (sum, s) => sum + (s.inputTokens ?? 0) + (s.outputTokens ?? 0),
    0
  );
  if (!latest) return null;

  return (
    <Link
      href={`/${owner}/${name}`}
      className="group block rounded-sm border border-border bg-card p-5 transition-colors hover:border-primary/40 hover:bg-card/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <h3 className="font-mono text-base font-semibold text-foreground transition-colors group-hover:text-primary">
        {owner}/{name}
      </h3>

      <p className="mt-3 text-sm text-muted-foreground">
        Last scanned {timeAgo(latest.completedAt)}
      </p>

      <div className="mt-4 flex items-center gap-4 font-mono text-sm">
        <span>
          <span className="font-medium text-primary">{latest.dupeGroupCount}</span>{" "}
          <span className="text-muted-foreground">groups</span>
        </span>
        <span>
          <span className="font-medium text-foreground">{latest.prCount}</span>{" "}
          <span className="text-muted-foreground">PRs</span>
        </span>
        {data.scans.length > 1 && (
          <span className="text-muted-foreground">
            {data.scans.length} scans
          </span>
        )}
        {totalTokens > 0 && (
          <span>
            <span className="font-medium text-foreground">{formatTokens(totalTokens)}</span>{" "}
            <span className="text-muted-foreground">tokens</span>
          </span>
        )}
      </div>

      <div className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
        <span>View details</span>
        <ArrowRight className="size-3" />
      </div>
    </Link>
  );
}
