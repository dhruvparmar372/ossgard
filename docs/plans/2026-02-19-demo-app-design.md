# Demo App Design

A static Next.js showcase app that displays ossgard scan results for specific repositories. Deployed as a public-facing marketing tool to demonstrate duplicate PR detection capabilities.

## Architecture

- **Framework**: Next.js (App Router) with `output: 'export'` for static generation
- **Location**: `/demo` at project root (standalone, outside bun monorepo workspace)
- **Package manager**: npm
- **Styling**: Tailwind CSS + shadcn/ui primitives (heavily restyled with dev-tools / open-source aesthetic)
- **Icons**: lucide-react
- **Data**: Per-repo JSON files imported at build time — no API calls except GitHub PR close actions

## Data Model

Each repo has a JSON file at `demo/src/data/<owner>-<repo>.json`:

```typescript
interface RepoScanData {
  repo: {
    owner: string;
    name: string;
    url: string; // "https://github.com/owner/name"
  };
  scan: {
    id: number;
    completedAt: string;
    prCount: number;       // total open PRs scanned
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

## Messaging Scheme

Visitors don't know what "dupe groups" are. All public-facing copy uses:
- **Duplicate PRs found**: count of members with rank > 1 (the ones recommended to close)
- **Percentage**: duplicate PRs / total PRs scanned
- Example: "23 duplicate PRs found (18% of open PRs)"

Internal navigation labels like "Reviewing set 1 of 12" are acceptable since context makes them clear.

## Pages

### Home Page (`/`)

**Hero section:**
- Headline conveying ossgard's value (finding duplicate PRs, saving reviewer time)
- Brief tagline
- Developer-tool aesthetic: monospace accents, terminal-inspired elements, muted dark palette
- CTA scrolling to repo list

**Repo list:**
- Grid of cards, one per scanned repo
- Each card shows: `owner/name` with GitHub link, scan date, "X duplicate PRs found (Y%)"
- Click navigates to `/<owner>/<repo>`

### Repo Detail Page (`/<owner>/<repo>`)

**Header:** Repo name + GitHub link (new tab), back link to home

**Stats bar:** Three cards — Scan Date | PRs Scanned | Duplicate PRs Found (X%)

**Review carousel (inline, no URL change):**
- One DupeGroup displayed at a time
- Group label as heading (e.g., "Add TypeScript support")
- "Reviewing set 1 of N" + prev/next navigation
- **Recommended PR** (rank 1): highlighted card with "MERGE" badge, title, author, score, GitHub link
- **Duplicates** (rank 2+): cards with "CLOSE" badge, title, author, score, rationale, GitHub link, state badge
- **"Close Duplicates" button**: comments on + closes all open duplicate PRs in the current group via GitHub API
  - If no PAT in localStorage → opens modal
  - If PAT exists → confirm, execute, show per-PR success/error

**GitHub token modal:**
- Explains required scope (`public_repo` or `repo`)
- Text input for PAT
- Saves to localStorage key `ossgard-demo-github-pat`
- "Token stored locally — never sent to our servers" reassurance

## Technical Details

**Static generation:**
- `generateStaticParams` returns all `{owner, repo}` combos from data barrel
- All pages pre-rendered at build time
- Only runtime network calls: GitHub API for PR close actions (client-side fetch)

**GitHub API integration (client-side):**
- `closePrWithComment(owner, repo, prNumber, recommendedPrNumber, token)` function
- Posts comment: "Duplicate of #N. Detected by ossgard."
- Patches PR state to closed
- Returns per-PR success/error

**GitHub token hook:**
- `useGithubToken()` wraps localStorage for `ossgard-demo-github-pat`
- No expiry, user can update via modal

**Routing:**
- `/` → home
- `/[owner]/[repo]` → repo detail

**All links open in new tab.**

## Project Structure

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
├── tailwind.config.ts
├── package.json
└── tsconfig.json
```

## Design Aesthetic

Developer-tools / open-source contribution theme:
- Monospace font accents for data/stats
- Terminal-inspired elements
- Sharp edges, minimal rounding
- Muted dark palette with accent colors
- Not stock shadcn/ui — components restyled with character
