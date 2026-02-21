import type { BatchChatRequest } from "./llm-provider.js";

const PER_REQUEST_OVERHEAD_TOKENS = 50; // roles, JSON structure, etc.

export function estimateRequestTokens(
  req: BatchChatRequest,
  countTokens: (text: string) => number
): number {
  let tokens = PER_REQUEST_OVERHEAD_TOKENS;
  for (const msg of req.messages) {
    tokens += countTokens(msg.content);
  }
  return tokens;
}

/**
 * Splits batch requests into chunks where each chunk's estimated
 * input tokens stays under the given budget.
 * Always puts at least 1 request per chunk (even if it exceeds budget).
 */
export function chunkBatchRequests(
  requests: BatchChatRequest[],
  countTokens: (text: string) => number,
  tokenBudget: number
): BatchChatRequest[][] {
  const chunks: BatchChatRequest[][] = [];
  let currentChunk: BatchChatRequest[] = [];
  let currentTokens = 0;

  for (const req of requests) {
    const reqTokens = estimateRequestTokens(req, countTokens);

    if (currentChunk.length > 0 && currentTokens + reqTokens > tokenBudget) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }

    currentChunk.push(req);
    currentTokens += reqTokens;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/** OpenAI /v1/embeddings has an undocumented per-request item limit */
const MAX_EMBEDDING_ITEMS_PER_CHUNK = 2048;

/**
 * Splits embedding texts into chunks where each chunk's total tokens
 * stays under the given budget AND item count stays under the max.
 * Always puts at least 1 text per chunk (even if it exceeds budget).
 */
export function chunkEmbeddingTexts(
  texts: string[],
  countTokens: (text: string) => number,
  tokenBudget: number,
  maxItems: number = MAX_EMBEDDING_ITEMS_PER_CHUNK
): string[][] {
  const chunks: string[][] = [];
  let currentChunk: string[] = [];
  let currentTokens = 0;

  for (const text of texts) {
    const tokens = countTokens(text);

    if (
      currentChunk.length > 0 &&
      (currentTokens + tokens > tokenBudget || currentChunk.length >= maxItems)
    ) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }

    currentChunk.push(text);
    currentTokens += tokens;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}
