# OpenAI LLM Provider — Design & Implementation

## Goal

Add OpenAI as a chat/LLM provider so users can run the full pipeline with:
- OpenAI embeddings + OpenAI LLM (full OpenAI stack)
- OpenAI embeddings + Anthropic LLM (mixed stack)
- Any other combination with Ollama

## Requirements

1. **Model-agnostic** — user provides any model string via config; no hardcoded model list
2. **Sensible defaults** — `gpt-4o-mini` for OpenAI, `claude-haiku-4-5-20251001` for Anthropic
3. **Batch support** — leverage OpenAI Batch API for cost savings on large scans
4. **JSON mode** — use OpenAI's native `response_format: { type: "json_object" }` for reliable structured output
5. **Tiktoken token counting** — exact counts, already a dependency
6. **Health check** — verify provider connectivity (model + API key) before pipeline execution

**Tech Stack:** TypeScript, OpenAI REST API, js-tiktoken, bun test (vitest-compatible)

---

## New Files

### `openai-chat-provider.ts`

Implements `ChatProvider`.

- Endpoint: `POST https://api.openai.com/v1/chat/completions`
- Auth: `Authorization: Bearer <apiKey>`
- JSON mode: `response_format: { type: "json_object" }`
- Token counting: tiktoken (reuses `createTiktokenEncoder` from `token-counting.ts`)
- `maxContextTokens`: 128,000 (reasonable default; model-agnostic)
- System messages passed as normal messages with `role: "system"` (OpenAI supports this natively)

### `openai-batch-chat-provider.ts`

Implements `BatchChatProvider`.

Uses the same OpenAI Batch API pattern as the existing `OpenAIBatchEmbeddingProvider`:
1. Build JSONL with `{ custom_id, method: "POST", url: "/v1/chat/completions", body: {...} }`
2. Upload file via `POST /v1/files` with `purpose: "batch"`
3. Create batch via `POST /v1/batches` with `endpoint: "/v1/chat/completions"`, `completion_window: "24h"`
4. Poll `GET /v1/batches/{batchId}` with exponential backoff (1.5x, 10s base, 120s cap)
5. Download JSONL results from `GET /v1/files/{outputFileId}/content`
6. Parse per-item results back into `BatchChatResult[]`

Features:
- Single-request optimization (use sync `chat()` path)
- Resume support via `existingBatchId`
- `onBatchCreated` callback for storing batch ID
- Transient error tolerance (4 network errors, 3 server errors)
- Per-item error handling (failed items get `error` field, don't fail whole batch)
- Timeout: 24 hours (matches OpenAI batch window)

### `provider-health.ts`

Free function `checkProviderHealth(config): Promise<{ ok: boolean; error?: string }>`.

- **OpenAI**: `POST /v1/chat/completions` with `max_tokens: 1`, trivial prompt
- **Anthropic**: `POST /v1/messages` with `max_tokens: 1`, trivial prompt
- **Ollama**: `GET {baseUrl}/api/tags`

Called during account setup/validation before pipeline runs.

## Modified Files

### `factory.ts`

Add `"openai"` case to `createLLMProvider()`:

```typescript
if (this.config.llm.provider === "openai") {
  if (this.config.llm.batch) {
    return new OpenAIBatchChatProvider({ ... });
  }
  return new OpenAIChatProvider({ ... });
}
```

### Config defaults

When provider is set but model is empty, apply defaults:
- `openai` LLM: `gpt-4o-mini`
- `anthropic` LLM: `claude-haiku-4-5-20251001`

## No Changes Needed

- `llm-provider.ts` — existing interfaces (`ChatProvider`, `BatchChatProvider`) already cover everything
- Pipeline processors — they use `ChatProvider` interface polymorphically, no changes needed
- Embedding providers — untouched, already support OpenAI

---

## Implementation Tasks

### Task 1: OpenAI Chat Provider — Tests
- Create `packages/api/src/services/openai-chat-provider.test.ts`
- Tests: maxContextTokens, countTokens, chat (JSON response, Bearer auth, system messages, JSON mode, model in body, error handling, invalid JSON)

### Task 2: OpenAI Chat Provider — Implementation
- Create `packages/api/src/services/openai-chat-provider.ts`
- Implements `ChatProvider` with tiktoken, Bearer auth, JSON mode

### Task 3: OpenAI Batch Chat Provider — Tests
- Create `packages/api/src/services/openai-batch-chat-provider.test.ts`
- Tests: maxContextTokens, countTokens, batch flag, sync fallback, full batch flow (upload → create → poll → download), batch create failure, per-item errors, resume from existing batch ID, onBatchCreated callback, 24h timeout default

### Task 4: OpenAI Batch Chat Provider — Implementation
- Create `packages/api/src/services/openai-batch-chat-provider.ts`
- Implements `BatchChatProvider` following `openai-batch-embedding-provider.ts` pattern

### Task 5: Factory Update — Tests
- Modify `packages/api/src/services/factory.test.ts`
- Tests: returns OpenAIChatProvider for openai, returns OpenAIBatchChatProvider for openai+batch

### Task 6: Factory Update — Implementation
- Modify `packages/api/src/services/factory.ts`
- Wire OpenAI chat providers into `createLLMProvider()`

### Task 7: Provider Health Check — Tests
- Create `packages/api/src/services/provider-health.test.ts`
- Tests: OpenAI/Anthropic/Ollama LLM health, embedding health, error handling

### Task 8: Provider Health Check — Implementation
- Create `packages/api/src/services/provider-health.ts`
- `checkLLMHealth()` and `checkEmbeddingHealth()` functions

### Task 9: Run Full Test Suite
- Verify no regressions
