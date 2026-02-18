# Cloudflare Workers Migration

Host the ossgard API on Cloudflare Workers so users can point the CLI at a cloud instance instead of running the API server locally. Replace the local infrastructure (SQLite file, Qdrant, direct provider calls) with the Cloudflare stack (D1, Vectorize, AI Gateway, Queues).

## Stack Mapping

| Current | Cloudflare | Change needed |
|---------|-----------|---------------|
| Hono on Bun | Hono on Workers | Entry point swap (`Bun.serve` → `export default`) |
| SQLite via `bun:sqlite` | D1 | Async driver, same SQL |
| Qdrant | Vectorize | New `VectorStore` implementation |
| Direct Anthropic/OpenAI calls | AI Gateway proxy | Swap base URLs |
| In-process job queue + worker loop | Queues + Durable Objects | Biggest rewrite |
| `fs` for config/db path | No filesystem | All state in D1 |

## Phase 1: Project scaffolding

Create `packages/worker/` alongside the existing `packages/api/`. Both share the same Hono routes and business logic — only the infrastructure bindings differ.

```
packages/worker/
  src/
    index.ts          # Worker entry point (fetch handler + queue consumers)
    d1-database.ts    # Database class backed by D1
    d1-job-queue.ts   # JobQueue backed by Queues API
    vectorize-store.ts # VectorStore backed by Vectorize
    batch-poller.ts   # Durable Object for batch polling
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
index_name = "ossgard-code"

[[vectorize]]
binding = "VECTORIZE_INTENT"
index_name = "ossgard-intent"

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
import { D1JobQueue } from "./d1-job-queue";
// ... routes, processors

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

Implement the `VectorStore` interface backed by Cloudflare Vectorize.

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

The actual provider classes don't change — they already accept a configurable base URL. The factory just swaps it before construction.

### Benefits

- Request/response logging in Cloudflare dashboard
- Optional response caching (useful for repeated verify/rank prompts during retries)
- Rate limit visibility
- Cost tracking per gateway

### Implementation

Modify `ServiceFactory.createLLMProvider()` and `ServiceFactory.createEmbeddingProvider()` to check for `aiGateway` in the config and prepend the gateway URL prefix. No changes to the provider classes themselves.

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
  type: "scan" | "ingest" | "embed" | "cluster" | "verify" | "rank";
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

Processors currently call `this.queue.enqueue(...)` to chain to the next phase. In the Workers version, this becomes:

```typescript
await env.PIPELINE_QUEUE.send({
  type: "embed",
  payload: { scanId, repoId, accountId },
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

When `EmbedProcessor` or `VerifyProcessor` detects batch mode, instead of polling inline, it creates a Durable Object:

```typescript
const id = env.BATCH_POLLER.idFromName(`scan-${scanId}-${phase}`);
const stub = env.BATCH_POLLER.get(id);
await stub.fetch("https://internal/poll", {
  method: "POST",
  body: JSON.stringify({ batchId, provider: "openai", scanId, accountId, phase }),
});
```

The Durable Object then handles the long-running poll and enqueues the next phase when done.

## Phase 7: Shared code extraction

To avoid duplicating business logic between `packages/api` (Bun) and `packages/worker` (Cloudflare), extract shared code into interfaces.

### What moves to shared/core

- Route handlers (Hono routes) — these are runtime-agnostic already
- Pipeline processor logic (the actual algorithms, not the wiring)
- Service interfaces (`ChatProvider`, `EmbeddingProvider`, `VectorStore`)
- Prompts (verify/rank system prompts)

### What stays platform-specific

| Concern | `packages/api` (Bun) | `packages/worker` (Cloudflare) |
|---------|----------------------|-------------------------------|
| Database | `bun:sqlite` sync | D1 async |
| Job queue | `LocalJobQueue` (SQLite) | Queues API |
| Worker loop | `setInterval` | Queue consumer |
| Vector store | Qdrant HTTP client | Vectorize binding |
| Batch polling | Inline `sleep` loop | Durable Object alarm |
| Entry point | `Bun.serve()` | `export default { fetch, queue }` |

### Database interface

The biggest refactor is making the `Database` interface async so it works with both `bun:sqlite` (sync wrapped in Promise) and D1 (natively async):

```typescript
interface IDatabase {
  getAccount(id: number): Promise<Account | null>;
  getAccountByApiKey(apiKey: string): Promise<Account | null>;
  createScan(repoId: number, accountId: number): Promise<Scan>;
  listOpenPRs(repoId: number): Promise<PR[]>;
  // ... all methods become async
}
```

The existing Bun `Database` class wraps its sync calls in `Promise.resolve()`. The D1 version is natively async. All consumers use `await`.

## Phase 8: CLI changes

The CLI itself needs zero changes to its command logic. It already talks to the API over HTTP. The only addition:

- During `ossgard setup`, offer a "Cloud" option that pre-fills the API URL to the Cloudflare Workers deployment (e.g., `https://ossgard-api.<account>.workers.dev`).
- Skip local API server setup instructions when cloud mode is detected.

## Deployment

### Initial setup

```bash
# Create D1 database
wrangler d1 create ossgard
# Update database_id in wrangler.toml

# Run schema migration
wrangler d1 execute ossgard --file=migrations/0001_initial.sql

# Create Vectorize indexes
wrangler vectorize create ossgard-code --dimensions=768 --metric=cosine
wrangler vectorize create ossgard-intent --dimensions=768 --metric=cosine

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
