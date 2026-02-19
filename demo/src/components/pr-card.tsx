import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { DupeGroupMember } from "@/lib/types";

interface PrCardProps {
  member: DupeGroupMember;
  variant: "merge" | "close";
}

export function PrCard({ member, variant }: PrCardProps) {
  const isMerge = variant === "merge";

  return (
    <div
      className={`rounded-sm border p-4 ${
        isMerge
          ? "border-primary/40 bg-primary/5 shadow-[0_0_12px_-3px] shadow-primary/20"
          : "border-border bg-card"
      }`}
    >
      {/* State badge (only if not open) */}
      {member.state !== "open" && (
        <div className="mb-2">
          <Badge variant="outline" className="rounded-sm text-[10px] capitalize text-muted-foreground">
            {member.state}
          </Badge>
        </div>
      )}

      {/* PR title as link */}
      <a
        href={member.url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 rounded-sm text-sm font-medium text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="line-clamp-2">{member.title}</span>
        <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
      </a>

      {/* Meta row: author, score, PR number */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>@{member.author}</span>
        <span className="font-mono font-medium text-foreground">
          {member.score.toFixed(1)}
        </span>
        <span className="font-mono">#{member.prNumber}</span>
      </div>
    </div>
  );
}
