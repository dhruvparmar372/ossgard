# Repo Page Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign the repo detail page to show a duplicate trend chart, cumulative stats, and a scan navigation list instead of displaying latest scan results directly.

**Architecture:** Add `dupePrCount` to `ScanSummary` so the chart can compute duplicate % without loading full scan data. Create a hand-rolled SVG `DupeTrendChart` client component. Create a `CumulativeStats` server component. Rewrite the repo page layout. The scan detail page already has StatsBar + TokenUsageCard + ReviewCarousel and needs no changes.

**Tech Stack:** Next.js 16, React 19, Tailwind CSS 4, hand-rolled SVG

---

### Task 1: Add `dupePrCount` to ScanSummary

**Files:**
- Modify: `demo/src/lib/types.ts`
- Modify: `demo/src/data/index.ts`

**Step 1: Add field to ScanSummary type**

In `demo/src/lib/types.ts`, add `dupePrCount` to the `ScanSummary` interface after `dupeGroupCount`:

```typescript
export interface ScanSummary {
  id: number;
  completedAt: string;
  prCount: number;
  dupeGroupCount: number;
  dupePrCount: number;           // ← NEW
  inputTokens: number;
  outputTokens: number;
  tokenUsage: PhaseTokenUsage | null;
  llmProvider: string | null;
  llmModel: string | null;
  embeddingProvider: string | null;
  embeddingModel: string | null;
}
```

**Step 2: Compute dupePrCount in data discovery**

In `demo/src/data/index.ts`, inside the `discoverRepos()` function, compute `dupePrCount` when building each `ScanSummary`. The full `RepoScanData` is already loaded (variable `data`), so count members with `rank > 1`:

```typescript
return {
  id: data.scan.id,
  completedAt: data.scan.completedAt,
  prCount: data.scan.prCount,
  dupeGroupCount: data.scan.dupeGroupCount,
  dupePrCount: data.groups.reduce(
    (sum, g) => sum + g.members.filter((m) => m.rank > 1).length,
    0
  ),
  inputTokens: data.scan.inputTokens ?? 0,
  // ... rest unchanged
};
```

**Step 3: Verify build**

Run: `cd demo && npm run build`
Expected: Build succeeds (TypeScript may warn about unused fields elsewhere, but should compile).

**Step 4: Commit**

```
feat(demo): add dupePrCount to ScanSummary for chart data
```

---

### Task 2: Create DupeTrendChart component

**Files:**
- Create: `demo/src/components/dupe-trend-chart.tsx`

**Step 1: Create the client component**

This is a `"use client"` component that renders a hand-rolled SVG line chart. It receives an array of scan summaries (sorted oldest-first for the chart) and renders:

- X-axis: scan dates (short format like "Feb 26")
- Y-axis: duplicate % (0% to max+10%, rounded up)
- Line connecting the points
- Dots at each data point
- Latest point highlighted in primary color
- On hover: tooltip showing exact date, duplicate count, and %

```tsx
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
  const maxPct = Math.max(...pcts, 5); // minimum 5% ceiling
  const yMax = Math.ceil(maxPct / 5) * 5 + 5; // round up to next 5, add padding

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
```

**Step 2: Verify build**

Run: `cd demo && npm run build`
Expected: Build succeeds (component not used yet, but should compile).

**Step 3: Commit**

```
feat(demo): add DupeTrendChart SVG component
```

---

### Task 3: Create CumulativeStats component

**Files:**
- Create: `demo/src/components/cumulative-stats.tsx`

**Step 1: Create the component**

A server component that receives the scans array and computes totals across all scans.

```tsx
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
```

**Step 2: Verify build**

Run: `cd demo && npm run build`
Expected: Build succeeds.

**Step 3: Commit**

```
feat(demo): add CumulativeStats component
```

---

### Task 4: Rewrite repo page layout

**Files:**
- Modify: `demo/src/app/[owner]/[repo]/page.tsx`

**Step 1: Rewrite the page**

Replace the entire content of `demo/src/app/[owner]/[repo]/page.tsx` with:

```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Github, Clock } from "lucide-react";
import { repos, getRepoData } from "@/data";
import { DupeTrendChart } from "@/components/dupe-trend-chart";
import { CumulativeStats } from "@/components/cumulative-stats";

export function generateStaticParams() {
  if (repos.length === 0) return [{ owner: "_", repo: "_" }];
  return repos.map((r) => ({
    owner: r.repo.owner,
    repo: r.repo.name,
  }));
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function RepoPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string }>;
}) {
  const { owner, repo } = await params;
  const repoIndex = getRepoData(owner, repo);
  if (!repoIndex || repoIndex.scans.length === 0) notFound();

  return (
    <main className="min-h-svh px-6 py-12 sm:px-8">
      <div className="mx-auto max-w-5xl">
        {/* Header */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="inline-flex items-center justify-center rounded-sm border border-border p-2 text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Back to home"
            >
              <ArrowLeft className="size-4" />
            </Link>
            <h1 className="font-mono text-xl font-bold tracking-tight text-foreground sm:text-2xl">
              {owner}/{repo}
            </h1>
          </div>
          <a
            href={repoIndex.repo.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-sm border border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`View ${owner}/${repo} on GitHub`}
          >
            <Github className="size-4" />
            <span className="hidden sm:inline">GitHub</span>
          </a>
        </div>

        {/* Duplicate Trend Chart */}
        <div className="mt-8">
          <DupeTrendChart scans={repoIndex.scans} owner={owner} repo={repo} />
        </div>

        {/* Cumulative Stats */}
        <div className="mt-4">
          <CumulativeStats scans={repoIndex.scans} />
        </div>

        {/* Scan History */}
        <div className="mt-8">
          <h2 className="flex items-center gap-2 text-sm font-medium uppercase tracking-wider text-muted-foreground">
            <Clock className="size-3.5" />
            Scan History
          </h2>
          <div className="mt-3 space-y-1">
            {repoIndex.scans.map((scan, i) => {
              const pct = scan.prCount > 0
                ? Math.round((scan.dupePrCount / scan.prCount) * 100)
                : 0;
              return (
                <Link
                  key={scan.id}
                  href={`/${owner}/${repo}/scan/${scan.id}`}
                  className={`flex items-center justify-between rounded-sm border px-4 py-2.5 text-sm transition-colors ${
                    i === 0
                      ? "border-primary/30 bg-primary/5 text-foreground"
                      : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className="font-mono">{formatDate(scan.completedAt)}</span>
                    {i === 0 && (
                      <span className="rounded-sm bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
                        Latest
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-4 font-mono text-xs">
                    <span>{scan.prCount} PRs</span>
                    <span>{scan.dupeGroupCount} groups</span>
                    <span className="text-primary">{pct}%</span>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </main>
  );
}
```

Key changes vs. current:
- Removed: `StatsBar`, `ReviewCarousel`, `TokenUsageCard`, `DownloadButton`, `getLatestScan` import
- Added: `DupeTrendChart`, `CumulativeStats`
- Scan history always shown (not conditionally)
- All scan links go to `/scan/{id}` (including latest — no special-case `i === 0` linking to repo page)
- Each scan row shows duplicate % alongside PR count and group count

**Step 2: Verify build**

Run: `cd demo && npm run build`
Expected: Build succeeds, all pages generated.

**Step 3: Commit**

```
feat(demo): redesign repo page with trend chart, cumulative stats, and scan list
```

---

### Task 5: Verify visually

**Step 1: Start dev server and check pages**

Run: `cd demo && npm run dev`

Check:
- http://localhost:3000/ossgard/openclaw/openclaw — shows chart, cumulative stats, scan list
- Chart dots are visible, hovering shows tooltip with date and duplicate %
- Cumulative stats show total scans, PRs, tokens, estimated cost
- Scan list rows are clickable and navigate to scan detail pages
- http://localhost:3000/ossgard/openclaw/openclaw/scan/51 — still shows StatsBar + TokenUsageCard + ReviewCarousel (unchanged)
