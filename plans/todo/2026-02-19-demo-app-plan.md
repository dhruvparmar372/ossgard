# Demo App Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a static Next.js showcase app at `/demo` that displays ossgard scan results with a dev-tools aesthetic, letting visitors browse duplicate PR findings and optionally close duplicates via GitHub API.

**Architecture:** Next.js App Router with `output: 'export'` for static generation. Per-repo JSON data files imported at build time. Only client-side network calls are GitHub API requests to close PRs. Tailwind CSS + shadcn/ui primitives restyled with a developer-tools / open-source theme.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS v4, shadcn/ui (new-york style, restyled), lucide-react, npm

**Design doc:** `docs/plans/2026-02-19-demo-app-design.md`

---

### Task 1: Scaffold Next.js Project

**Files:**
- Create: `demo/` directory with all Next.js boilerplate

**Step 1: Create Next.js app**

```bash
cd /Users/dhruv/Code/ossgard
npx create-next-app@latest demo --typescript --tailwind --eslint --app --src-dir --no-turbopack --import-alias "@/*"
```

When prompted:
- Use `src/` directory: Yes
- Use App Router: Yes

**Step 2: Configure static export**

Edit `demo/next.config.ts`:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
};

export default nextConfig;
```

**Step 3: Verify it builds**

```bash
cd /Users/dhruv/Code/ossgard/demo && npm run build
```

Expected: Build succeeds, `out/` directory created.

**Step 4: Commit**

```bash
cd /Users/dhruv/Code/ossgard
git add demo/
git commit -m "chore: scaffold Next.js demo app with static export"
```

---

### Task 2: Initialize shadcn/ui + Custom Theme

**Files:**
- Modify: `demo/src/app/globals.css`
- Create: `demo/components.json`
- Create: `demo/src/lib/utils.ts`

**Step 1: Initialize shadcn/ui**

```bash
cd /Users/dhruv/Code/ossgard/demo
npx shadcn@latest init
```

Select:
- Style: New York
- Base color: Zinc
- CSS variables: Yes

**Step 2: Add required shadcn components**

```bash
cd /Users/dhruv/Code/ossgard/demo
npx shadcn@latest add button dialog badge
```

**Step 3: Customize the theme in globals.css**

Apply a developer-tools aesthetic to the CSS variables. Key changes:
- Dark mode as default
- Monospace font for headings/data (`font-mono` class via JetBrains Mono or similar from next/font)
- Sharp edges (border-radius: 0 or 2px)
- Muted dark palette (zinc-900 bg, zinc-100 fg)
- Accent color: emerald/green for merge, amber/orange for close, cyan for links

Update `demo/src/app/layout.tsx` to:
- Import `JetBrains_Mono` from `next/font/google` as the monospace font
- Import `Inter` as the sans-serif body font
- Set metadata: title "ossgard demo", description "Duplicate PR detection for open source"
- Apply dark theme by default (add `dark` class to `<html>`)

**Step 4: Verify dev server renders**

```bash
cd /Users/dhruv/Code/ossgard/demo && npm run dev
```

Expected: Dev server starts, dark themed page visible at localhost:3000.

**Step 5: Commit**

```bash
cd /Users/dhruv/Code/ossgard
git add demo/
git commit -m "feat(demo): initialize shadcn/ui with dev-tools theme"
```

---

### Task 3: Data Layer — Types, Sample Data, Barrel Export

**Files:**
- Create: `demo/src/lib/types.ts`
- Create: `demo/src/data/sample-org-sample-repo.json`
- Create: `demo/src/data/index.ts`

**Step 1: Create types file**

Create `demo/src/lib/types.ts`:

```typescript
export interface RepoScanData {
  repo: {
    owner: string;
    name: string;
    url: string;
  };
  scan: {
    id: number;
    completedAt: string;
    prCount: number;
    dupeGroupCount: number;
  };
  groups: Array<DupeGroup>;
}

export interface DupeGroup {
  id: number;
  label: string;
  members: Array<DupeGroupMember>;
}

export interface DupeGroupMember {
  prNumber: number;
  title: string;
  author: string;
  state: "open" | "closed" | "merged";
  rank: number;
  score: number;
  rationale: string;
  url: string;
}

/** Count of PRs recommended to close (rank > 1) across all groups */
export function countDuplicatePrs(data: RepoScanData): number {
  return data.groups.reduce(
    (sum, g) => sum + g.members.filter((m) => m.rank > 1).length,
    0
  );
}

/** Percentage of scanned PRs that are duplicates */
export function duplicatePercentage(data: RepoScanData): number {
  const dupes = countDuplicatePrs(data);
  if (data.scan.prCount === 0) return 0;
  return Math.round((dupes / data.scan.prCount) * 100);
}
```

**Step 2: Create sample data file**

Create `demo/src/data/sample-org-sample-repo.json` with realistic fake data — at least 3 dupe groups, 2-4 members each. This is for development only; real data will replace it later.

```json
{
  "repo": {
    "owner": "expressjs",
    "name": "express",
    "url": "https://github.com/expressjs/express"
  },
  "scan": {
    "id": 1,
    "completedAt": "2026-02-15T10:30:00Z",
    "prCount": 142,
    "dupeGroupCount": 5
  },
  "groups": [
    {
      "id": 1,
      "label": "Add TypeScript type definitions",
      "members": [
        {
          "prNumber": 5891,
          "title": "feat: add comprehensive TypeScript definitions",
          "author": "alice-dev",
          "state": "open",
          "rank": 1,
          "score": 97.5,
          "rationale": "Most complete implementation with full test coverage and JSDoc comments.",
          "url": "https://github.com/expressjs/express/pull/5891"
        },
        {
          "prNumber": 5847,
          "title": "Add TypeScript types for Express core",
          "author": "bob-types",
          "state": "open",
          "rank": 2,
          "score": 82.3,
          "rationale": "Covers core types but missing middleware and router definitions.",
          "url": "https://github.com/expressjs/express/pull/5847"
        },
        {
          "prNumber": 5802,
          "title": "TypeScript support for express",
          "author": "charlie-ts",
          "state": "open",
          "rank": 3,
          "score": 71.0,
          "rationale": "Early attempt, partially overlaps with #5891 but incomplete error handling types.",
          "url": "https://github.com/expressjs/express/pull/5802"
        }
      ]
    },
    {
      "id": 2,
      "label": "Fix memory leak in connection pooling",
      "members": [
        {
          "prNumber": 5910,
          "title": "fix: resolve connection pool memory leak under high concurrency",
          "author": "dana-perf",
          "state": "open",
          "rank": 1,
          "score": 95.0,
          "rationale": "Correctly identifies root cause in keep-alive handling and includes regression test.",
          "url": "https://github.com/expressjs/express/pull/5910"
        },
        {
          "prNumber": 5888,
          "title": "Fix memory leak when connections not properly closed",
          "author": "eve-fix",
          "state": "open",
          "rank": 2,
          "score": 78.5,
          "rationale": "Addresses symptom but not root cause; may reintroduce leak under edge cases.",
          "url": "https://github.com/expressjs/express/pull/5888"
        }
      ]
    },
    {
      "id": 3,
      "label": "Update middleware documentation",
      "members": [
        {
          "prNumber": 5920,
          "title": "docs: rewrite middleware guide with modern patterns",
          "author": "frank-docs",
          "state": "open",
          "rank": 1,
          "score": 93.2,
          "rationale": "Comprehensive rewrite covering async middleware, error handling, and composition.",
          "url": "https://github.com/expressjs/express/pull/5920"
        },
        {
          "prNumber": 5905,
          "title": "Update middleware docs for Express 5",
          "author": "grace-writer",
          "state": "merged",
          "rank": 2,
          "score": 85.1,
          "rationale": "Good coverage but uses deprecated patterns in some examples.",
          "url": "https://github.com/expressjs/express/pull/5905"
        },
        {
          "prNumber": 5870,
          "title": "Fix outdated middleware examples",
          "author": "hank-contrib",
          "state": "open",
          "rank": 3,
          "score": 65.0,
          "rationale": "Only fixes a few examples, #5920 is a superset of these changes.",
          "url": "https://github.com/expressjs/express/pull/5870"
        },
        {
          "prNumber": 5850,
          "title": "Middleware docs cleanup",
          "author": "iris-clean",
          "state": "closed",
          "rank": 4,
          "score": 55.8,
          "rationale": "Abandoned PR, subset of changes already in #5920.",
          "url": "https://github.com/expressjs/express/pull/5850"
        }
      ]
    }
  ]
}
```

**Step 3: Create barrel export**

Create `demo/src/data/index.ts`:

```typescript
import type { RepoScanData } from "@/lib/types";
import sampleData from "./sample-org-sample-repo.json";

export const repos: RepoScanData[] = [
  sampleData as RepoScanData,
];

export function getRepoData(owner: string, name: string): RepoScanData | undefined {
  return repos.find((r) => r.repo.owner === owner && r.repo.name === name);
}
```

**Step 4: Verify TypeScript compiles**

```bash
cd /Users/dhruv/Code/ossgard/demo && npx tsc --noEmit
```

Expected: No type errors.

**Step 5: Commit**

```bash
cd /Users/dhruv/Code/ossgard
git add demo/src/lib/types.ts demo/src/data/
git commit -m "feat(demo): add data types, sample data, and barrel export"
```

---

### Task 4: Home Page — Hero Section

**Files:**
- Create: `demo/src/components/hero.tsx`
- Modify: `demo/src/app/page.tsx`

**Step 1: Create Hero component**

Create `demo/src/components/hero.tsx`:

A visually striking hero section with:
- Large headline in monospace font: "Stop reviewing duplicate PRs"
- Tagline: "ossgard detects duplicate pull requests in open-source repos using AI-powered code and intent analysis"
- A terminal-style mockup showing a scan command + output (static, decorative)
- A CTA button/anchor that scrolls to the repo list section below (`#repos`)
- Developer-tool aesthetic: dark background, green/cyan accents, monospace

**Step 2: Wire up the home page**

Update `demo/src/app/page.tsx` to import and render `<Hero />` followed by a placeholder `<section id="repos">` div.

**Step 3: Verify in dev server**

```bash
cd /Users/dhruv/Code/ossgard/demo && npm run dev
```

Expected: Hero section renders at localhost:3000 with proper styling.

**Step 4: Commit**

```bash
cd /Users/dhruv/Code/ossgard
git add demo/src/components/hero.tsx demo/src/app/page.tsx
git commit -m "feat(demo): add hero section to home page"
```

---

### Task 5: Home Page — Repo Cards + Grid

**Files:**
- Create: `demo/src/components/repo-card.tsx`
- Modify: `demo/src/app/page.tsx`

**Step 1: Create RepoCard component**

Create `demo/src/components/repo-card.tsx`:

Props: `data: RepoScanData`

Renders:
- Repo name `owner/name` as a link (internal navigation to `/${owner}/${name}`)
- GitHub icon + external link to repo URL (new tab)
- Scan date formatted nicely (e.g., "Feb 15, 2026")
- "X duplicate PRs found (Y%)" using `countDuplicatePrs()` and `duplicatePercentage()` from types
- Card styling: dark card with subtle border, hover state, monospace for stats

**Step 2: Wire up repo grid on home page**

Update `demo/src/app/page.tsx`:
- Import `repos` from `@/data`
- Render a grid of `<RepoCard>` components in the `#repos` section
- Section heading: "Scan Results" or "Repositories Analyzed"

**Step 3: Verify in dev server**

Expected: Home page shows hero + grid of repo cards with sample data.

**Step 4: Commit**

```bash
cd /Users/dhruv/Code/ossgard
git add demo/src/components/repo-card.tsx demo/src/app/page.tsx
git commit -m "feat(demo): add repo cards grid to home page"
```

---

### Task 6: Repo Detail Page — Layout + Stats Bar

**Files:**
- Create: `demo/src/app/[owner]/[repo]/page.tsx`
- Create: `demo/src/components/stats-bar.tsx`

**Step 1: Create the dynamic route page**

Create `demo/src/app/[owner]/[repo]/page.tsx`:

```typescript
import { repos, getRepoData } from "@/data";
import { notFound } from "next/navigation";

export function generateStaticParams() {
  return repos.map((r) => ({
    owner: r.repo.owner,
    repo: r.repo.name,
  }));
}

export default async function RepoPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string }>;
}) {
  const { owner, repo } = await params;
  const data = getRepoData(owner, repo);
  if (!data) notFound();

  return (
    <main>
      {/* Header with repo name, GitHub link, back button */}
      {/* StatsBar */}
      {/* ReviewCarousel (Task 7) */}
    </main>
  );
}
```

Key elements in the header:
- Back link to `/` (left-aligned arrow)
- `owner/name` as page title
- GitHub external link icon (opens repo in new tab)

**Step 2: Create StatsBar component**

Create `demo/src/components/stats-bar.tsx`:

Props: `data: RepoScanData`

Three stat cards in a row:
1. **Scanned**: formatted date from `scan.completedAt`
2. **PRs Analyzed**: `scan.prCount` number
3. **Duplicates Found**: `countDuplicatePrs(data)` with `(duplicatePercentage(data)%)`

Styling: monospace numbers, subtle card borders, grid layout.

**Step 3: Wire up StatsBar in the page**

Import and render `<StatsBar data={data} />` below the header.

**Step 4: Verify navigation works**

Click a repo card on the home page → should navigate to `/<owner>/<repo>` and show header + stats.

```bash
cd /Users/dhruv/Code/ossgard/demo && npm run build
```

Expected: Build succeeds, static pages generated for each repo.

**Step 5: Commit**

```bash
cd /Users/dhruv/Code/ossgard
git add demo/src/app/\[owner\]/\[repo\]/page.tsx demo/src/components/stats-bar.tsx
git commit -m "feat(demo): add repo detail page with stats bar"
```

---

### Task 7: Review Carousel — Core Navigation

**Files:**
- Create: `demo/src/components/review-carousel.tsx`
- Create: `demo/src/components/pr-card.tsx`
- Modify: `demo/src/app/[owner]/[repo]/page.tsx`

**Step 1: Create PrCard component**

Create `demo/src/components/pr-card.tsx`:

Props: `member: DupeGroupMember`, `repoOwner: string`, `repoName: string`, `variant: "merge" | "close"`

Renders:
- Badge: "MERGE" (green) or "CLOSE" (amber/orange) based on variant
- PR title as link to `member.url` (new tab)
- Author name
- Score displayed as percentage (e.g., "97.5%")
- State badge if not "open" (show "merged" or "closed" in muted style)
- Rationale text (for close variants)
- PR number shown as `#5891`

**Step 2: Create ReviewCarousel component**

Create `demo/src/components/review-carousel.tsx`:

This is a **client component** (`"use client"`).

Props: `groups: DupeGroup[]`, `repoOwner: string`, `repoName: string`

State: `currentIndex: number` (starts at 0)

Renders:
- Navigation: "Reviewing set {currentIndex + 1} of {groups.length}" + prev/next buttons
  - Prev disabled when index === 0, Next disabled when index === groups.length - 1
- Current group's label as heading
- Recommended PR: the member with rank === 1, rendered with `<PrCard variant="merge" />`
- Duplicates section heading: "Duplicates to close"
- List of members with rank > 1, each rendered with `<PrCard variant="close" />`
- Placeholder for close-dupes button (Task 8)

**Step 3: Wire into repo detail page**

Update `demo/src/app/[owner]/[repo]/page.tsx` to render `<ReviewCarousel>` below the stats bar.

Note: Since ReviewCarousel is a client component and the page is a server component, pass the data as props (serializable JSON — this works fine).

**Step 4: Verify carousel works**

Dev server: navigate to repo detail page, click prev/next, verify group switching works inline without URL change.

**Step 5: Commit**

```bash
cd /Users/dhruv/Code/ossgard
git add demo/src/components/review-carousel.tsx demo/src/components/pr-card.tsx demo/src/app/\[owner\]/\[repo\]/page.tsx
git commit -m "feat(demo): add review carousel with PR cards and navigation"
```

---

### Task 8: GitHub Integration — Token Modal + Close Duplicates

**Files:**
- Create: `demo/src/hooks/use-github-token.ts`
- Create: `demo/src/lib/github.ts`
- Create: `demo/src/components/github-token-modal.tsx`
- Create: `demo/src/components/close-dupes-button.tsx`
- Modify: `demo/src/components/review-carousel.tsx`

**Step 1: Create useGithubToken hook**

Create `demo/src/hooks/use-github-token.ts`:

```typescript
"use client";

import { useState, useCallback } from "react";

const STORAGE_KEY = "ossgard-demo-github-pat";

export function useGithubToken() {
  const [token, setTokenState] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return localStorage.getItem(STORAGE_KEY);
  });

  const setToken = useCallback((newToken: string) => {
    localStorage.setItem(STORAGE_KEY, newToken);
    setTokenState(newToken);
  }, []);

  const clearToken = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setTokenState(null);
  }, []);

  return { token, setToken, clearToken };
}
```

**Step 2: Create GitHub API client**

Create `demo/src/lib/github.ts`:

```typescript
export interface CloseResult {
  prNumber: number;
  success: boolean;
  error?: string;
}

export async function closePrWithComment(
  owner: string,
  repo: string,
  prNumber: number,
  recommendedPrNumber: number,
  token: string
): Promise<CloseResult> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };

  try {
    // Post comment
    await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          body: `This pull request appears to be a duplicate of #${recommendedPrNumber}.\n\nDetected by [ossgard](https://github.com/anthropics/ossgard).`,
        }),
      }
    );

    // Close PR
    const closeRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ state: "closed" }),
      }
    );

    if (!closeRes.ok) {
      const err = await closeRes.json();
      return { prNumber, success: false, error: err.message ?? "Failed to close PR" };
    }

    return { prNumber, success: true };
  } catch (err) {
    return {
      prNumber,
      success: false,
      error: err instanceof Error ? err.message : "Network error",
    };
  }
}
```

**Step 3: Create GitHubTokenModal component**

Create `demo/src/components/github-token-modal.tsx`:

Client component using shadcn Dialog. Contains:
- Explanation text about required scope (`public_repo` for public repos, `repo` for private)
- A link to GitHub token creation page (new tab)
- Text input for the PAT
- "Save" button that calls `setToken`
- Reassurance: "Your token is stored locally in your browser and never sent to our servers."
- "Clear token" option if one is already stored

**Step 4: Create CloseDupesButton component**

Create `demo/src/components/close-dupes-button.tsx`:

Client component. Props: `owner`, `repo`, `members: DupeGroupMember[]` (the rank > 1 members that are "open" state), `recommendedPrNumber: number`

Behavior:
1. On click, check if token exists (via `useGithubToken`)
2. If no token → open GitHubTokenModal
3. If token exists → show confirmation (e.g., "Close X duplicate PRs?")
4. On confirm → call `closePrWithComment` for each open duplicate PR
5. Show per-PR results (success checkmark or error message)
6. Disable button after successful execution

**Step 5: Wire CloseDupesButton into ReviewCarousel**

Add `<CloseDupesButton>` at the bottom of each group view in the carousel. Only show if there are open duplicate PRs (rank > 1, state === "open").

**Step 6: Verify end-to-end flow**

Dev server:
1. Click "Close Duplicates" → should show token modal (since no token stored)
2. Enter a token → modal closes
3. Click again → should show confirmation
4. (Don't actually close PRs with sample data — just verify the UI flow)

**Step 7: Commit**

```bash
cd /Users/dhruv/Code/ossgard
git add demo/src/hooks/ demo/src/lib/github.ts demo/src/components/github-token-modal.tsx demo/src/components/close-dupes-button.tsx demo/src/components/review-carousel.tsx
git commit -m "feat(demo): add GitHub token modal and close duplicates functionality"
```

---

### Task 9: Polish + Final Static Build

**Files:**
- Modify: `demo/src/app/layout.tsx` (finalize metadata)
- Modify: Various components (responsive, accessibility)
- Modify: `demo/next.config.ts` if needed

**Step 1: Ensure all links open in new tab**

Audit all components for external links (`<a>` tags pointing to GitHub). Every one must have `target="_blank" rel="noopener noreferrer"`.

Internal links (Next.js `<Link>`) should NOT open in new tab.

**Step 2: Add responsive design**

Ensure:
- Repo card grid: 1 column on mobile, 2 on md, 3 on lg
- Stats bar: stack vertically on mobile, row on md+
- Review carousel: full-width on all sizes
- PR cards: readable on mobile

**Step 3: Accessibility pass**

- All buttons have accessible labels
- Modal has proper focus trapping (shadcn Dialog handles this)
- Color contrast meets WCAG AA
- Keyboard navigation works for prev/next in carousel

**Step 4: Final static build**

```bash
cd /Users/dhruv/Code/ossgard/demo && npm run build
```

Expected: Build succeeds with no errors. Check `out/` directory has:
- `index.html`
- `expressjs/express/index.html` (or whatever the sample repo is)

**Step 5: Test static output**

```bash
cd /Users/dhruv/Code/ossgard/demo && npx serve out
```

Navigate to localhost:3000, verify:
- Home page renders with hero + repo cards
- Clicking repo card navigates to detail page
- Stats bar shows correct numbers
- Review carousel navigates between groups
- Close duplicates button opens token modal
- All GitHub links open in new tab

**Step 6: Commit**

```bash
cd /Users/dhruv/Code/ossgard
git add demo/
git commit -m "feat(demo): polish responsive design, accessibility, and final static build"
```

---

### Task 10: Add .gitignore + Documentation

**Files:**
- Create: `demo/.gitignore`
- Modify: `demo/package.json` (add scripts if needed)

**Step 1: Create .gitignore**

Create `demo/.gitignore`:

```
node_modules/
.next/
out/
```

**Step 2: Verify clean git state**

```bash
cd /Users/dhruv/Code/ossgard && git status
```

Ensure no `node_modules/`, `.next/`, or `out/` directories are tracked.

**Step 3: Commit**

```bash
cd /Users/dhruv/Code/ossgard
git add demo/.gitignore
git commit -m "chore(demo): add .gitignore for build artifacts"
```

---

## Adding Real Scan Data

When you have real ossgard scan results for a repository:

1. Run: `ossgard dupes owner/name --json > raw.json`
2. Run: `ossgard status --json` to get `prCount` from the scan
3. Transform the JSON to match the `RepoScanData` interface (add `repo.url`, construct PR URLs, include `scan.prCount`)
4. Save as `demo/src/data/<owner>-<repo>.json`
5. Import in `demo/src/data/index.ts`
6. Rebuild: `cd demo && npm run build`
