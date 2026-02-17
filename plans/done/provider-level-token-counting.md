# Provider-Level Token Counting

## Context

The embed pipeline was failing with OpenAI 400 errors because PR text exceeded the 8,191 token-per-text limit. A character-based truncation fix (`MAX_EMBEDDING_CHARS = 25_000`, ~6,250 tokens) was added as a stopgap, but it wasted ~24% of the available budget due to imprecise character-to-token estimation. The verify and rank stages had no truncation at all, risking context window overflows.

This change adds `countTokens()` and max-token properties to the provider interfaces so each provider owns its tokenization logic. Consumers target 95% of the token budget for maximum utilization with a safety margin.

## Changes

### New dependency

- `js-tiktoken` — lightweight BPE tokenizer compatible with OpenAI's tiktoken, used for exact token counting on OpenAI embedding providers.

### New file: `packages/api/src/services/token-counting.ts`

Shared utilities:
- `TOKEN_BUDGET_FACTOR = 0.95` — safety margin for all token budgets
- `createTiktokenEncoder(model)` — creates a tiktoken encoder, falls back to `cl100k_base`
- `countTokensTiktoken(encoder, text)` — exact BPE token count
- `countTokensHeuristic(text, charsPerToken)` — ceiling-based character heuristic

### Updated interfaces (`llm-provider.ts`)

```typescript
interface EmbeddingProvider {
  readonly dimensions: number;
  readonly maxInputTokens: number;      // NEW
  countTokens(text: string): number;    // NEW
  embed(texts: string[]): Promise<number[][]>;
}

interface ChatProvider {
  readonly maxContextTokens: number;    // NEW
  countTokens(text: string): number;    // NEW
  chat(messages: Message[]): Promise<ChatResult>;
}
```

Batch variants (`BatchChatProvider`, `BatchEmbeddingProvider`) inherit these via `extends`.

### Provider implementations

| Provider | Token counting | Max tokens |
|----------|---------------|------------|
| `OpenAIEmbeddingProvider` | Exact BPE via tiktoken | `maxInputTokens: 8191` |
| `OpenAIBatchEmbeddingProvider` | Exact BPE via tiktoken | `maxInputTokens: 8191` |
| `AnthropicProvider` | Heuristic @ 3.5 chars/token | `maxContextTokens: 200_000` |
| `AnthropicBatchProvider` | Heuristic @ 3.5 chars/token | `maxContextTokens: 200_000` |
| `OllamaProvider` | Heuristic @ 4 chars/token | `maxInputTokens: model-mapped` (8192/512/256), `maxContextTokens: 8192` |

### Pipeline changes

**`embed.ts`** — Removed `MAX_EMBEDDING_CHARS`. `buildCodeInput`, `buildIntentInput`, and `joinWithinBudget` now accept `tokenBudget` and `countTokens` function parameters. Budget is `Math.floor(provider.maxInputTokens * TOKEN_BUDGET_FACTOR)`.

**`prompts.ts`** — Added optional `TokenCounter` parameter to `buildVerifyPrompt` and `buildRankPrompt`. When provided, computes available budget after system prompt + output reserve (4096 tokens), then fits PR summaries within it. Falls back to truncated summaries (body: 500 chars, files: 20 max) when full summaries exceed budget. Without `TokenCounter`, behavior is unchanged (backward compat).

**`verify.ts`** / **`rank.ts`** — Pass `llm` provider as the `TokenCounter` argument to prompt builders.

### Tests

- All mock providers updated with `maxInputTokens`/`maxContextTokens` + `countTokens`
- New `token-counting.test.ts` with 10 tests covering all utilities
- Provider tests extended with assertions for `countTokens` return values and max-token properties
- All 282 tests pass
