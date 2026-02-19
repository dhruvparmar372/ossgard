import Link from "next/link";
import { ArrowRight } from "lucide-react";
import {
  type RepoScanData,
  countDuplicatePrs,
  duplicatePercentage,
} from "@/lib/types";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function RepoCard({ data }: { data: RepoScanData }) {
  const { owner, name } = data.repo;
  const dupes = countDuplicatePrs(data);
  const pct = duplicatePercentage(data);

  return (
    <Link
      href={`/${owner}/${name}`}
      className="group block rounded-sm border border-border bg-card p-5 transition-colors hover:border-primary/40 hover:bg-card/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <h3 className="font-mono text-base font-semibold text-foreground transition-colors group-hover:text-primary">
        {owner}/{name}
      </h3>

      <p className="mt-3 text-sm text-muted-foreground">
        Scanned {formatDate(data.scan.completedAt)}
      </p>

      <div className="mt-4 flex items-center gap-2 font-mono text-sm">
        <span className="font-medium text-primary">{dupes}</span>
        <span className="text-muted-foreground">
          duplicate PRs found ({pct}%)
        </span>
      </div>

      <div className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
        <span>View details</span>
        <ArrowRight className="size-3" />
      </div>
    </Link>
  );
}
