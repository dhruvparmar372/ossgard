import Link from "next/link";
import { Github, ExternalLink } from "lucide-react";
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
  const { owner, name, url } = data.repo;
  const dupes = countDuplicatePrs(data);
  const pct = duplicatePercentage(data);

  return (
    <div className="group relative rounded-sm border border-border bg-card p-5 transition-colors hover:border-primary/40 hover:bg-card/80">
      {/* Full-card link (sits behind content) */}
      <Link
        href={`/${owner}/${name}`}
        className="absolute inset-0 z-0 rounded-sm"
        aria-label={`View scan results for ${owner}/${name}`}
      />

      {/* Header: repo name + GitHub link */}
      <div className="relative z-10 flex items-start justify-between gap-3">
        <h3 className="font-mono text-base font-semibold text-foreground transition-colors group-hover:text-primary">
          {owner}/{name}
        </h3>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          aria-label={`View ${owner}/${name} on GitHub`}
        >
          <Github className="size-4" />
        </a>
      </div>

      {/* Scan date */}
      <p className="relative z-0 mt-3 text-sm text-muted-foreground">
        Scanned {formatDate(data.scan.completedAt)}
      </p>

      {/* Stats */}
      <div className="relative z-0 mt-4 flex items-center gap-2 font-mono text-sm">
        <span className="font-medium text-primary">{dupes}</span>
        <span className="text-muted-foreground">
          duplicate PRs found ({pct}%)
        </span>
      </div>

      {/* Footer hint */}
      <div className="relative z-0 mt-4 flex items-center gap-1.5 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
        <span>View details</span>
        <ExternalLink className="size-3" />
      </div>
    </div>
  );
}
