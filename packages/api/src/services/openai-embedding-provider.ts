import type { EmbeddingProvider, EmbedResult } from "./llm-provider.js";
import { createTiktokenEncoder, countTokensTiktoken, truncateToTokenLimit, type Tiktoken } from "./token-counting.js";
import { chunkEmbeddingTexts } from "./batch-chunker.js";

const DIMENSION_MAP: Record<string, number> = {
  "text-embedding-3-large": 3072,
  "text-embedding-3-small": 1536,
  "text-embedding-ada-002": 1536,
};

export interface OpenAIEmbeddingProviderOptions {
  apiKey: string;
  model: string;
  fetchFn?: typeof fetch;
}

/** OpenAI max is 300k tokens per embedding request; use 250k for safety */
const EMBEDDING_TOKEN_BUDGET = 250_000;

/** Per-input overhead tokens OpenAI charges beyond the text itself (BOS/EOS/separators) */
const PER_TEXT_OVERHEAD_TOKENS = 20;

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  readonly maxInputTokens = 8191;
  private apiKey: string;
  private model: string;
  private fetchFn: typeof fetch;
  private encoder: Tiktoken;

  constructor(options: OpenAIEmbeddingProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchFn = options.fetchFn ?? fetch;
    this.dimensions = DIMENSION_MAP[options.model] ?? 3072;
    this.encoder = createTiktokenEncoder(options.model);
  }

  countTokens(text: string): number {
    return countTokensTiktoken(this.encoder, text);
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    // OpenAI rejects empty strings — replace with a single space
    const sanitized = texts.map((t) => (t.length === 0 ? " " : t));

    // Truncate individual texts that exceed the per-input token limit
    const truncated = sanitized.map((t) =>
      truncateToTokenLimit(this.encoder, t, this.maxInputTokens)
    );

    const chunks = chunkEmbeddingTexts(
      truncated,
      (t) => this.countTokens(t) + PER_TEXT_OVERHEAD_TOKENS,
      EMBEDDING_TOKEN_BUDGET
    );

    const allEmbeddings: number[][] = [];
    let totalTokens = 0;
    for (const chunk of chunks) {
      const { embeddings, tokenCount } = await this.embedChunk(chunk);
      allEmbeddings.push(...embeddings);
      totalTokens += tokenCount;
    }
    return { vectors: allEmbeddings, tokenCount: totalTokens };
  }

  private async embedChunk(texts: string[]): Promise<{ embeddings: number[][]; tokenCount: number }> {
    const response = await this.fetchFn(
      "https://api.openai.com/v1/embeddings",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
        }),
      }
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `OpenAI embedding error: ${response.status} ${response.statusText} — ${body}`
      );
    }

    const data = (await response.json()) as {
      data: Array<{ index: number; embedding: number[] }>;
      usage?: { prompt_tokens: number };
    };

    // Sort by index to guarantee input order
    const embeddings = data.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);

    return { embeddings, tokenCount: data.usage?.prompt_tokens ?? 0 };
  }
}
