import type { LLMProvider, Message } from "./llm-provider.js";

export interface OllamaProviderOptions {
  baseUrl: string;
  embeddingModel: string;
  chatModel: string;
  fetchFn?: typeof fetch;
}

export class OllamaProvider implements LLMProvider {
  private baseUrl: string;
  private embeddingModel: string;
  private chatModel: string;
  private fetchFn: typeof fetch;

  constructor(options: OllamaProviderOptions) {
    this.baseUrl = options.baseUrl;
    this.embeddingModel = options.embeddingModel;
    this.chatModel = options.chatModel;
    this.fetchFn = options.fetchFn ?? fetch;
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

    return JSON.parse(data.message.content) as Record<string, unknown>;
  }
}
