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
