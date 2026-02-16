# Code Review Fixes

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all issues found in the final code review, from critical bugs to minor improvements.

**Approach:** Fix in priority order -- critical first, then important, then minor. Each task is self-contained with tests.

---

## CRITICAL

### Task 1: Fix ClusterProcessor empty vector bug

**Files:**
- Modify: `packages/api/src/services/vector-store.ts`
- Modify: `packages/api/src/services/qdrant-store.ts`
- Modify: `packages/api/src/services/qdrant-store.test.ts`
- Modify: `packages/api/src/pipeline/cluster.ts`
- Modify: `packages/api/src/pipeline/cluster.test.ts`

**Problem:** `ClusterProcessor` passes `[]` as the query vector to `vectorStore.search()`. The embedding-based clustering (the core value proposition) doesn't work. Tests mask this because mocks ignore the vector parameter.

**Fix:**
1. Add `getVector(collection: string, id: string): Promise<number[] | null>` to the `VectorStore` interface
2. Implement it in `QdrantStore` using the Qdrant `retrieve` / `getPoints` API
3. In `ClusterProcessor`, for each PR:
   - Retrieve its stored code embedding via `vectorStore.getVector("ossgard-code", prPointId)`
   - Pass that vector to `vectorStore.search()` for nearest neighbors
   - Do the same for intent embeddings
4. Update the cluster tests to verify the correct vector is passed to search (not `[]`)
5. Update qdrant-store tests to cover `getVector`

**Step 1: Add getVector to VectorStore interface**

```typescript
// packages/api/src/services/vector-store.ts
export interface VectorStore {
  // ...existing methods...
  getVector(collection: string, id: string): Promise<number[] | null>;
}
```

**Step 2: Implement in QdrantStore**

Add a `retrieve` method to the QdrantClient interface:
```typescript
retrieve(collection: string, opts: { ids: string[]; with_vector: boolean }): Promise<Array<{ id: string; vector: number[] }>>;
```

Implement `getVector`:
```typescript
async getVector(collection: string, id: string): Promise<number[] | null> {
  const results = await this.client.retrieve(collection, { ids: [id], with_vector: true });
  if (results.length === 0) return null;
  return results[0].vector;
}
```

**Step 3: Fix ClusterProcessor**

Replace the empty vector with the actual stored embedding:
```typescript
for (const pr of prs) {
  const pointId = `pr-${pr.id}`;
  const codeVector = await this.vectorStore.getVector(CODE_COLLECTION, pointId);
  if (!codeVector) continue;

  const codeResults = await this.vectorStore.search(CODE_COLLECTION, codeVector, {
    limit: prs.length,
    filter: { must: [{ key: "repoId", match: { value: repoId } }] },
  });
  // ... process results
}
```

Same for intent embeddings.

**Step 4: Fix cluster tests to assert correct vectors are passed**

**Step 5: Run tests, commit**

---

### Task 2: Fix QdrantStore `as any` cast in ServiceFactory

**Files:**
- Modify: `packages/api/src/services/qdrant-store.ts`
- Modify: `packages/api/src/services/factory.ts`

**Problem:** The `QdrantClient` interface in `qdrant-store.ts` may not match the real `@qdrant/js-client-rest` client API. The `as any` in the factory silences type errors.

**Fix:**
1. Check the actual `@qdrant/js-client-rest` API and update the `QdrantClient` interface to match
2. The `QdrantStore` constructor takes `{ qdrantClient: QdrantClient }` -- verify the interface includes all methods used (getCollections, createCollection, upsert, search, delete, retrieve)
3. Align method signatures with the real Qdrant JS client
4. Remove the `as any` cast, replacing with a proper type assertion or adapter
5. Run tests, commit

---

## IMPORTANT

### Task 3: Fix scan failure propagation

**Files:**
- Modify: `packages/api/src/queue/worker.ts`
- Modify: `packages/api/src/queue/worker.test.ts`

**Problem:** When a pipeline processor throws, the job is marked failed but the scan stays stuck at an intermediate status forever. CLI polls indefinitely.

**Fix:**
1. In `WorkerLoop.tick()`, when a processor throws:
   - Extract `scanId` from `job.payload` (all pipeline jobs include it)
   - Call `db.updateScanStatus(scanId, "failed", { error: message })` to mark the scan as failed
2. This requires the WorkerLoop to have access to the Database. Either:
   - Add `db` to the WorkerLoop constructor, OR
   - Have each processor's `process()` method catch its own errors and update scan status (worse: duplicates logic)
   - Best approach: add a `db` parameter to WorkerLoop constructor
3. Add tests: when a processor throws, verify both job AND scan are marked failed
4. Run tests, commit

---

### Task 4: Add retry logic to WorkerLoop

**Files:**
- Modify: `packages/api/src/queue/types.ts`
- Modify: `packages/api/src/queue/local-job-queue.ts`
- Modify: `packages/api/src/queue/worker.ts`
- Modify: `packages/api/src/queue/worker.test.ts`
- Modify: `packages/api/src/queue/local-job-queue.test.ts`

**Problem:** Failed jobs stay failed permanently. `maxRetries` is stored but never checked.

**Fix:**
1. Add `attempts` column to jobs table (or track via a counter). Add `retry(jobId: string, runAfter?: string): Promise<void>` to the `JobQueue` interface
2. In `LocalJobQueue`, implement `retry()` -- sets status back to "pending" with an optional `run_after` delay
3. In `WorkerLoop.tick()`, on processor failure:
   - Check if `job.maxRetries > 0` and current attempts < maxRetries
   - If retriable: call `queue.retry(job.id, backoffDate)` instead of `queue.fail()`
   - If exhausted: call `queue.fail()` and mark scan as failed (from Task 3)
4. Add tests for retry behavior
5. Run tests, commit

---

### Task 5: Add proactive GitHub rate throttling

**Files:**
- Modify: `packages/api/src/services/github-client.ts`
- Modify: `packages/api/src/services/github-client.test.ts`

**Problem:** `rateLimitRemaining` is tracked but never acted on. A large repo scan will exhaust the 5000/hr GitHub limit.

**Fix:**
1. After each response, check `rateLimitRemaining`
2. When it drops below a safety buffer (e.g., 100):
   - Calculate `timeToReset = rateLimitReset - Date.now()`
   - Calculate `delayPerRequest = timeToReset / rateLimitRemaining`
   - Sleep for `delayPerRequest` before the next request
3. Implement this in the `RateLimitedClient.request()` method, adding a pre-request throttle check
4. Add tests with mocked rate limit headers showing throttling kicks in
5. Run tests, commit

---

### Task 6: Add pagination to getPRFiles

**Files:**
- Modify: `packages/api/src/services/github-client.ts`
- Modify: `packages/api/src/services/github-client.test.ts`

**Problem:** `getPRFiles` fetches only the first page (100 files). PRs with 100+ changed files get silently truncated.

**Fix:**
1. Use the same pagination pattern as `listOpenPRs` -- follow Link headers
2. Accumulate file paths across pages
3. Add a test with a mock that returns 2 pages of files
4. Run tests, commit

---

### Task 7: Fix schema default for scans status

**Files:**
- Modify: `packages/api/src/db/schema.ts`

**Problem:** Schema default is `'ingesting'` but should be `'queued'` to match the code.

**Fix:** Change `DEFAULT 'ingesting'` to `DEFAULT 'queued'` in the scans table schema. Run tests, commit.

---

### Task 8: Wire --full flag through to the API

**Files:**
- Modify: `packages/cli/src/commands/scan.ts`
- Modify: `packages/api/src/routes/scans.ts`

**Problem:** `--full` flag is accepted by CLI but never sent to the API.

**Fix:**
1. In the CLI scan command, pass `{ full: opts.full }` as the POST body
2. In the scans route, parse the body with `ScanRequest` schema and include `full` in the job payload
3. Run tests, commit

---

### Task 9: Validate GITHUB_TOKEN at startup

**Files:**
- Modify: `packages/api/src/index.ts`

**Problem:** Server starts with empty token, fails cryptically on first scan.

**Fix:**
1. After reading config, check if `github.token` is empty
2. If empty, log a clear warning: `"WARNING: No GITHUB_TOKEN configured. Scans will fail. Set GITHUB_TOKEN env var or run ossgard init."`
3. Don't crash -- the server should still start for health checks and repo tracking
4. Run tests, commit

---

## MINOR

### Task 10: Safe JSON parsing for LLM responses

**Files:**
- Modify: `packages/api/src/services/ollama-provider.ts`
- Modify: `packages/api/src/services/anthropic-provider.ts`
- Modify: `packages/api/src/services/ollama-provider.test.ts`
- Modify: `packages/api/src/services/anthropic-provider.test.ts`

**Problem:** `JSON.parse(content)` throws raw SyntaxError if LLM returns malformed JSON.

**Fix:**
1. Wrap JSON.parse in try-catch
2. Throw descriptive error: `"LLM returned invalid JSON: <first 200 chars>"`
3. Add tests for malformed JSON responses
4. Run tests, commit

---

### Task 11: Fix code embedding input to use actual diff content instead of diffHash

**Files:**
- Modify: `packages/api/src/pipeline/embed.ts`
- Modify: `packages/api/src/db/database.ts`
- Modify: `packages/api/src/db/schema.ts`
- Modify: `packages/api/src/pipeline/ingest.ts`
- Modify: `packages/api/src/pipeline/embed.test.ts`

**Problem:** Code embedding feeds the SHA-256 hash of the diff (a meaningless hex string) instead of the actual normalized diff content.

**Fix:**
1. Add a `normalized_diff` TEXT column to the `prs` table (nullable, can be large)
2. In `IngestProcessor`, store the normalized diff text alongside the hash
3. In `EmbedProcessor`, use `pr.normalizedDiff` (or filePaths + truncated diff) as code embedding input instead of `diffHash`
4. Update types if needed (add `normalizedDiff` to PR type)
5. Update tests
6. Run tests, commit

---

### Task 12: Fix N+1 queries in dupes route

**Files:**
- Modify: `packages/api/src/db/database.ts`
- Modify: `packages/api/src/routes/dupes.ts`
- Modify: `packages/api/tests/dupes.test.ts`

**Problem:** For each member in each dupe group, a separate `getPR()` query is issued. 50 groups x 3 members = 150 queries.

**Fix:**
1. Add a `getPRsByIds(ids: number[]): PR[]` batch method to Database
2. In dupes route, collect all prIds across all groups, fetch them in one query, build a lookup map
3. Update dupes tests
4. Run tests, commit

---

### Task 13: Update last_scan_at on repos table

**Files:**
- Modify: `packages/api/src/pipeline/rank.ts`
- Modify: `packages/api/src/db/database.ts`
- Modify: `packages/api/src/pipeline/rank.test.ts`

**Problem:** `last_scan_at` is never updated. Status command always shows "last scan: never".

**Fix:**
1. Add `updateRepoLastScanAt(repoId: number, timestamp: string): void` to Database
2. In `RankProcessor.process()`, after marking scan as done, call `db.updateRepoLastScanAt(repoId, new Date().toISOString())`
3. Add test for this behavior
4. Run tests, commit

---

### Task 14: Add graceful shutdown

**Files:**
- Modify: `packages/api/src/index.ts`

**Problem:** No SIGINT/SIGTERM handling. Worker and DB not closed on container stop.

**Fix:**
1. Add signal handlers in the `main()` function:
```typescript
const shutdown = () => {
  console.log("Shutting down...");
  ctx.worker.stop();
  ctx.db.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```
2. Run tests, commit

---

### Task 15: Handle missing ~/.ossgard in Docker Compose

**Files:**
- Modify: `packages/cli/src/commands/stack.ts`

**Problem:** If user runs `ossgard up` before `ossgard init`, Docker creates `~/.ossgard` as a root-owned empty directory.

**Fix:**
1. In the `up` command, before running docker compose, check if `~/.ossgard` exists
2. If not, create it with `mkdirSync` so Docker mounts a user-owned directory
3. Run tests, commit

---

### Task 16: Implement GitHub ETags for incremental scans

**Files:**
- Modify: `packages/api/src/services/github-client.ts`
- Modify: `packages/api/src/pipeline/ingest.ts`
- Modify: `packages/api/src/db/database.ts`
- Modify: `packages/api/src/services/github-client.test.ts`
- Modify: `packages/api/src/pipeline/ingest.test.ts`

**Problem:** ETags are in the schema but never used. Every scan re-fetches all PRs.

**Fix:**
1. In `GitHubClient`, accept optional `etag` parameter on list/diff methods. Send `If-None-Match` header. Return `null` on 304.
2. In `IngestProcessor`, for each PR, look up its stored etag. Pass to GitHub client. Skip processing on 304.
3. After successful fetch, store the new etag via `db.updatePREtag(prId, etag)`.
4. Add `updatePREtag` method to Database.
5. Add tests for conditional request behavior.
6. Run tests, commit.
