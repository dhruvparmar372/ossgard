# Batch Processing & Prompt Caching for Cloud Providers

## Context

ossgard's verify and rank processors make many sequential `chat()` calls (one per candidate/verified group). With Anthropic, this is slow and expensive. Similarly, the embed processor makes multiple sequential `embed()` calls when using OpenAI. Both Anthropic and OpenAI offer Batch APIs that process multiple requests asynchronously with polling — cheaper (50% discount on Anthropic) and more throughput-friendly.

Additionally, Anthropic supports **prompt caching** via `cache_control` blocks, which reduces cost and latency when the same system prompt is reused across calls (exactly what verify/rank do).

**Goals:**
1. Add batch processing support for Anthropic chat (verify + rank) and OpenAI embeddings
2. Enable Anthropic prompt caching on system prompts for both sync and batch paths
3. Batch mode is opt-in via `batch = true` in config
4. Polling-based (no webhooks), simple fixed-interval polling
5. Existing sync paths remain the default and are untouched

## Architecture

### New Interfaces (`llm-provider.ts`)

Extend existing interfaces with batch variants + type guards:

```typescript
interface BatchChatRequest { id: string; messages: Message[] }
interface BatchChatResult  { id: string; response: Record<string, unknown> }

interface BatchChatProvider extends ChatProvider {
  readonly batch: true;
  chatBatch(requests: BatchChatRequest[]): Promise<BatchChatResult[]>;
}

interface BatchEmbedRequest { id: string; texts: string[] }
interface BatchEmbedResult  { id: string; embeddings: number[][] }

interface BatchEmbeddingProvider extends EmbeddingProvider {
  readonly batch: true;
  embedBatch(requests: BatchEmbedRequest[]): Promise<BatchEmbedResult[]>;
}

function isBatchChatProvider(p: ChatProvider): p is BatchChatProvider
function isBatchEmbeddingProvider(p: EmbeddingProvider): p is BatchEmbeddingProvider
```

### Provider Strategy

- **`AnthropicBatchProvider`** — implements `BatchChatProvider`. Has `chat()` for single-call fallback (reuses sync Anthropic logic) and `chatBatch()` using the Message Batches API. Both paths use prompt caching.
- **`OpenAIBatchEmbeddingProvider`** — implements `BatchEmbeddingProvider`. Has `embed()` for single-call fallback and `embedBatch()` using the OpenAI Batch API (file upload + polling).
- **Existing sync `AnthropicProvider`** — gets prompt caching added (system sent as content block array with `cache_control: {"type": "ephemeral"}`).
- **Ollama** — no batch API, unchanged. Factory ignores `batch` flag for Ollama.

### Processor Changes

Processors check `isBatchChatProvider()`/`isBatchEmbeddingProvider()` to choose path:

- **Batch path**: Collect all requests upfront → `chatBatch()`/`embedBatch()` → map results back
- **Sync path**: Existing sequential loop (unchanged)

The refactoring separates "build messages" from "call LLM" in verify/rank, so both paths share the same message-building logic.

## Changes

### 1. Add batch interfaces and type guards to `llm-provider.ts`

**File:** `packages/api/src/services/llm-provider.ts`

- Add `BatchChatRequest`, `BatchChatResult`, `BatchChatProvider`
- Add `BatchEmbedRequest`, `BatchEmbedResult`, `BatchEmbeddingProvider`
- Add `isBatchChatProvider()` and `isBatchEmbeddingProvider()` type guards

### 2. Add prompt caching to existing `AnthropicProvider`

**File:** `packages/api/src/services/anthropic-provider.ts`

Change system message format from plain string to content block array with `cache_control`:

```typescript
// Before:
body.system = systemMessage.content;

// After:
body.system = [{
  type: "text",
  text: systemMessage.content,
  cache_control: { type: "ephemeral" },
}];
```

This caches the system prompt prefix across sequential calls. Verify's system prompt is identical for all groups in a scan — every call after the first gets a cache hit.

**Test:** Update `anthropic-provider.test.ts` — verify system is sent as content block array with `cache_control`

### 3. Create `AnthropicBatchProvider`

**New file:** `packages/api/src/services/anthropic-batch-provider.ts`

- `readonly batch = true`
- `chat(messages)` — sync fallback (same as AnthropicProvider logic, with prompt caching)
- `chatBatch(requests)` — Anthropic Message Batches API:
  1. `POST /v1/messages/batches` with `requests: [{ custom_id, params }]` (prompt caching on system blocks)
  2. Poll `GET /v1/messages/batches/{id}` every 10s until `processing_status === "ended"`
  3. `GET /v1/messages/batches/{id}/results` — JSONL, parse each `{ custom_id, result }`
  4. Map results back to input order via `custom_id`
- Options: `pollIntervalMs` (default 10s), `timeoutMs` (default 30min)
- Optimization: single request bypasses batch, uses sync `chat()`

**New test:** `anthropic-batch-provider.test.ts`
- `batch` property is `true`
- `chat()` works as sync fallback
- `chatBatch([])` returns `[]`
- `chatBatch` with 1 request uses sync path
- `chatBatch` creates batch → polls → retrieves results (mock 3 sequential fetches)
- Returns results in input order regardless of JSONL order
- Throws on errored batch items, timeout, create failure, invalid JSON

### 4. Create `OpenAIBatchEmbeddingProvider`

**New file:** `packages/api/src/services/openai-batch-embedding-provider.ts`

- `readonly batch = true`, `readonly dimensions` from model lookup
- `embed(texts)` — sync fallback (same as OpenAIEmbeddingProvider logic)
- `embedBatch(requests)` — OpenAI Batch API:
  1. Build JSONL content (each line: `{ custom_id, method: "POST", url: "/v1/embeddings", body }`)
  2. Upload via `POST /v1/files` (multipart FormData with Blob)
  3. `POST /v1/batches` with `{ input_file_id, endpoint: "/v1/embeddings", completion_window: "24h" }`
  4. Poll `GET /v1/batches/{id}` every 10s until `status === "completed"`
  5. Download `GET /v1/files/{output_file_id}/content` — JSONL results
  6. Map results back via `custom_id`
- Options: `pollIntervalMs` (default 10s), `timeoutMs` (default 2h)
- Optimization: single request bypasses batch, uses sync `embed()`

**New test:** `openai-batch-embedding-provider.test.ts`
- `batch` property is `true`, `dimensions` correct
- `embed()` works as sync fallback
- `embedBatch([])` returns `[]`
- `embedBatch` with 1 request uses sync path
- `embedBatch` uploads file → creates batch → polls → downloads results
- Throws on failed/expired/cancelled status, timeout, non-200 items

### 5. Update `ServiceFactory` and `ServiceConfig`

**File:** `packages/api/src/services/factory.ts`

- Add `batch?: boolean` to `ServiceConfig.llm` and `ServiceConfig.embedding`
- Import `AnthropicBatchProvider` and `OpenAIBatchEmbeddingProvider`
- `createLLMProvider()`: if `provider === "anthropic" && batch`, return `AnthropicBatchProvider`
- `createEmbeddingProvider()`: if `provider === "openai" && batch`, return `OpenAIBatchEmbeddingProvider`

**Test:** `factory.test.ts` — add 4 tests for batch provider creation (anthropic+batch, ollama+batch ignored, openai+batch, ollama embedding+batch ignored)

### 6. Update pipeline processors

**File:** `packages/api/src/pipeline/verify.ts`

Refactor: separate message-building loop from LLM-calling loop.

```
// 1. Build all valid candidates with messages
validCandidates = candidateGroups.map(c => { ...lookup PRs, buildVerifyPrompt... })

// 2. Call LLM
if (isBatchChatProvider(llm) && validCandidates.length > 1) {
  results = await llm.chatBatch(validCandidates.map(vc => ({ id, messages })))
  // map results back to verifiedGroups
} else {
  // existing sequential loop
}
```

**File:** `packages/api/src/pipeline/rank.ts`

Same pattern: separate message-building from LLM invocation, add batch branch.

**File:** `packages/api/src/pipeline/embed.ts`

```
if (isBatchEmbeddingProvider(provider) && prs.length > 0) {
  // collect all code + intent requests across all batches
  batchRequests = prs batched into { id: "code-batch-N" / "intent-batch-N", texts }
  results = await provider.embedBatch(batchRequests)
  // map results back, upsert
} else {
  // existing sequential loop
}
```

**Tests:** `verify.test.ts`, `rank.test.ts`, `embed.test.ts` — add batch path tests with mock `BatchChatProvider`/`BatchEmbeddingProvider` (mock has `batch: true` + `chatBatch`/`embedBatch` as `vi.fn()`). Existing sync tests unchanged.

### 7. Update config and bootstrap

**File:** `packages/cli/src/config.ts`
- Add optional `batch` field to `llm` and `embedding` in `OssgardConfig`

**File:** `packages/api/src/index.ts`
- Add `batch?: boolean` to `TomlConfig.llm` and `TomlConfig.embedding`
- Thread `LLM_BATCH=true` / `EMBEDDING_BATCH=true` env vars into `ServiceConfig`

### 8. Update E2E test config

**File:** `e2e/openclaw.test.ts`
- No changes needed — E2E uses Ollama which ignores `batch` flag. Just ensure config still compiles (the `batch` field is optional).

## Execution Order

1. **Step 1**: Batch interfaces + type guards in `llm-provider.ts`
2. **Step 2**: Prompt caching on existing `AnthropicProvider`
3. **Steps 3-4** (parallel): New batch provider classes + tests
4. **Steps 5-7**: Factory + processors + config wiring
5. **Step 8**: E2E verification

Run `pnpm test` after each step.

## Files Summary

| Action | File |
|--------|------|
| Modify | `packages/api/src/services/llm-provider.ts` |
| Modify | `packages/api/src/services/anthropic-provider.ts` |
| Modify | `packages/api/src/services/anthropic-provider.test.ts` |
| **Create** | `packages/api/src/services/anthropic-batch-provider.ts` |
| **Create** | `packages/api/src/services/anthropic-batch-provider.test.ts` |
| **Create** | `packages/api/src/services/openai-batch-embedding-provider.ts` |
| **Create** | `packages/api/src/services/openai-batch-embedding-provider.test.ts` |
| Modify | `packages/api/src/services/factory.ts` |
| Modify | `packages/api/src/services/factory.test.ts` |
| Modify | `packages/api/src/pipeline/embed.ts` |
| Modify | `packages/api/src/pipeline/embed.test.ts` |
| Modify | `packages/api/src/pipeline/verify.ts` |
| Modify | `packages/api/src/pipeline/verify.test.ts` |
| Modify | `packages/api/src/pipeline/rank.ts` |
| Modify | `packages/api/src/pipeline/rank.test.ts` |
| Modify | `packages/cli/src/config.ts` |
| Modify | `packages/api/src/index.ts` |

## Verification

1. `pnpm test` — all tests pass (existing ~233 + ~30 new batch tests)
2. Config: `ossgard config set llm.batch true` + `ossgard config get llm.batch` → "true"
3. Sync providers still work identically when `batch` is not set
