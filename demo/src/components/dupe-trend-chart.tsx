"use client";

import { useState } from "react";
import type { ScanSummary } from "@/lib/types";

interface DupeTrendChartProps {
  scans: ScanSummary[];
  owner: string;
  repo: string;
}

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function dupePct(scan: ScanSummary): number {
  if (scan.prCount === 0) return 0;
  return Math.round((scan.dupePrCount / scan.prCount) * 100);
}

export function DupeTrendChart({ scans, owner, repo }: DupeTrendChartProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  // Sort oldest first for left-to-right display
  const sorted = [...scans].sort((a, b) => a.id - b.id);
  const pcts = sorted.map(dupePct);
  const maxPct = Math.max(...pcts, 5);
  const yMax = Math.ceil(maxPct / 5) * 5 + 5;

  // Chart dimensions
  const W = 700;
  const H = 200;
  const PAD = { top: 20, right: 20, bottom: 40, left: 45 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  // Scale functions
  const xStep = sorted.length > 1 ? plotW / (sorted.length - 1) : plotW / 2;
  const x = (i: number) => PAD.left + (sorted.length > 1 ? i * xStep : plotW / 2);
  const y = (pct: number) => PAD.top + plotH - (pct / yMax) * plotH;

  // Build polyline points
  const linePoints = pcts.map((p, i) => `${x(i)},${y(p)}`).join(" ");

  // Y-axis ticks
  const yTickCount = Math.min(5, yMax / 5);
  const yTicks = Array.from({ length: yTickCount + 1 }, (_, i) =>
    Math.round((yMax / yTickCount) * i)
  );

  const hovered = hoveredIndex !== null ? sorted[hoveredIndex] : null;

  return (
    <div className="rounded-sm border border-border bg-card p-5">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Duplicate Trend
      </h3>
      <div className="relative mt-3">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full"
          style={{ maxHeight: "250px" }}
        >
          {/* Grid lines */}
          {yTicks.map((tick) => (
            <g key={tick}>
              <line
                x1={PAD.left}
                y1={y(tick)}
                x2={W - PAD.right}
                y2={y(tick)}
                stroke="currentColor"
                className="text-border"
                strokeDasharray={tick === 0 ? "none" : "4,4"}
                strokeWidth={tick === 0 ? 1 : 0.5}
              />
              <text
                x={PAD.left - 8}
                y={y(tick) + 4}
                textAnchor="end"
                className="fill-muted-foreground"
                fontSize="11"
                fontFamily="monospace"
              >
                {tick}%
              </text>
            </g>
          ))}

          {/* Line */}
          {sorted.length > 1 && (
            <polyline
              points={linePoints}
              fill="none"
              stroke="currentColor"
              className="text-primary"
              strokeWidth="2"
              strokeLinejoin="round"
            />
          )}

          {/* Data points */}
          {pcts.map((p, i) => (
            <g key={sorted[i].id}>
              <circle
                cx={x(i)}
                cy={y(p)}
                r={hoveredIndex === i ? 6 : i === sorted.length - 1 ? 5 : 4}
                fill={i === sorted.length - 1 ? "currentColor" : "var(--background, #fff)"}
                stroke="currentColor"
                className="text-primary"
                strokeWidth="2"
              />
              {/* Invisible larger hit area */}
              <circle
                cx={x(i)}
                cy={y(p)}
                r="15"
                fill="transparent"
                onMouseEnter={() => setHoveredIndex(i)}
                onMouseLeave={() => setHoveredIndex(null)}
                className="cursor-pointer"
              />
            </g>
          ))}

          {/* X-axis labels */}
          {sorted.map((scan, i) => (
            <text
              key={scan.id}
              x={x(i)}
              y={H - 8}
              textAnchor="middle"
              className="fill-muted-foreground"
              fontSize="10"
              fontFamily="monospace"
            >
              {formatShortDate(scan.completedAt)}
            </text>
          ))}
        </svg>

        {/* Tooltip */}
        {hovered && hoveredIndex !== null && (
          <div
            className="pointer-events-none absolute -translate-x-1/2 rounded-sm border border-border bg-card px-3 py-2 text-xs shadow-md"
            style={{
              left: `${(x(hoveredIndex) / W) * 100}%`,
              top: `${(y(pcts[hoveredIndex]) / H) * 100 - 15}%`,
            }}
          >
            <div className="font-mono font-medium text-foreground">
              {dupePct(hovered)}% duplicates
            </div>
            <div className="text-muted-foreground">
              {hovered.dupePrCount} of {hovered.prCount} PRs
            </div>
            <div className="text-muted-foreground">
              {new Date(hovered.completedAt).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
