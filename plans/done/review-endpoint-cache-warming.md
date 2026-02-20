# Review Endpoint: Align with Scan Pipeline & Warm Cache

## Problem

The `GET /repos/:owner/:name/review/:prNumber` endpoint (surfaced as `check-duplicates --pr <N>`) does not mirror the scan pipeline's ingest path. This causes two issues:

1. **Embedding mismatch**: The review endpoint embeds intent using raw `title + body + filePaths` (`buildIntentInput`), while the scan pipeline embeds using the LLM-extracted intent summary. These produce different vectors, so k-NN results from the review path don't match what the scan pipeline would find.

2. **Cache not warmed**: The review endpoint never stores `intentSummary`, so subsequent scans always re-extract intents for PRs that were only seen through the review path. The `embedHash` is stored but vectors live under old IDs (`-code`, `-intent`) instead of the pipeline's IDs (`-code-v2`, `-intent-v2`).

## Goal

After `check-duplicates --pr <N>` runs, the target PR should be indistinguishable from one that went through a full scan: same vector IDs, same embedding content, `intentSummary` and `embedHash` populated. Future scans should get 100% cache hits for that PR (assuming no content change).

## Grouping Behavior

The current review endpoint returns:
- **dupeGroups**: existing groups this PR belongs to (from the latest completed scan)
- **similarPrs**: k-NN neighbors by vector similarity (no LLM verification)

It does NOT form new groups or run pairwise verification. This is intentional for now — the review path is a lightweight "where does this PR fit?" query. Full group formation only happens during scans.

Note: the clique grouper uses a `used` set, so a PR can only belong to one group per scan. If a new PR is a confirmed duplicate of PRs in two separate groups, it joins whichever group has the highest-confidence edge first (greedy). It does not merge groups.

## Changes

### 1. Align vector IDs with scan pipeline

**File: `packages/api/src/routes/dupes.ts`**

The review endpoint currently uses vector IDs like `${repoId}-${prNumber}-code` and `${repoId}-${prNumber}-intent`. The scan pipeline uses `${repoId}-${prNumber}-code-v2` and `${repoId}-${prNumber}-intent-v2`.

- Update all vector ID references in the review handler to use the `-v2` suffix
- This ensures vectors upserted by the review path are the same ones the scan pipeline reads

### 2. Add LLM intent extraction to the review path

**File: `packages/api/src/routes/dupes.ts`**

When a PR needs embedding (not cached or freshly fetched):

1. Check `pr.intentSummary` — if already set, use it directly
2. If not set, instantiate `IntentExtractor` and call `extract([pr])` — this makes a single LLM chat call (not batch, since it's one PR)
3. Use the extracted summary as the intent embedding text (matching scan pipeline line: `intents.get(pr.number) ?? pr.title`)

This replaces the current `buildIntentInput()` call for intent embedding.

### 3. Align code embedding with scan pipeline

**File: `packages/api/src/routes/dupes.ts`**

The scan pipeline builds code embedding text as:
```ts
const paths = pr.filePaths.join("\n");
return paths.length > 0 ? `${pr.title}\n${paths}` : pr.title;
```

The review endpoint uses `buildCodeInput()` with token budgeting. Replace with the simpler pipeline logic to ensure identical vectors.

### 4. Store cache fields

**File: `packages/api/src/routes/dupes.ts`**

After embedding, call `db.updatePRCacheFields(pr.id, embedHash, intentSummary)` instead of the current `db.updatePREmbedHash(pr.id, computeEmbedHash(pr))`. This stores both `embedHash` and `intentSummary` so future scans see a fully cached PR.

### 5. Fix the cache-check logic

**File: `packages/api/src/routes/dupes.ts`**

Current logic:
```ts
const hasEmbeddings = pr.embedHash !== null;
const needsEmbedding = !hasEmbeddings || hadToFetch;
```

This should also check `pr.intentSummary` to ensure the full cache is populated:
```ts
const fullyCached = pr.embedHash !== null && pr.intentSummary !== null;
const needsProcessing = !fullyCached || hadToFetch;
```

When `needsProcessing` is false, retrieve vectors from Qdrant using `-v2` IDs. When true, run LLM intent extraction + embedding.

### 6. Remove unused imports

**File: `packages/api/src/routes/dupes.ts`**

After the changes, `buildCodeInput`, `buildIntentInput`, and `TOKEN_BUDGET_FACTOR` are no longer used in this file. Remove their imports. Add imports for `IntentExtractor` and the LLM provider resolution.

## Files Changed

| File | Change |
|------|--------|
| `packages/api/src/routes/dupes.ts` | Align review handler with scan pipeline (steps 1-6) |

## What Does NOT Change

- The `/repos/:owner/:name/dupes` endpoint (list all groups) — untouched
- The scan pipeline (`pairwise-llm/index.ts`) — untouched
- The API response shape — `dupeGroups` and `similarPrs` structure stays the same
- No pairwise verification or group formation in the review path — that stays scan-only
- The `IntentExtractor` class — already supports single-PR extraction via sequential fallback

## Testing

1. Clean state, scan a repo, then `check-duplicates <repo> --pr <N>` for an already-scanned PR — should return cached results, no LLM calls
2. `check-duplicates <repo> --pr <N>` for an un-ingested PR — should fetch from GitHub, extract intent via LLM, embed, store cache fields, return similar PRs
3. After step 2, run a full scan — the PR from step 2 should hit the intent+embed cache (prsCached should include it)
4. After step 2, repeat the same `--pr` call — should be fully cached, no LLM or embedding calls
