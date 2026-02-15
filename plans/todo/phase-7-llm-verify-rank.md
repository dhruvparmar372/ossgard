# Phase 7: LLM Verification & Ranking

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the verify and rank pipeline phases that use LLM to confirm duplicate groups and score PRs within each group.

**Architecture:** `VerifyProcessor` takes candidate groups from clustering, sends each group to the LLM with structured prompts, and filters out false positives. `RankProcessor` takes verified groups, sends each to the LLM for quality scoring, and stores results in the dupe_groups and dupe_group_members tables.

**Tech Stack:** LLMProvider, Database, Vitest

**Depends on:** Phase 5 (LLM providers), Phase 6 (candidate groups)

---

### Task 1: Build the VerifyProcessor

**Files:**
- Create: `packages/api/src/pipeline/verify.ts`
- Create: `packages/api/src/pipeline/prompts.ts`
- Test: `packages/api/src/pipeline/verify.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/api/src/pipeline/verify.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "../db/database.js";
import { VerifyProcessor } from "./verify.js";
import type { LLMProvider } from "../services/llm-provider.js";
import type { Job } from "@ossgard/shared";

function makeMockLLM(response: Record<string, unknown>): LLMProvider {
  return {
    embed: vi.fn(async () => []),
    chat: vi.fn(async () => response),
  };
}

describe("VerifyProcessor", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.insertRepo("test", "repo");
    db.createScan(1);
    // Insert 4 PRs
    for (let i = 1; i <= 4; i++) {
      db.upsertPR({
        repoId: 1, number: i, title: `Add dark mode v${i}`,
        body: `Implementation ${i}`, author: `dev${i}`,
        diffHash: `hash-${i}`, filePaths: ["src/theme.ts"],
        state: "open", createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
      });
    }
  });

  afterEach(() => db.close());

  it("verifies candidate groups via LLM and filters false positives", async () => {
    // LLM says PRs 1,2,3 are duplicates, PR 4 is unrelated
    const llm = makeMockLLM({
      groups: [
        {
          prIds: [1, 2, 3],
          label: "Add dark mode support",
          confidence: 0.92,
          relationship: "DUPLICATE",
        },
      ],
      unrelated: [4],
    });

    const prs = db.listOpenPRs(1);
    const prIds = prs.map((p) => p.id);

    const processor = new VerifyProcessor(db, llm);
    const job: Job = {
      id: "job-1", type: "verify",
      payload: {
        repoId: 1, scanId: 1,
        candidateGroups: [prIds], // all 4 as one candidate group
      },
      status: "running", result: null, error: null,
      attempts: 1, maxRetries: 3, runAfter: null, createdAt: "", updatedAt: "",
    };

    const verifiedGroups = await processor.verify(job);

    expect(verifiedGroups).toHaveLength(1);
    expect(verifiedGroups[0].prIds).toHaveLength(3);
    expect(verifiedGroups[0].label).toBe("Add dark mode support");
  });

  it("updates scan status to verifying", async () => {
    const llm = makeMockLLM({ groups: [], unrelated: [] });
    const processor = new VerifyProcessor(db, llm);

    const job: Job = {
      id: "job-1", type: "verify",
      payload: { repoId: 1, scanId: 1, candidateGroups: [] },
      status: "running", result: null, error: null,
      attempts: 1, maxRetries: 3, runAfter: null, createdAt: "", updatedAt: "",
    };

    await processor.process(job);

    const scan = db.getScan(1);
    expect(scan!.status).toBe("verifying");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @ossgard/api test -- src/pipeline/verify
```

**Step 3: Create prompts module**

```typescript
// packages/api/src/pipeline/prompts.ts
import type { PR } from "@ossgard/shared";

export function buildVerifyPrompt(prs: PR[]): string {
  const prSummaries = prs.map((pr) =>
    `PR #${pr.number} by @${pr.author}: "${pr.title}"
Description: ${pr.body ?? "(no description)"}
Files: ${pr.filePaths.join(", ")}
Diff hash: ${pr.diffHash ?? "unknown"}`
  ).join("\n\n---\n\n");

  return `You are reviewing ${prs.length} pull requests that may be duplicates of each other.

For each subset of PRs that are true duplicates, group them together. PRs are duplicates if they:
- Solve the same problem (even with different implementations)
- Add the same feature (even if the code differs)
- Fix the same bug

PRs that are NOT duplicates:
- Touch the same files but for different reasons
- Have similar titles but solve different problems

Here are the PRs:

${prSummaries}

Respond with JSON in this exact format:
{
  "groups": [
    {
      "prIds": [1, 2, 3],
      "label": "Short description of what these PRs do",
      "confidence": 0.95,
      "relationship": "DUPLICATE"
    }
  ],
  "unrelated": [4, 5]
}

Rules:
- prIds uses the PR number (not internal ID)
- confidence is 0-1
- relationship is "DUPLICATE" or "OVERLAPPING"
- A PR can only appear in one group or in unrelated
- Only include groups with 2+ PRs`;
}

export function buildRankPrompt(prs: PR[], groupLabel: string): string {
  const prDetails = prs.map((pr) =>
    `PR #${pr.number} by @${pr.author}: "${pr.title}"
Description: ${pr.body ?? "(no description)"}
Files changed: ${pr.filePaths.join(", ")}`
  ).join("\n\n---\n\n");

  return `You are ranking ${prs.length} duplicate pull requests that all attempt to: "${groupLabel}"

Rank them from best to worst candidate for merging. Score each on:

1. **Code quality** (0-50 points): Clean, idiomatic code. Follows common patterns. No obvious bugs or anti-patterns.
2. **Completeness** (0-50 points): Handles edge cases. Includes tests if appropriate. Complete implementation vs partial.

Here are the PRs:

${prDetails}

Respond with JSON in this exact format:
{
  "rankings": [
    {
      "prNumber": 42,
      "score": 87,
      "codeQuality": 45,
      "completeness": 42,
      "rationale": "One sentence explaining why this PR ranks here"
    }
  ]
}

Rules:
- Order from highest score to lowest
- score = codeQuality + completeness (0-100)
- Be specific in rationale — reference actual characteristics`;
}
```

**Step 4: Implement VerifyProcessor**

```typescript
// packages/api/src/pipeline/verify.ts
import type { Job, PR } from "@ossgard/shared";
import type { Database } from "../db/database.js";
import type { LLMProvider } from "../services/llm-provider.js";
import type { JobQueue } from "../queue/types.js";
import { buildVerifyPrompt } from "./prompts.js";

interface VerifiedGroup {
  prIds: number[];
  label: string;
  confidence: number;
  relationship: string;
}

export class VerifyProcessor {
  readonly type = "verify";

  constructor(
    private db: Database,
    private llm: LLMProvider,
    private queue?: JobQueue
  ) {}

  async process(job: Job): Promise<void> {
    const { repoId, scanId, candidateGroups } = job.payload as {
      repoId: number;
      scanId: number;
      candidateGroups: number[][];
    };

    this.db.updateScanStatus(scanId, "verifying");

    const verified = await this.verify(job);

    // Store verified groups in cursor for rank phase
    this.db.updateScanStatus(scanId, "verifying", {
      phaseCursor: { verifiedGroups: verified },
    });

    if (this.queue) {
      await this.queue.enqueue({
        type: "rank",
        payload: { repoId, scanId, verifiedGroups: verified },
      });
    }
  }

  async verify(job: Job): Promise<VerifiedGroup[]> {
    const { repoId, candidateGroups } = job.payload as {
      repoId: number;
      candidateGroups: number[][];
    };

    const allVerified: VerifiedGroup[] = [];

    for (const groupPrIds of candidateGroups) {
      if (groupPrIds.length < 2) continue;

      // Look up full PR data
      const prs: PR[] = [];
      for (const prId of groupPrIds) {
        const allPrs = this.db.listOpenPRs(repoId);
        const pr = allPrs.find((p) => p.id === prId);
        if (pr) prs.push(pr);
      }

      if (prs.length < 2) continue;

      const prompt = buildVerifyPrompt(prs);
      const result = await this.llm.chat([
        { role: "system", content: "You are a code review expert. Respond only with valid JSON." },
        { role: "user", content: prompt },
      ]);

      const groups = (result as { groups?: VerifiedGroup[] }).groups ?? [];

      // Map PR numbers back to PR IDs
      for (const group of groups) {
        const mappedIds = group.prIds
          .map((num) => prs.find((p) => p.number === num)?.id)
          .filter((id): id is number => id !== undefined);

        if (mappedIds.length >= 2) {
          allVerified.push({
            ...group,
            prIds: mappedIds,
          });
        }
      }
    }

    return allVerified;
  }
}
```

**Step 5: Run tests**

```bash
pnpm --filter @ossgard/api test -- src/pipeline/verify
```
Expected: ALL PASS

**Step 6: Commit**

```bash
git add packages/api/src/pipeline/verify.ts packages/api/src/pipeline/verify.test.ts packages/api/src/pipeline/prompts.ts
git commit -m "feat: add LLM verification pipeline phase with structured prompts"
```

---

### Task 2: Build the RankProcessor

**Files:**
- Create: `packages/api/src/pipeline/rank.ts`
- Test: `packages/api/src/pipeline/rank.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/api/src/pipeline/rank.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "../db/database.js";
import { RankProcessor } from "./rank.js";
import type { LLMProvider } from "../services/llm-provider.js";
import type { Job } from "@ossgard/shared";

describe("RankProcessor", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.insertRepo("test", "repo");
    db.createScan(1);
    for (let i = 1; i <= 3; i++) {
      db.upsertPR({
        repoId: 1, number: i, title: `Dark mode v${i}`,
        body: `Impl ${i}`, author: `dev${i}`,
        diffHash: `hash-${i}`, filePaths: ["src/theme.ts"],
        state: "open", createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
      });
    }
  });

  afterEach(() => db.close());

  it("ranks PRs within verified groups and stores results", async () => {
    const llm: LLMProvider = {
      embed: vi.fn(async () => []),
      chat: vi.fn(async () => ({
        rankings: [
          { prNumber: 1, score: 92, codeQuality: 47, completeness: 45, rationale: "Best implementation" },
          { prNumber: 2, score: 71, codeQuality: 35, completeness: 36, rationale: "Missing tests" },
          { prNumber: 3, score: 55, codeQuality: 25, completeness: 30, rationale: "Incomplete" },
        ],
      })),
    };

    const prs = db.listOpenPRs(1);
    const prIds = prs.map((p) => p.id);

    const processor = new RankProcessor(db, llm);
    const job: Job = {
      id: "job-1", type: "rank",
      payload: {
        repoId: 1, scanId: 1,
        verifiedGroups: [{
          prIds,
          label: "Add dark mode",
          confidence: 0.95,
          relationship: "DUPLICATE",
        }],
      },
      status: "running", result: null, error: null,
      attempts: 1, maxRetries: 3, runAfter: null, createdAt: "", updatedAt: "",
    };

    await processor.process(job);

    // Check dupe_groups table
    const groups = db.listDupeGroups(1);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Add dark mode");
    expect(groups[0].prCount).toBe(3);

    // Check dupe_group_members table
    const members = db.listDupeGroupMembers(groups[0].id);
    expect(members).toHaveLength(3);
    expect(members[0].rank).toBe(1);
    expect(members[0].score).toBe(92);
    expect(members[0].rationale).toBe("Best implementation");
  });

  it("marks scan as done after ranking", async () => {
    const llm: LLMProvider = {
      embed: vi.fn(async () => []),
      chat: vi.fn(async () => ({ rankings: [] })),
    };

    const processor = new RankProcessor(db, llm);
    const job: Job = {
      id: "job-1", type: "rank",
      payload: { repoId: 1, scanId: 1, verifiedGroups: [] },
      status: "running", result: null, error: null,
      attempts: 1, maxRetries: 3, runAfter: null, createdAt: "", updatedAt: "",
    };

    await processor.process(job);

    const scan = db.getScan(1);
    expect(scan!.status).toBe("done");
    expect(scan!.completedAt).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @ossgard/api test -- src/pipeline/rank
```

**Step 3: Add dupe group methods to Database**

```typescript
// Add to packages/api/src/db/database.ts

insertDupeGroup(scanId: number, repoId: number, label: string, prCount: number): number {
  const result = this.raw.prepare(
    "INSERT INTO dupe_groups (scan_id, repo_id, label, pr_count) VALUES (?, ?, ?, ?)"
  ).run(scanId, repoId, label, prCount);
  return result.lastInsertRowid as number;
}

insertDupeGroupMember(groupId: number, prId: number, rank: number, score: number, rationale: string | null): void {
  this.raw.prepare(
    "INSERT INTO dupe_group_members (group_id, pr_id, rank, score, rationale) VALUES (?, ?, ?, ?, ?)"
  ).run(groupId, prId, rank, score, rationale);
}

listDupeGroups(scanId: number): DupeGroup[] {
  const rows = this.raw
    .prepare("SELECT * FROM dupe_groups WHERE scan_id = ? ORDER BY id")
    .all(scanId) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number,
    scanId: r.scan_id as number,
    repoId: r.repo_id as number,
    label: (r.label as string) ?? null,
    prCount: r.pr_count as number,
  }));
}

listDupeGroupMembers(groupId: number): DupeGroupMember[] {
  const rows = this.raw
    .prepare("SELECT * FROM dupe_group_members WHERE group_id = ? ORDER BY rank")
    .all(groupId) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number,
    groupId: r.group_id as number,
    prId: r.pr_id as number,
    rank: r.rank as number,
    score: r.score as number,
    rationale: (r.rationale as string) ?? null,
  }));
}
```

**Step 4: Implement RankProcessor**

```typescript
// packages/api/src/pipeline/rank.ts
import type { Job, PR } from "@ossgard/shared";
import type { Database } from "../db/database.js";
import type { LLMProvider } from "../services/llm-provider.js";
import { buildRankPrompt } from "./prompts.js";

interface VerifiedGroup {
  prIds: number[];
  label: string;
  confidence: number;
  relationship: string;
}

interface RankingResult {
  prNumber: number;
  score: number;
  codeQuality: number;
  completeness: number;
  rationale: string;
}

export class RankProcessor {
  readonly type = "rank";

  constructor(
    private db: Database,
    private llm: LLMProvider
  ) {}

  async process(job: Job): Promise<void> {
    const { repoId, scanId, verifiedGroups } = job.payload as {
      repoId: number;
      scanId: number;
      verifiedGroups: VerifiedGroup[];
    };

    this.db.updateScanStatus(scanId, "ranking");

    const allPrs = this.db.listOpenPRs(repoId);

    for (const group of verifiedGroups) {
      const prs = group.prIds
        .map((id) => allPrs.find((p) => p.id === id))
        .filter((p): p is PR => p !== undefined);

      if (prs.length < 2) continue;

      // Get rankings from LLM
      const prompt = buildRankPrompt(prs, group.label);
      const result = await this.llm.chat([
        { role: "system", content: "You are a code review expert. Respond only with valid JSON." },
        { role: "user", content: prompt },
      ]);

      const rankings = ((result as { rankings?: RankingResult[] }).rankings ?? [])
        .sort((a, b) => b.score - a.score);

      // Store in database
      const groupId = this.db.insertDupeGroup(scanId, repoId, group.label, prs.length);

      for (let i = 0; i < rankings.length; i++) {
        const ranking = rankings[i];
        const pr = prs.find((p) => p.number === ranking.prNumber);
        if (!pr) continue;

        this.db.insertDupeGroupMember(
          groupId, pr.id, i + 1, ranking.score, ranking.rationale
        );
      }
    }

    // Mark scan as done
    const groups = this.db.listDupeGroups(scanId);
    this.db.updateScanStatus(scanId, "done", { dupeGroupCount: groups.length });
  }
}
```

**Step 5: Run tests**

```bash
pnpm --filter @ossgard/api test -- src/pipeline/rank
```
Expected: ALL PASS

**Step 6: Commit**

```bash
git add packages/api/src/pipeline/rank.ts packages/api/src/pipeline/rank.test.ts packages/api/src/db/database.ts
git commit -m "feat: add LLM ranking pipeline phase and dupe group storage"
```

---

### Task 3: Wire all processors into the worker loop

**Files:**
- Modify: `packages/api/src/app.ts`

**Step 1: Register all processors in createApp**

```typescript
// In packages/api/src/app.ts
import { ScanOrchestrator } from "./pipeline/scan-orchestrator.js";
import { IngestProcessor } from "./pipeline/ingest.js";
import { EmbedProcessor } from "./pipeline/embed.js";
import { ClusterProcessor } from "./pipeline/cluster.js";
import { VerifyProcessor } from "./pipeline/verify.js";
import { RankProcessor } from "./pipeline/rank.js";

// Inside createApp, after creating queue:
// These require service instances (github, llm, vectorStore)
// which are created based on config — for now, pass stubs
// and wire real instances in the integration phase

const processors = [
  new ScanOrchestrator(db, queue),
  // IngestProcessor, EmbedProcessor, etc. need service instances
  // Wired in Phase 9 when config loading is complete
];

const worker = new WorkerLoop(queue, processors);
```

**Step 2: Run all tests to verify nothing broke**

```bash
pnpm --filter @ossgard/api test
```
Expected: ALL PASS

**Step 3: Commit**

```bash
git add packages/api/src/app.ts
git commit -m "feat: register scan orchestrator in worker loop"
```
