"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PrCard } from "@/components/pr-card";
import type { DupeGroup } from "@/lib/types";

interface ReviewCarouselProps {
  groups: DupeGroup[];
}

export function ReviewCarousel({ groups }: ReviewCarouselProps) {
  const [currentIndex, setCurrentIndex] = useState(0);

  if (groups.length === 0) {
    return null;
  }

  const group = groups[currentIndex];
  const recommended = group.members.find((m) => m.rank === 1);
  const duplicates = group.members
    .filter((m) => m.rank > 1)
    .sort((a, b) => a.rank - b.rank);

  return (
    <section className="mt-10">
      {/* Section heading */}
      <h2 className="font-mono text-lg font-bold tracking-tight text-foreground">
        Review Duplicates
      </h2>

      {/* Navigation bar */}
      <div className="mt-4 flex items-center justify-between rounded-sm border border-border bg-card px-4 py-2">
        <span className="text-sm text-muted-foreground">
          Reviewing set{" "}
          <span className="font-mono font-medium text-foreground">
            {currentIndex + 1}
          </span>{" "}
          of{" "}
          <span className="font-mono font-medium text-foreground">
            {groups.length}
          </span>
        </span>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setCurrentIndex((i) => i - 1)}
            disabled={currentIndex === 0}
            aria-label="Previous group"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setCurrentIndex((i) => i + 1)}
            disabled={currentIndex === groups.length - 1}
            aria-label="Next group"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      {/* Group label */}
      <h3 className="mt-6 font-mono text-sm font-semibold text-foreground">
        {group.label}
      </h3>

      {/* Recommended to merge */}
      {recommended && (
        <div className="mt-4">
          <h4 className="text-xs font-medium uppercase tracking-wider text-primary">
            Recommended to merge
          </h4>
          <div className="mt-2">
            <PrCard member={recommended} variant="merge" />
          </div>
        </div>
      )}

      {/* Duplicates to close */}
      {duplicates.length > 0 && (
        <div className="mt-6">
          <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Duplicates to close
          </h4>
          <div className="mt-2 space-y-2">
            {duplicates.map((member) => (
              <PrCard key={member.prNumber} member={member} variant="close" />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
