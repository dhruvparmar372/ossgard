# Demo App — Design & Implementation

A static Next.js showcase app that displays ossgard scan results for specific repositories. Deployed as a public-facing marketing tool to demonstrate duplicate PR detection capabilities.

---

## Design

### Architecture

- **Framework**: Next.js (App Router) with `output: 'export'` for static generation
- **Location**: `/demo` at project root (standalone, outside bun monorepo workspace)
- **Package manager**: npm
- **Styling**: Tailwind CSS + shadcn/ui primitives (heavily restyled with dev-tools / open-source aesthetic)
- **Icons**: lucide-react
- **Data**: Per-repo JSON files imported at build time — no API calls except GitHub PR close actions
- **Tech Stack**: Next.js 16, React 19, TypeScript, Tailwind CSS v4, shadcn/ui (new-york style, restyled), lucide-react

### Data Model

Each repo has a JSON file at `demo/src/data/<owner>-<repo>.json`:

```typescript
interface RepoScanData {
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
  groups: Array<{
    id: number;
    label: string;
    members: Array<{
      prNumber: number;
      title: string;
      author: string;
      state: "open" | "closed" | "merged";
      rank: number;       // 1 = recommended merge, 2+ = duplicate (close)
      score: number;      // 0-100 confidence
      rationale: string;
      url: string;        // "https://github.com/owner/name/pull/123"
    }>;
  }>;
}
```

A barrel file at `demo/src/data/index.ts` imports all JSON files and exports a typed `RepoScanData[]`.

### Messaging Scheme

Visitors don't know what "dupe groups" are. All public-facing copy uses:
- **Duplicate PRs found**: count of members with rank > 1 (the ones recommended to close)
- **Percentage**: duplicate PRs / total PRs scanned
- Example: "23 duplicate PRs found (18% of open PRs)"

### Pages

#### Home Page (`/`)

**Hero section:**
- Headline conveying ossgard's value (finding duplicate PRs, saving reviewer time)
- Brief tagline
- Developer-tool aesthetic: monospace accents, terminal-inspired elements, muted dark palette
- CTA scrolling to repo list

**Repo list:**
- Grid of cards, one per scanned repo
- Each card shows: `owner/name` with GitHub link, scan date, "X duplicate PRs found (Y%)"
- Click navigates to `/<owner>/<repo>`

#### Repo Detail Page (`/<owner>/<repo>`)

**Header:** Repo name + GitHub link (new tab), back link to home

**Stats bar:** Three cards — Scan Date | PRs Scanned | Duplicate PRs Found (X%)

**Review carousel (inline, no URL change):**
- One DupeGroup displayed at a time
- Group label as heading
- "Reviewing set 1 of N" + prev/next navigation
- **Recommended PR** (rank 1): highlighted card with "MERGE" badge, title, author, score, GitHub link
- **Duplicates** (rank 2+): cards with "CLOSE" badge, title, author, score, rationale, GitHub link, state badge
- **"Close Duplicates" button**: comments on + closes all open duplicate PRs in the current group via GitHub API
  - If no PAT in localStorage -> opens modal
  - If PAT exists -> confirm, execute, show per-PR success/error

**GitHub token modal:**
- Explains required scope (`public_repo` or `repo`)
- Text input for PAT
- Saves to localStorage key `ossgard-demo-github-pat`
- "Token stored locally — never sent to our servers" reassurance

### Technical Details

- `generateStaticParams` returns all `{owner, repo}` combos from data barrel
- All pages pre-rendered at build time
- Only runtime network calls: GitHub API for PR close actions (client-side fetch)
- `closePrWithComment(owner, repo, prNumber, recommendedPrNumber, token)` posts a comment and patches PR state to closed
- `useGithubToken()` hook wraps localStorage
- All external links open in new tab

### Design Aesthetic

Developer-tools / open-source contribution theme:
- Monospace font accents for data/stats (Geist Mono)
- Terminal-inspired elements
- Sharp edges, minimal rounding (0.25rem radius)
- Muted dark palette with emerald/green accent
- Not stock shadcn/ui — components restyled with character

### Project Structure

```
demo/
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx
│   │   └── [owner]/
│   │       └── [repo]/
│   │           └── page.tsx
│   ├── components/
│   │   ├── hero.tsx
│   │   ├── repo-card.tsx
│   │   ├── stats-bar.tsx
│   │   ├── review-carousel.tsx
│   │   ├── pr-card.tsx
│   │   ├── close-dupes-button.tsx
│   │   └── github-token-modal.tsx
│   ├── data/
│   │   ├── index.ts
│   │   └── <owner>-<repo>.json
│   ├── lib/
│   │   ├── types.ts
│   │   └── github.ts
│   └── hooks/
│       └── use-github-token.ts
├── next.config.ts
├── package.json
└── tsconfig.json
```

---

## Implementation Plan

### Task 1: Scaffold Next.js Project

- `npx create-next-app@latest demo` with TypeScript, Tailwind, ESLint, App Router, src dir
- Configure `output: "export"` in `next.config.ts`
- Verify build succeeds

### Task 2: Initialize shadcn/ui + Custom Theme

- `npx shadcn@latest init` + add button, dialog, badge components
- Customize CSS variables: dark-first, emerald/green primary, sharp corners
- Set metadata in layout.tsx

### Task 3: Data Layer

- Create `types.ts` with `RepoScanData`, `DupeGroup`, `DupeGroupMember` interfaces
- Create `countDuplicatePrs()` and `duplicatePercentage()` utility functions
- Transform real scan data from API into per-repo JSON files
- Create barrel `index.ts` with `repos` array and `getRepoData()` lookup

### Task 4: Hero Section

- Terminal-style mockup showing scan command + output
- Large monospace headline, tagline, CTA scroll button
- Developer-tool aesthetic with grid background pattern

### Task 5: Repo Cards Grid

- `RepoCard` component with repo name, GitHub link, scan date, duplicate stats
- Responsive grid on home page (1/2/3 columns)

### Task 6: Repo Detail Page + Stats Bar

- Dynamic route `[owner]/[repo]` with `generateStaticParams`
- `StatsBar` with three stat cards: scan date, PRs analyzed, duplicates found
- Header with back link and GitHub external link

### Task 7: Review Carousel

- `PrCard` component with merge/close variants, badges, scores, rationale
- `ReviewCarousel` client component with prev/next navigation
- Displays one DupeGroup at a time inline (no URL change)

### Task 8: GitHub Integration

- `useGithubToken` hook for localStorage PAT management
- `closePrWithComment` API client (comment + close via GitHub API)
- `GitHubTokenModal` dialog for entering/clearing PAT
- `CloseDupesButton` with multi-step workflow (idle -> confirming -> closing -> done)

### Task 9: Polish

- Audit all external links for `target="_blank" rel="noopener noreferrer"`
- Responsive design verification
- Accessibility pass (contrast, focus indicators, aria labels)
- Final static build verification

---

## Adding Real Scan Data

1. Run: `ossgard dupes owner/name --json > raw.json`
2. Run: `ossgard status --json` to get `prCount` from the scan
3. Transform the JSON to match the `RepoScanData` interface (add `repo.url`, construct PR URLs, include `scan.prCount`)
4. Save as `demo/src/data/<owner>-<repo>.json`
5. Import in `demo/src/data/index.ts`
6. Rebuild: `cd demo && npm run build`
