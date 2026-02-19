# Pairwise-LLM Duplicate Detection Strategy

> **Note:** The legacy strategy (`embed → cluster → verify → rank` as separate job types) has been removed. Pairwise-llm is now the only duplicate detection strategy. Legacy processors, the `--strategy` flag, and the `"legacy"` strategy name no longer exist.

## Problem

The current duplicate detection pipeline uses Union-Find clustering, which assumes transitivity: if PR A matches B and B matches C, all three are grouped together. Similarity is not transitive. This produces massive false-positive groups (e.g., 70 unrelated PRs labeled "Unrelated: miscellaneous...").

Additionally, the current embeddings only use file paths and PR title/body — the actual code diff (already fetched during ingest) is discarded before embedding, losing the strongest signal for detecting duplicates.

## Solution

Introduce a **strategy abstraction** for duplicate detection, and build a new **pairwise-llm** strategy that:

1. Uses LLM-generated intent summaries for better embeddings
2. Embeds actual diff content (not just file paths)
3. Uses pairwise LLM verification instead of group-level verification
4. Groups via complete-linkage (cliques) — no transitivity

## Strategy Interface

```typescript
interface DuplicateStrategy {
  readonly name: string;

  execute(ctx: StrategyContext): Promise<StrategyResult>;
}

interface StrategyContext {
  prs: PR[];
  scanId: number;
  repoId: number;
  accountId: number;
  resolver: ServiceResolver;
  db: Database;
}

interface StrategyResult {
  groups: DupeGroup[];
  tokenUsage: { inputTokens: number; outputTokens: number };
}

interface DupeGroup {
  label: string;
  confidence: number;
  relationship: string;
  members: Array<{
    prId: number;
    prNumber: number;
    rank: number;
    score: number;
    rationale: string;
  }>;
}
```

## Schema Changes

Add `strategy` column to `scans` table:

```sql
ALTER TABLE scans ADD COLUMN strategy TEXT NOT NULL DEFAULT 'pairwise-llm';
```

No changes to `dupe_groups` or `dupe_group_members`. The output format is the same regardless of strategy.

## Configuration

Account config gains a `strategy` field and new thresholds:

```typescript
scan?: {
  strategy?: "legacy" | "pairwise-llm";  // default: "pairwise-llm"
  concurrency?: number;
  code_similarity_threshold?: number;
  intent_similarity_threshold?: number;
  // pairwise-llm specific:
  candidate_threshold?: number;           // cosine sim for retrieval (default: 0.65)
  max_candidates_per_pr?: number;         // k in k-NN (default: 5)
};
```

CLI: `ossgard scan owner/repo --strategy=pairwise-llm` (default) or `--strategy=legacy`.

API: `POST /repos/:owner/:name/scan` accepts optional `strategy` field.

## Pairwise-LLM Strategy

Four internal phases:

### Phase 1: Intent Extraction

For each PR, prompt the LLM to generate a 2-3 sentence normalized intent summary.

- Input: title, body, truncated diff (~3000 tokens)
- Output: canonical intent summary per PR
- Batchable via existing `chatBatch` API
- Prompt: "Summarize what this PR changes and why in 2-3 sentences. Focus on the problem being solved, not the implementation details."

### Phase 2: Embed

Two embeddings per PR stored in new vector collections:

- **Intent embedding** (`ossgard-intent-v2`): embed the LLM-generated intent summary
- **Code embedding** (`ossgard-code-v2`): embed the normalized diff content

Uses existing `EmbeddingProvider` infrastructure. New collection names avoid conflicts with legacy strategy.

### Phase 3: Candidate Retrieval + Pairwise Verification

1. For each PR, k-NN search on both intent and code embeddings (top K neighbors above threshold)
2. Deduplicate candidate pairs across both signals
3. For each unique candidate pair, LLM pairwise verification:
   - Input: both PRs' titles, bodies, intent summaries, truncated diffs
   - Output: `{ isDuplicate: boolean, confidence: number, relationship: string, rationale: string }`
   - Batchable
4. No transitivity — each pair judged independently

### Phase 4: Grouping + Ranking

1. Build graph of confirmed duplicate edges (isDuplicate=true pairs)
2. Find cliques (groups where every pair was confirmed by the LLM)
   - Greedy clique building starting from highest-confidence edges
   - Every member of a group is directly confirmed as a duplicate of every other member
3. Rank PRs within each group using existing rank prompt
4. Output `DupeGroup[]`

## New Components

| Component | Location | Purpose |
|---|---|---|
| `DuplicateStrategy` | `pipeline/strategy.ts` | Interface for pluggable detection strategies |
| `LegacyStrategy` | `pipeline/strategies/legacy.ts` | Wraps existing embed→cluster→verify→rank pipeline |
| `PairwiseLLMStrategy` | `pipeline/strategies/pairwise-llm/index.ts` | New pairwise approach (this design) |
| `IntentExtractor` | `pipeline/strategies/pairwise-llm/intent-extractor.ts` | LLM-based intent summarization per PR |
| `PairwiseVerifier` | `pipeline/strategies/pairwise-llm/pairwise-verifier.ts` | LLM-based pairwise duplicate verification |
| `CliqueGrouper` | `pipeline/strategies/pairwise-llm/clique-grouper.ts` | Complete-linkage grouping from confirmed edges |
| `DetectProcessor` | `pipeline/detect.ts` | Job processor that dispatches to the right strategy |
| `strategy-registry` | `pipeline/strategy-registry.ts` | Maps strategy names to implementations |

## What Changes, What Stays

| Component | Status |
|---|---|
| Ingest | Unchanged. Enqueues `detect` job. |
| Legacy processors (embed, cluster, verify, rank) | **Deleted.** All legacy `.ts` files and tests removed. |
| DB schema | `strategy` column remains for backward compat (hardcoded to `"pairwise-llm"`). |
| Shared types | `DuplicateStrategyName` is `"pairwise-llm"` only. `JobType` is `"scan" \| "ingest" \| "detect"`. `ScanStatus` no longer includes `"clustering"`. |
| API scan route | No `strategy` param. `createScan` hardcodes `"pairwise-llm"`. |
| CLI scan command | No `--strategy` flag. |
| Job orchestration | `DetectProcessor` always uses `"pairwise-llm"` via `getStrategy()`. |

## Research References

- [DupLLM (APSEC 2024)](https://conf.researchr.org/details/apsec-2024/apsec-2024-technical-track/20/) — LLM-summarized intent + embedding, 0.929 P@1
- [DupHunter (IEEE TSE 2023)](https://dl.acm.org/doi/abs/10.1109/TSE.2023.3235942) — Graph matching network, 0.922 P@1
- [VLDB 2009](http://www.vldb.org/pvldb/vol2/vldb09-1025.pdf) — Transitive closure produces poor quality duplicate groups
- [Zhang 2020](https://dl.acm.org/doi/10.1145/3361242.3361254) — Temporal proximity improves F1 by 14%
- [2025 Probing Study](https://arxiv.org/html/2509.09192) — Compact diff encodings outperform whole-function formats
- [CC2Vec (ICSE 2020)](https://arxiv.org/abs/2003.05620) — Distributed representations of code changes
