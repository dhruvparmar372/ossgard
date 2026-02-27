# Token Usage Display in Demo App — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add token usage and estimated cost display to the demo app for each scan and cumulative per repo.

**Architecture:** Add utility functions for formatting/pricing, a new TokenUsageCard server component, wire it into both scan pages, update repo cards with cumulative totals, and add a --refresh flag to the pull-data script so older scans get re-downloaded with new token fields.

**Tech Stack:** Next.js 16, React 19, Tailwind CSS 4, TypeScript

---

### Task 1: Add `--refresh` flag to pull-data script

**Files:**
- Modify: `demo/scripts/pull-scan-data.ts`

**Step 1: Add the --refresh flag parsing**

Near line 108, after the `getFlag` function, add:

```typescript
const refresh = args.includes("--refresh");
```

**Step 2: Use the flag to skip the "already exists" check**

Change the skip logic at line 183 from:

```typescript
if (existsSync(filepath)) {
  continue; // already downloaded
}
```

to:

```typescript
if (existsSync(filepath) && !refresh) {
  continue; // already downloaded
}
```

**Step 3: Run the script with --refresh to pull fresh data**

Run: `cd demo && npm run pull-data -- --refresh`

Verify: All scan files in `demo/src/data/openclaw-openclaw/` now contain `tokenUsage`, `inputTokens`, `outputTokens`, and model fields. New scans (49, 50) are also pulled.

**Step 4: Commit**

```bash
git add demo/scripts/pull-scan-data.ts
git commit -m "feat(demo): add --refresh flag to pull-data script"
```

---

### Task 2: Add formatting and pricing utilities

**Files:**
- Modify: `demo/src/lib/utils.ts`

**Step 1: Add the utility functions**

Append to `demo/src/lib/utils.ts`:

```typescript
/** Format a number with commas: 2942670 → "2,942,670" */
export function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}

/** Format USD: 0.087 → "$0.09", 1.234 → "$1.23" */
export function formatCost(usd: number): string {
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

// Pricing per million tokens (as of Feb 2026)
const MODEL_PRICING: Record<string, { input: number; output?: number }> = {
  "gpt-5-nano":               { input: 0.05, output: 0.40 },
  "text-embedding-3-small":   { input: 0.02 },
  "text-embedding-3-large":   { input: 0.13 },
};

/** Estimate cost for a given token count and model */
export function estimateTokenCost(
  inputTokens: number,
  outputTokens: number,
  model: string | null
): number {
  const pricing = model ? MODEL_PRICING[model] : undefined;
  if (!pricing) return 0;
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = pricing.output ? (outputTokens / 1_000_000) * pricing.output : 0;
  return inputCost + outputCost;
}
```

**Step 2: Commit**

```bash
git add demo/src/lib/utils.ts
git commit -m "feat(demo): add token formatting and cost estimation utilities"
```

---

### Task 3: Create TokenUsageCard component

**Files:**
- Create: `demo/src/components/token-usage-card.tsx`

**Step 1: Create the component**

```tsx
import { Cpu, Database } from "lucide-react";
import type { PhaseTokenUsage } from "@/lib/types";
import { formatTokens, formatCost, estimateTokenCost } from "@/lib/utils";

interface TokenUsageCardProps {
  tokenUsage: PhaseTokenUsage;
  llmModel: string | null;
  embeddingModel: string | null;
}

function Row({
  label,
  input,
  output,
  cost,
}: {
  label: string;
  input: number;
  output?: number;
  cost: number;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex items-center gap-6 font-mono text-xs">
        <span className="text-foreground">
          {formatTokens(input)} in
          {output !== undefined && ` / ${formatTokens(output)} out`}
        </span>
        <span className="w-16 text-right text-muted-foreground">
          ~{formatCost(cost)}
        </span>
      </div>
    </div>
  );
}

export function TokenUsageCard({
  tokenUsage,
  llmModel,
  embeddingModel,
}: TokenUsageCardProps) {
  const embeddingCost = estimateTokenCost(
    tokenUsage.embedding.input,
    0,
    embeddingModel
  );

  const phases = [
    { label: "Intent", ...tokenUsage.intent },
    { label: "Verify", ...tokenUsage.verify },
    { label: "Rank", ...tokenUsage.rank },
  ];

  const llmPhaseCosts = phases.map((p) =>
    estimateTokenCost(p.input, p.output, llmModel)
  );
  const totalLlmCost = llmPhaseCosts.reduce((a, b) => a + b, 0);

  const totalInput =
    tokenUsage.embedding.input +
    phases.reduce((s, p) => s + p.input, 0);
  const totalOutput = phases.reduce((s, p) => s + p.output, 0);
  const totalCost = embeddingCost + totalLlmCost;

  return (
    <div className="rounded-sm border border-border bg-card">
      <div className="border-b border-border px-5 py-3">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Token Usage
        </h3>
      </div>

      {/* Embeddings */}
      <div className="border-b border-border px-5 py-3">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Database className="size-3" />
          Embeddings
          {embeddingModel && (
            <span className="font-mono font-normal">({embeddingModel})</span>
          )}
        </div>
        <div className="mt-1">
          <Row
            label="Embed PRs"
            input={tokenUsage.embedding.input}
            cost={embeddingCost}
          />
        </div>
      </div>

      {/* LLM */}
      <div className="border-b border-border px-5 py-3">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Cpu className="size-3" />
          LLM
          {llmModel && (
            <span className="font-mono font-normal">({llmModel})</span>
          )}
        </div>
        <div className="mt-1">
          {phases.map((p, i) => (
            <Row
              key={p.label}
              label={p.label}
              input={p.input}
              output={p.output}
              cost={llmPhaseCosts[i]}
            />
          ))}
        </div>
      </div>

      {/* Total */}
      <div className="px-5 py-3">
        <div className="flex items-center justify-between gap-4 text-sm font-medium">
          <span className="text-foreground">Total</span>
          <div className="flex items-center gap-6 font-mono text-xs">
            <span className="text-foreground">
              {formatTokens(totalInput)} in / {formatTokens(totalOutput)} out
            </span>
            <span className="w-16 text-right text-primary font-medium">
              ~{formatCost(totalCost)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add demo/src/components/token-usage-card.tsx
git commit -m "feat(demo): add TokenUsageCard component"
```

---

### Task 4: Wire TokenUsageCard into scan detail pages

**Files:**
- Modify: `demo/src/app/[owner]/[repo]/page.tsx`
- Modify: `demo/src/app/[owner]/[repo]/scan/[scanId]/page.tsx`

**Step 1: Add to repo page (latest scan)**

In `demo/src/app/[owner]/[repo]/page.tsx`, add import:

```typescript
import { TokenUsageCard } from "@/components/token-usage-card";
```

After the `<StatsBar>` section (after line 74 `</div>`), add:

```tsx
{/* Token Usage */}
{latestScan.scan.tokenUsage && (
  <div className="mt-3">
    <TokenUsageCard
      tokenUsage={latestScan.scan.tokenUsage}
      llmModel={latestScan.scan.llmModel}
      embeddingModel={latestScan.scan.embeddingModel}
    />
  </div>
)}
```

**Step 2: Add to scan detail page**

In `demo/src/app/[owner]/[repo]/scan/[scanId]/page.tsx`, add import:

```typescript
import { TokenUsageCard } from "@/components/token-usage-card";
```

After the `<StatsBar>` section (after line 76 `</div>`), add:

```tsx
{/* Token Usage */}
{data.scan.tokenUsage && (
  <div className="mt-3">
    <TokenUsageCard
      tokenUsage={data.scan.tokenUsage}
      llmModel={data.scan.llmModel}
      embeddingModel={data.scan.embeddingModel}
    />
  </div>
)}
```

**Step 3: Commit**

```bash
git add demo/src/app/[owner]/[repo]/page.tsx demo/src/app/[owner]/[repo]/scan/[scanId]/page.tsx
git commit -m "feat(demo): display token usage on scan detail pages"
```

---

### Task 5: Add cumulative token stats to repo cards on home page

**Files:**
- Modify: `demo/src/components/repo-card.tsx`

**Step 1: Compute and display cumulative tokens**

Import `formatTokens` at the top:

```typescript
import { formatTokens } from "@/lib/utils";
```

After `const latest = data.scans[0];`, compute totals:

```typescript
const totalTokens = data.scans.reduce(
  (sum, s) => sum + (s.inputTokens ?? 0) + (s.outputTokens ?? 0),
  0
);
```

In the stats div (the `<div className="mt-4 flex items-center gap-4 font-mono text-sm">` block), add after the existing scans count span:

```tsx
{totalTokens > 0 && (
  <span>
    <span className="font-medium text-foreground">{formatTokens(totalTokens)}</span>{" "}
    <span className="text-muted-foreground">tokens</span>
  </span>
)}
```

**Step 2: Commit**

```bash
git add demo/src/components/repo-card.tsx
git commit -m "feat(demo): show cumulative token usage on repo cards"
```

---

### Task 6: Build and verify

**Step 1: Pull fresh data with --refresh**

Run: `cd demo && npm run pull-data -- --refresh`

Verify scans 49 and 50 are pulled and older scans now have token data.

**Step 2: Build the demo site**

Run: `cd demo && npm run build`

Verify: No TypeScript errors, build succeeds.

**Step 3: Start dev server and visually verify**

Run: `cd demo && npm run dev`

Check:
- Home page: repo card shows total tokens and scan count
- Repo page: latest scan shows TokenUsageCard with per-phase breakdown and costs
- Scan history: clicking an older scan with token data shows the card; older scans without it gracefully hide it
- Numbers are comma-formatted, costs show ~$X.XX format
