import type { EmbeddingProvider, ChatProvider, Message } from "./llm-provider.js";

const DIMENSION_MAP: Record<string, number> = {
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "all-minilm": 384,
};

export interface OllamaProviderOptions {
  baseUrl: string;
  embeddingModel: string;
  chatModel: string;
  fetchFn?: typeof fetch;
}

export class OllamaProvider implements EmbeddingProvider, ChatProvider {
  readonly dimensions: number;
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

  async chat(messages: Message[]): Promise<Record<string, unknown>> {
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
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error(
        `LLM returned invalid JSON: ${raw.slice(0, 200)}`
      );
    }
  }
}
