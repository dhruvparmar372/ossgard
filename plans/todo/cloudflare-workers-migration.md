# Cloudflare Workers Migration

Host the ossgard API on Cloudflare Workers so users can point the CLI at a cloud instance instead of running the API server locally. Replace the local infrastructure (SQLite file, Qdrant, direct provider calls) with the Cloudflare stack (D1, Vectorize, AI Gateway, Queues).

## Current Codebase State (as of 2026-02-19)

Key facts about the codebase that inform this plan:

- **Monorepo**: `packages/api` (Hono+Bun), `packages/cli` (Commander.js), `packages/shared` (types + Zod schemas only)
- **Pipeline is 3 phases**: `scan → ingest → detect` (defined as `JobType = "scan" | "ingest" | "detect"` in `shared/src/types.ts`). The `detect` phase internally handles embedding, clustering, verification, and ranking via the `pairwise-llm` strategy.
- **`VectorStore` interface already exists** (`api/src/services/vector-store.ts`) with `QdrantStore` implementation. A `VectorizeStore` exists as a compiled artifact in `dist/` but not in `src/`.
- **`JobQueue` interface already exists** (`api/src/queue/types.ts`) with `LocalJobQueue` implementation.
- **`Database` class is sync and concrete** — no `IDatabase` interface. All callers (routes, processors) use the concrete `Database` class with sync method calls.
- **Providers lack `baseUrl`**: `AnthropicProvider`, `OpenAIChatProvider`, `OpenAIEmbeddingProvider` all have hardcoded API URLs. Only `OllamaProvider` accepts a configurable `baseUrl`.
- **Prior Cloudflare work in `dist/` only**: `CloudflareChatProvider`, `CloudflareEmbeddingProvider`, and `VectorizeStore` exist as compiled `.js`/`.d.ts` in `packages/api/dist/services/` but have no corresponding source in `src/` and are not wired into `ServiceFactory`.
- **`AppEnv` is concretely typed**: `app.ts` types `db: Database` and `queue: LocalJobQueue` — must become interfaces.
- **CLI setup** offers `ollama|anthropic` for LLM, `ollama|openai` for embedding. No cloud mode.

## Stack Mapping

| Current | Cloudflare | Change needed |
|---------|-----------|---------------|
| Hono on Bun | Hono on Workers | Entry point swap (`Bun.serve` → `export default`) |
| SQLite via `bun:sqlite` | D1 | Async driver, same SQL |
| Qdrant | Vectorize | New `VectorStore` impl (partial prior work in `dist/`) |
| Direct Anthropic/OpenAI calls | AI Gateway proxy | Add `baseUrl` to providers + URL rewriting |
| In-process job queue + worker loop | Queues + Durable Objects | Biggest rewrite |
| `fs` for config/db path | No filesystem | All state in D1 |

## Phase 1: Project scaffolding

Create `packages/worker/` alongside the existing `packages/api/`. Both share the same Hono routes and business logic — only the infrastructure bindings differ.

```
packages/worker/
  src/
    index.ts           # Worker entry point (fetch handler + queue consumer)
    d1-database.ts     # IDatabase implementation backed by D1
    queues-adapter.ts  # JobQueue implementation backed by Queues API (enqueue → queue.send)
    vectorize-store.ts # VectorStore backed by Vectorize bindings
    batch-poller.ts    # Durable Object for batch polling (long-running batch API calls)
  migrations/
    0001_initial.sql   # Schema from api/src/db/schema.ts
  wrangler.toml
```

### wrangler.toml

```toml
name = "ossgard-api"
main = "src/index.ts"
compatibility_date = "2025-01-01"

[vars]
ENVIRONMENT = "production"

[[d1_databases]]
binding = "DB"
database_name = "ossgard"
database_id = "<to-be-created>"

[[vectorize]]
binding = "VECTORIZE_CODE"
index_name = "ossgard-code-v2"    # matches CODE_V2_COLLECTION in pairwise-llm strategy

[[vectorize]]
binding = "VECTORIZE_INTENT"
index_name = "ossgard-intent-v2"  # matches INTENT_V2_COLLECTION in pairwise-llm strategy

[[queues.producers]]
binding = "PIPELINE_QUEUE"
queue = "ossgard-pipeline"

[[queues.consumers]]
queue = "ossgard-pipeline"
max_batch_size = 1
max_retries = 3
dead_letter_queue = "ossgard-dlq"

[durable_objects]
bindings = [
  { name = "BATCH_POLLER", class_name = "BatchPoller" }
]

[[migrations]]
tag = "v1"
new_classes = ["BatchPoller"]
```

### Worker entry point

```typescript
// packages/worker/src/index.ts
import { Hono } from "hono";
import { D1Database } from "./d1-database";
import { QueuesAdapter } from "./queues-adapter";
// ... shared routes, processors from @ossgard/shared

export interface Env {
  DB: D1Database;
  VECTORIZE_CODE: VectorizeIndex;
  VECTORIZE_INTENT: VectorizeIndex;
  PIPELINE_QUEUE: Queue;
  BATCH_POLLER: DurableObjectNamespace;
}

const app = new Hono<{ Bindings: Env }>();
// ... mount routes

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    // Process pipeline jobs from the queue
    for (const msg of batch.messages) {
      const job = msg.body as PipelineJob;
      await processJob(job, env);
      msg.ack();
    }
  },
};

export { BatchPoller } from "./batch-poller";
```

## Phase 2: D1 Database adapter

The existing `Database` class uses `bun:sqlite` synchronously. D1 uses the same SQL dialect but is async and bound via `env.DB`.

### Approach

Create `D1Database` implementing the same public API but with async methods. Since all the SQL stays the same, this is mostly a mechanical conversion:

```typescript
// Bun (current, synchronous)
getAccount(id: number): Account | null {
  return this.raw.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
}

// D1 (new, async)
async getAccount(id: number): Promise<Account | null> {
  const result = await this.db.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first();
  return result ? mapAccount(result) : null;
}
```

### Schema migration

D1 uses Wrangler migrations. Export the existing `schema.ts` SQL as a migration file:

```
packages/worker/migrations/
  0001_initial.sql    # Same CREATE TABLE statements from schema.ts
```

### Considerations

- All callers (routes, processors) must `await` database calls — this cascades through the codebase. The shared route handlers need to be async-aware regardless of which backend is used.
- D1 has a 1MB response size limit per query. For repos with thousands of PRs, `listOpenPRs()` may need pagination.
- D1 supports `RETURNING` (needed for `dequeue`).

## Phase 3: Vectorize adapter

Implement the `VectorStore` interface (`api/src/services/vector-store.ts`) backed by Cloudflare Vectorize. **Note:** a compiled `VectorizeStore` already exists in `packages/api/dist/services/vectorize-store.js` using an HTTP REST API approach. For Workers, the implementation should use the native Vectorize binding instead.

```typescript
class VectorizeStore implements VectorStore {
  constructor(
    private codeIndex: VectorizeIndex,
    private intentIndex: VectorizeIndex
  ) {}

  async ensureCollection(name: string, dimensions: number): Promise<void> {
    // Vectorize indexes are pre-created via wrangler.toml
    // Validate dimensions match at runtime, warn if not
  }

  async upsert(collection: string, points: VectorPoint[]): Promise<void> {
    const index = this.getIndex(collection);
    // Vectorize upsert: max 1000 vectors per call
    for (const chunk of chunks(points, 1000)) {
      await index.upsert(chunk.map(p => ({
        id: p.id,
        values: p.vector,
        metadata: p.payload,
      })));
    }
  }

  async search(collection: string, vector: number[], opts: SearchOptions): Promise<SearchResult[]> {
    const index = this.getIndex(collection);
    const results = await index.query(vector, {
      topK: opts.limit,
      returnMetadata: true,
    });
    return results.matches.map(m => ({
      id: m.id,
      score: m.score,
      payload: m.metadata ?? {},
    }));
  }

  async getVector(collection: string, id: string): Promise<number[] | null> {
    const index = this.getIndex(collection);
    const results = await index.getByIds([id]);
    return results[0]?.values ?? null;
  }
}
```

### Vectorize constraints

- **Max dimensions: 1536.** This rules out OpenAI `text-embedding-3-large` (3072-dim). Users on the cloud version must use `text-embedding-3-small` (1536-dim) or Ollama models (768/1024-dim).
- **Max metadata size: 10KB per vector.** Current payloads are small (PR number, repo ID), so this is fine.
- **Max vectors per index: 5M.** More than enough.
- **No arbitrary filter syntax.** Vectorize supports metadata filtering but with a simpler API than Qdrant. Need to verify `deleteByFilter` can be expressed.
- **Indexes are pre-created** via `wrangler.toml`, not at runtime. `ensureCollection` becomes a no-op or a validation check.

## Phase 4: AI Gateway integration

AI Gateway is a URL proxy — it sits between ossgard and the actual AI provider. Same request/response format, zero code changes to provider logic.

### URL rewriting

Add `aiGateway` config to the account config schema:

```typescript
// In AccountConfig
aiGateway?: {
  accountId: string;   // Cloudflare account ID
  gatewayName: string; // e.g., "ossgard"
}
```

When `aiGateway` is configured, the `ServiceFactory` rewrites provider base URLs:

```
Anthropic: https://api.anthropic.com → https://gateway.ai.cloudflare.com/v1/{accountId}/{gateway}/anthropic
OpenAI:    https://api.openai.com    → https://gateway.ai.cloudflare.com/v1/{accountId}/{gateway}/openai
```

**Important:** The provider classes do NOT currently accept a configurable base URL (except `OllamaProvider`). The following changes are needed:
- `AnthropicProvider`: add optional `baseUrl` param (currently hardcoded to `https://api.anthropic.com/v1/messages`)
- `OpenAIChatProvider`: add optional `baseUrl` param (currently hardcoded to `https://api.openai.com/v1/chat/completions`)
- `OpenAIEmbeddingProvider`: add optional `baseUrl` param (currently hardcoded to `https://api.openai.com/v1/embeddings`)
- `AnthropicBatchProvider`, `OpenAIBatchChatProvider`, `OpenAIBatchEmbeddingProvider`: same treatment for their respective hardcoded URLs

The factory then passes the rewritten URL as `baseUrl` during construction.

### Benefits

- Request/response logging in Cloudflare dashboard
- Optional response caching (useful for repeated verify/rank prompts during retries)
- Rate limit visibility
- Cost tracking per gateway

### Implementation

1. Add optional `baseUrl` parameter to `AnthropicProvider`, `OpenAIChatProvider`, `OpenAIEmbeddingProvider`, and their batch variants.
2. Add optional `aiGateway` field to `AccountConfig` in `packages/shared/src/types.ts` and `AccountConfigSchema` in `packages/shared/src/schemas.ts`.
3. Modify `ServiceFactory.createLLMProvider()` and `ServiceFactory.createEmbeddingProvider()` to check for `aiGateway` in the config, compute the gateway URL, and pass it as `baseUrl` to the providers.

## Phase 5: Job pipeline on Queues

This is the biggest change. Replace the `LocalJobQueue` + `WorkerLoop` with Cloudflare Queues.

### Current flow

```
WorkerLoop (setInterval 1s)
  → dequeue() from SQLite jobs table
  → find matching JobProcessor
  → processor.process(job)
  → on success: complete(job)
  → on failure: retry with backoff or fail
```

### New flow

```
HTTP request → enqueue message to PIPELINE_QUEUE
  → queue consumer receives message
  → deserialize job type + payload
  → instantiate processor with env bindings
  → processor.process(job)
  → on success: msg.ack()
  → on failure: msg.retry() (Queues handles backoff)
```

### Queue message format

```typescript
interface PipelineMessage {
  type: "scan" | "ingest" | "detect";  // matches JobType in shared/types.ts
  payload: Record<string, unknown>;
  scanId: number;
  accountId: number;
}
```

### Queue consumer

```typescript
async queue(batch: MessageBatch<PipelineMessage>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    const { type, payload, scanId, accountId } = msg.body;
    const db = new D1Database(env.DB);
    const resolver = new ServiceResolver(db);
    const services = await resolver.resolve(accountId);

    const processor = createProcessor(type, db, services, env);
    try {
      await processor.process({ type, payload } as Job);
      msg.ack();
    } catch (err) {
      msg.retry({ delaySeconds: calculateBackoff(msg.attempts) });
    }
  }
}
```

### Enqueuing the next phase

Processors currently call `this.queue.enqueue(...)` to chain to the next phase. The pipeline is: `scan → ingest → detect`. In the Workers version, this becomes:

```typescript
// ScanOrchestrator enqueues ingest:
await env.PIPELINE_QUEUE.send({
  type: "ingest",
  payload: { scanId, repoId, accountId },
  scanId,
  accountId,
});

// IngestProcessor enqueues detect:
await env.PIPELINE_QUEUE.send({
  type: "detect",
  payload: { scanId, repoId, accountId, prNumbers },
  scanId,
  accountId,
});
```

Pass the queue binding through the processor constructor or a context object.

### Queue limits

- Max message size: 128KB. Job payloads are small (IDs only), so this is fine.
- Max batch size: set to 1 in `wrangler.toml` since each pipeline phase is heavy.
- Max retries: 3 (matches current `maxRetries`).
- Dead letter queue: `ossgard-dlq` for failed jobs that exhaust retries.

## Phase 6: Batch polling with Durable Objects

The Anthropic and OpenAI batch APIs can take minutes to hours. Workers have a 30s execution limit (or up to 15 min on paid plans). Durable Objects solve this with alarms.

### BatchPoller Durable Object

```typescript
export class BatchPoller implements DurableObject {
  state: DurableObjectState;
  env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const { batchId, provider, scanId, accountId, phase, requestMap } =
      await request.json();

    // Store batch context
    await this.state.storage.put("config", {
      batchId, provider, scanId, accountId, phase, requestMap,
      pollCount: 0,
      consecutiveErrors: 0,
    });

    // Schedule first poll in 10s
    await this.state.storage.setAlarm(Date.now() + 10_000);

    return new Response("polling started", { status: 202 });
  }

  async alarm(): Promise<void> {
    const config = await this.state.storage.get("config");
    if (!config) return;

    const { batchId, provider, scanId, phase, pollCount } = config;

    // Progressive interval: 10s * 1.5^n, capped at 120s
    const interval = Math.min(10_000 * Math.pow(1.5, pollCount), 120_000);

    try {
      const status = await pollBatch(provider, batchId);

      if (status === "completed") {
        const results = await fetchBatchResults(provider, batchId);
        // Enqueue next pipeline phase with results
        await this.env.PIPELINE_QUEUE.send({
          type: nextPhase(phase),
          payload: { scanId, results },
        });
        await this.state.storage.deleteAll();
        return;
      }

      // Schedule next poll
      config.pollCount++;
      config.consecutiveErrors = 0;
      await this.state.storage.put("config", config);
      await this.state.storage.setAlarm(Date.now() + interval);

    } catch (err) {
      config.consecutiveErrors++;
      if (config.consecutiveErrors >= 4) {
        // Mark scan as failed
        // ...
        await this.state.storage.deleteAll();
        return;
      }
      config.pollCount++;
      await this.state.storage.put("config", config);
      await this.state.storage.setAlarm(Date.now() + interval);
    }
  }
}
```

### How processors use it

Batch polling applies to the `detect` phase when accounts are configured with `batch: true` for LLM or embedding providers. The `DetectProcessor` delegates to `pairwise-llm` strategy, which uses `AnthropicBatchProvider`, `OpenAIBatchChatProvider`, or `OpenAIBatchEmbeddingProvider`. These batch providers currently poll inline with `sleep` loops.

In the Workers version, when a batch provider detects it's running on Workers (or when the strategy creates a batch request), it delegates to a Durable Object instead of polling inline:

```typescript
const id = env.BATCH_POLLER.idFromName(`scan-${scanId}-detect-${batchId}`);
const stub = env.BATCH_POLLER.get(id);
await stub.fetch("https://internal/poll", {
  method: "POST",
  body: JSON.stringify({ batchId, provider: "openai", scanId, accountId, phase: "detect" }),
});
```

The Durable Object then handles the long-running poll and re-enqueues the `detect` job with batch results when done.

## Phase 7: Shared code extraction

To avoid duplicating business logic between `packages/api` (Bun) and `packages/worker` (Cloudflare), extract shared code into `@ossgard/shared` (which already exists at `packages/shared/` but currently only contains types and Zod schemas).

### Current state of `@ossgard/shared`

- `types.ts`: `Repo`, `PR`, `Scan`, `Job`, `Account`, `AccountConfig`, `DupeGroup`, `DupeGroupMember`, `ScanProgress`, type unions (`JobType`, `JobStatus`, `ScanStatus`, `DuplicateStrategyName`)
- `schemas.ts`: Zod schemas for `AccountConfig`, request/response types

### What moves to `@ossgard/shared`

- **Service interfaces**: `ChatProvider`, `EmbeddingProvider` (from `api/src/services/llm-provider.ts`), `VectorStore` (from `api/src/services/vector-store.ts`), `JobQueue` (from `api/src/queue/types.ts`)
- **`IDatabase` interface**: New async database interface (see below)
- **Route handlers**: Hono routes (`health`, `accounts`, `repos`, `scans`, `dupes`, `reset`) — these are already runtime-agnostic
- **Pipeline processor logic**: `ScanOrchestrator`, `IngestProcessor`, `DetectProcessor`, and the `pairwise-llm` strategy — the algorithms, not the wiring
- **Prompts**: LLM system prompts used by the detection strategy

### What stays platform-specific

| Concern | `packages/api` (Bun) | `packages/worker` (Cloudflare) |
|---------|----------------------|-------------------------------|
| Database | `bun:sqlite` sync (wraps in Promise) | D1 async |
| Job queue | `LocalJobQueue` (SQLite `jobs` table) | Queues API |
| Worker loop | `setInterval` (1s poll) | Queue consumer |
| Vector store | `QdrantStore` (HTTP client) | `VectorizeStore` (binding) |
| Batch polling | Inline `sleep` loop in batch providers | Durable Object alarm |
| Entry point | `Bun.serve()` | `export default { fetch, queue }` |

### Database interface

The biggest refactor. The current `Database` class (`api/src/db/database.ts`) is synchronous and concrete — every route and processor depends on it directly. The `AppEnv.Variables` in `app.ts` types `db: Database` (concrete). `LocalJobQueue` directly accesses `database.raw` (the underlying `BunDatabase` instance).

Create an `IDatabase` async interface:

```typescript
interface IDatabase {
  getAccount(id: number): Promise<Account | null>;
  getAccountByApiKey(apiKey: string): Promise<Account | null>;
  createScan(repoId: number, accountId: number): Promise<Scan>;
  listOpenPRs(repoId: number): Promise<PR[]>;
  getScan(scanId: number): Promise<Scan | null>;
  updateScanStatus(scanId: number, status: ScanStatus, extra?: Record<string, unknown>): Promise<void>;
  upsertPR(...): Promise<PR>;
  getPRsByNumbers(repoId: number, numbers: number[]): Promise<PR[]>;
  insertDupeGroup(...): Promise<DupeGroup>;
  insertDupeGroupMember(...): Promise<DupeGroupMember>;
  deleteDupeGroupsByScan(scanId: number): Promise<void>;
  addScanTokens(scanId: number, input: number, output: number): Promise<void>;
  updateRepoLastScanAt(repoId: number, timestamp: string): Promise<void>;
  // ... all methods from the current Database class, made async
}
```

The existing Bun `Database` class wraps its sync calls in `Promise.resolve()`. The D1 version is natively async. All consumers (routes, processors, strategies) must use `await`.

**Cascade impact**: This change touches every route handler, every processor, and the `pairwise-llm` strategy (which calls `db.getScan`, `db.getPRsByNumbers`, `db.listOpenPRs`, `db.deleteDupeGroupsByScan`, `db.insertDupeGroup`, `db.insertDupeGroupMember`, etc. synchronously). The `AppEnv.Variables` type must change from `{ db: Database }` to `{ db: IDatabase }`.

## Phase 8: CLI changes

The CLI itself needs zero changes to its command logic. It already talks to the API over HTTP (`packages/cli/src/commands/setup.ts` prompts for API URL and validates via health check). Changes:

- During `ossgard setup`, offer a "Cloud" deployment option that pre-fills the API URL to the Cloudflare Workers deployment (e.g., `https://ossgard-api.<account>.workers.dev`).
- When cloud mode is selected, skip the Qdrant URL prompt (not needed — Vectorize is configured server-side).
- When cloud mode is selected, hide the `ollama` option for LLM and embedding providers (Ollama requires local server access, incompatible with cloud).
- The current setup offers `ollama|anthropic` for LLM and `ollama|openai` for embedding — cloud mode should offer `anthropic|openai` for LLM and `openai` for embedding.
- Config file (`~/.ossgard/config.toml`) stays the same structure: `{ api: { url, key } }` — all provider config lives server-side.

## Deployment

### Initial setup

```bash
# Create D1 database
wrangler d1 create ossgard
# Update database_id in wrangler.toml

# Run schema migration
wrangler d1 execute ossgard --file=migrations/0001_initial.sql

# Create Vectorize indexes (names match collection constants in pairwise-llm strategy)
wrangler vectorize create ossgard-code-v2 --dimensions=768 --metric=cosine
wrangler vectorize create ossgard-intent-v2 --dimensions=768 --metric=cosine

# Create queues
wrangler queues create ossgard-pipeline
wrangler queues create ossgard-dlq

# Create AI Gateway (via Cloudflare dashboard)
# Note the account_id and gateway name

# Deploy
wrangler deploy
```

### CI/CD

GitHub Actions workflow:

```yaml
on:
  push:
    branches: [main]
    paths: [packages/worker/**]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CF_API_TOKEN }}
          workingDirectory: packages/worker
          command: deploy
```

### D1 migrations in CI

```yaml
- name: Run D1 migrations
  run: wrangler d1 migrations apply ossgard --remote
  working-directory: packages/worker
```

## Constraints and Limitations

### Vectorize dimension limit

Vectorize maxes out at 1536 dimensions. Users on the cloud version cannot use `text-embedding-3-large` (3072-dim). The setup wizard should restrict cloud accounts to:
- `text-embedding-3-small` (1536-dim) for OpenAI
- `nomic-embed-text` (768-dim) or `mxbai-embed-large` (1024-dim) for Ollama

### Worker execution time

Free plan: 10ms CPU time (not wall time). Paid plan: 30s wall time, 30s CPU. This is tight for ingest (fetching hundreds of PRs). Options:
- Process PRs in smaller batches per queue message (e.g., 20 PRs per message, re-enqueue for more)
- Use `ctx.waitUntil()` for fire-and-forget work after response

### D1 row limits

D1 free tier: 5M rows, 5GB storage. Paid: 10B rows, 50GB. For large repos (10k+ PRs), monitor usage.

### No Ollama support

Ollama requires a locally running server. Users on the cloud version must use cloud providers (Anthropic + OpenAI). The setup wizard should hide the Ollama option when configuring against the cloud API.

## Open Questions

1. **Auth model for cloud**: Should the cloud version use Cloudflare Access or keep the current API key model? API keys are simpler but less secure for a shared hosted service.
2. **Multi-tenancy**: The current architecture is single-tenant (one DB). Cloud version needs proper tenant isolation — the account-scoped model already provides this at the data level, but resource limits (D1, Vectorize) are shared.
3. **Secrets management**: User API keys (GitHub, Anthropic, OpenAI) are stored in D1. Should these be encrypted at rest? Cloudflare Workers doesn't have KMS, but we could encrypt with a per-account key derived from their API key.
4. **Cost model**: Who pays for the Cloudflare resources? If this is a hosted service, need metering and usage limits per account.

## Implementation Order

1. **Phase 7** (shared code extraction) — do this first so the Bun version keeps working
2. **Phase 1** (scaffolding) — set up the Worker project
3. **Phase 2** (D1) — database adapter, most mechanical work
4. **Phase 3** (Vectorize) — vector store adapter
5. **Phase 4** (AI Gateway) — smallest change, just URL rewriting
6. **Phase 5** (Queues) — job pipeline migration
7. **Phase 6** (Durable Objects) — batch polling
8. **Phase 8** (CLI) — cloud setup option
