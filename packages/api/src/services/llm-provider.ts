export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResult {
  response: Record<string, unknown>;
  usage: TokenUsage;
}

export interface EmbeddingProvider {
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface ChatProvider {
  chat(messages: Message[]): Promise<ChatResult>;
}

// --- Batch variants ---

export interface BatchChatRequest {
  id: string;
  messages: Message[];
}

export interface BatchChatResult {
  id: string;
  response: Record<string, unknown>;
  usage: TokenUsage;
}

export interface BatchChatProvider extends ChatProvider {
  readonly batch: true;
  chatBatch(requests: BatchChatRequest[]): Promise<BatchChatResult[]>;
}

export interface BatchEmbedRequest {
  id: string;
  texts: string[];
}

export interface BatchEmbedResult {
  id: string;
  embeddings: number[][];
}

export interface BatchEmbeddingProvider extends EmbeddingProvider {
  readonly batch: true;
  embedBatch(requests: BatchEmbedRequest[]): Promise<BatchEmbedResult[]>;
}

export function isBatchChatProvider(p: ChatProvider): p is BatchChatProvider {
  return "batch" in p && (p as BatchChatProvider).batch === true;
}

export function isBatchEmbeddingProvider(
  p: EmbeddingProvider
): p is BatchEmbeddingProvider {
  return "batch" in p && (p as BatchEmbeddingProvider).batch === true;
}