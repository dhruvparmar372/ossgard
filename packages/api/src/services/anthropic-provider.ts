import type { LLMProvider, Message } from "./llm-provider.js";

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  fetchFn?: typeof fetch;
}

export class AnthropicProvider implements LLMProvider {
  private apiKey: string;
  private model: string;
  private fetchFn: typeof fetch;

  constructor(options: AnthropicProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async embed(_texts: string[]): Promise<number[][]> {
    throw new Error("Anthropic does not support embeddings");
  }

  async chat(messages: Message[]): Promise<Record<string, unknown>> {
    // Extract system message if present
    const systemMessage = messages.find((m) => m.role === "system");
    const nonSystemMessages = messages.filter((m) => m.role !== "system");

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: 4096,
      messages: nonSystemMessages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    };

    if (systemMessage) {
      body.system = systemMessage.content;
    }

    const response = await this.fetchFn(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      }
    );

    if (!response.ok) {
      throw new Error(
        `Anthropic API error: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text: string }>;
    };

    return JSON.parse(data.content[0].text) as Record<string, unknown>;
  }
}
