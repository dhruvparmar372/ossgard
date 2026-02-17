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
  readonly maxInputTokens: number;
  countTokens(text: string): number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface ChatProvider {
  readonly maxContextTokens: number;
  countTokens(text: string): number;
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
  error?: string;
}

export interface BatchChatOptions {
  existingBatchId?: string;
  onBatchCreated?: (batchId: string) => void;
}

export interface BatchChatProvider extends ChatProvider {
  readonly batch: true;
  chatBatch(requests: BatchChatRequest[], options?: BatchChatOptions): Promise<BatchChatResult[]>;
}

export interface BatchEmbedRequest {
  id: string;
  texts: string[];
}

export interface BatchEmbedResult {
  id: string;
  embeddings: number[][];
}

export interface BatchEmbedOptions {
  existingBatchId?: string;
  onBatchCreated?: (batchId: string) => void;
}

export interface BatchEmbeddingProvider extends EmbeddingProvider {
  readonly batch: true;
  embedBatch(requests: BatchEmbedRequest[], options?: BatchEmbedOptions): Promise<BatchEmbedResult[]>;
}

export function isBatchChatProvider(p: ChatProvider): p is BatchChatProvider {
  return "batch" in p && (p as BatchChatProvider).batch === true;
}

export function isBatchEmbeddingProvider(
  p: EmbeddingProvider
): p is BatchEmbeddingProvider {
  return "batch" in p && (p as BatchEmbeddingProvider).batch === true;
}