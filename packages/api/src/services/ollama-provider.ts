import type { EmbeddingProvider, ChatProvider, ChatResult, Message } from "./llm-provider.js";
import { countTokensHeuristic } from "./token-counting.js";

const DIMENSION_MAP: Record<string, number> = {
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "all-minilm": 384,
};

const MAX_INPUT_TOKENS_MAP: Record<string, number> = {
  "nomic-embed-text": 8192,
  "mxbai-embed-large": 512,
  "all-minilm": 256,
};

export interface OllamaProviderOptions {
  baseUrl: string;
  embeddingModel: string;
  chatModel: string;
  fetchFn?: typeof fetch;
}

export class OllamaProvider implements EmbeddingProvider, ChatProvider {
  readonly dimensions: number;
  readonly maxInputTokens: number;
  readonly maxContextTokens = 8192;
  private baseUrl: string;
  private embeddingModel: string;
  private chatModel: string;
  private fetchFn: typeof fetch;

  constructor(options: OllamaProviderOptions) {
    this.baseUrl = options.baseUrl;
    this.embeddingModel = options.embeddingModel;
    this.chatModel = options.chatModel;
    this.fetchFn = options.fetchFn ?? fetch;
    this.dimensions = DIMENSION_MAP[options.embeddingModel] ?? 768;
    this.maxInputTokens = MAX_INPUT_TOKENS_MAP[options.embeddingModel] ?? 8192;
  }

  countTokens(text: string): number {
    return countTokensHeuristic(text, 4);
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await this.fetchFn(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.embeddingModel,
        input: texts,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Ollama embed error: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as { embeddings: number[][] };
    return data.embeddings;
  }

  async chat(messages: Message[]): Promise<ChatResult> {
    const response = await this.fetchFn(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.chatModel,
        messages,
        stream: false,
        format: "json",
        options: { num_ctx: 8192 },
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Ollama chat error: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as {
      message: { content: string };
    };

    const raw = data.message.content;
    try {
      return {
        response: JSON.parse(raw) as Record<string, unknown>,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    } catch {
      throw new Error(
        `LLM returned invalid JSON: ${raw.slice(0, 200)}`
      );
    }
  }
}
