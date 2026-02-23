# Periodic Scans & Scan History

**Date:** 2026-02-23
**Status:** Approved

## Goal

Support periodic (every 2 hours) automatic scanning of tracked repos, surface scan history on the demo app, and allow downloading results for any scan.

## Decisions

- **Scheduling:** Built into the API server (setInterval-based)
- **Demo architecture:** Stays static (JSON files at build time)
- **Download format:** JSON
- **Retention:** TTL-based, default 3 days (configurable)
- **File layout:** One JSON file per scan, organized in repo subdirectories

---

## 1. Data Model

### Demo file structure

```
demo/src/data/
  index.ts                          # Barrel: exports repo indexes + lookup helpers
  openclaw-openclaw/
    scan-42.json                    # Full scan export (RepoScanData shape)
    scan-38.json
    scan-35.json
  other-owner-other-repo/
    scan-17.json
```

### Types

`RepoScanData` (unchanged) -- one scan per file:

```typescript
interface RepoScanData {
  repo: { owner: string; name: string; url: string }
  scan: { id: number; completedAt: string; prCount: number; dupeGroupCount: number }
  groups: DupeGroup[]
}
```

New lightweight index for listing scans without loading group data:

```typescript
interface RepoScanIndex {
  repo: { owner: string; name: string; url: string }
  scans: ScanSummary[]  // newest-first
}

interface ScanSummary {
  id: number
  completedAt: string
  prCount: number
  dupeGroupCount: number
}
```

### Barrel exports

- `repos: RepoScanIndex[]` -- for home page and repo detail scan lists
- `getRepoData(owner, name): RepoScanIndex | undefined`
- `getScanData(owner, name, scanId): RepoScanData | undefined`
- `getLatestScan(owner, name): RepoScanData | undefined`

### Helper function updates

`countDuplicatePrs` and `duplicatePercentage` updated to accept `RepoScanData` (no change needed since the shape stays the same).

---

## 2. API Changes

### New endpoint: List completed scans

```
GET /repos/:owner/:name/scans
Response: { scans: [{ id, status, prCount, dupeGroupCount, completedAt }, ...] }
```

New DB method: `listCompletedScans(repoId, accountId): Scan[]`

### Modified endpoint: Fetch dupes for a specific scan

```
GET /repos/:owner/:name/dupes?scanId=42
```

Optional `scanId` query param. If provided, load that scan. If omitted, use latest (existing behavior).

### Built-in scheduler

- New file: `packages/api/src/scheduler.ts`
- On server startup, starts a `setInterval` (configurable via `SCAN_INTERVAL_MS`, default 7200000 = 2h)
- Each tick: fetches all tracked repos, triggers scan for each (skips repos with active scans)
- Disable via `SCAN_SCHEDULER_ENABLED=false`

### TTL-based cleanup

- Runs after each scheduler tick
- Deletes scans where `completedAt` < now - TTL
- Default TTL: 3 days (configurable via `SCAN_TTL_DAYS`)
- Cascade deletes: scan -> dupe_groups -> dupe_group_members
- Does NOT delete `prs` or `pairwise_cache` (shared, still useful)
- New DB method: `deleteExpiredScans(olderThan: Date): number`

---

## 3. Pull Script Changes

Updated `demo/scripts/pull-scan-data.ts`:

1. Fetch scan list per repo via `GET /repos/:owner/:name/scans`
2. For each scan, check if `data/{owner}-{repo}/scan-{id}.json` exists -- skip if so (incremental)
3. Fetch dupes via `GET /repos/:owner/:name/dupes?scanId={id}`
4. Write scan JSON file
5. Clean up local files for scans no longer in API response (TTL'd)
6. Regenerate barrel `data/index.ts` with static imports and index objects

---

## 4. Demo UI Changes

### Repo detail page (`/[owner]/[repo]/page.tsx`)

- Shows latest scan results (stats bar + review carousel) -- same as today
- Adds scan history section below header: compact list of all scans
- Each entry: scan date, PR count, dupe count, link to `/owner/repo/scan/{id}`
- Latest scan visually highlighted ("Latest" badge)
- Download button downloads latest scan's JSON

### Scan detail page (`/[owner]/[repo]/scan/[scanId]/page.tsx`) -- NEW

- Same layout as repo detail (stats bar + review carousel)
- Loads specific scan's data
- Own download button for that scan's JSON
- Back button goes to `/owner/repo`
- Header shows scan date (e.g., "Scan from Feb 22, 2026")

### Home page

- Repo cards show stats from latest scan (minor: add "Last scanned: X ago")

### No changes needed

- `review-carousel.tsx`, `pr-card.tsx` -- already work with `DupeGroup[]`
- `stats-bar.tsx` -- compatible props, may need minor type adjustment

---

## Files to Create/Modify

### New files
- `packages/api/src/scheduler.ts` -- periodic scan scheduler
- `demo/src/app/[owner]/[repo]/scan/[scanId]/page.tsx` -- scan detail page

### Modified files
- `packages/api/src/db/database.ts` -- `listCompletedScans()`, `deleteExpiredScans()`
- `packages/api/src/routes/scans.ts` -- new `GET /repos/:owner/:name/scans` endpoint
- `packages/api/src/routes/dupes.ts` -- optional `scanId` query param
- `packages/api/src/index.ts` -- start scheduler on boot
- `demo/scripts/pull-scan-data.ts` -- multi-scan fetch, incremental writes, cleanup
- `demo/src/lib/types.ts` -- add `RepoScanIndex`, `ScanSummary`
- `demo/src/data/index.ts` -- new barrel structure
- `demo/src/app/[owner]/[repo]/page.tsx` -- add scan history section
- `demo/src/app/page.tsx` -- show "last scanned" on repo cards
- `demo/src/components/stats-bar.tsx` -- minor type adjustment if needed
