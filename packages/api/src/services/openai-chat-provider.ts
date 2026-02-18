import type { ChatProvider, ChatResult, Message } from "./llm-provider.js";
import { createTiktokenEncoder, countTokensTiktoken, type Tiktoken } from "./token-counting.js";

export interface OpenAIChatProviderOptions {
  apiKey: string;
  model: string;
  fetchFn?: typeof fetch;
}

export class OpenAIChatProvider implements ChatProvider {
  readonly maxContextTokens = 128_000;
  private apiKey: string;
  private model: string;
  private fetchFn: typeof fetch;
  private encoder: Tiktoken;

  constructor(options: OpenAIChatProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchFn = options.fetchFn ?? fetch;
    this.encoder = createTiktokenEncoder(options.model);
  }

  countTokens(text: string): number {
    return countTokensTiktoken(this.encoder, text);
  }

  async chat(messages: Message[]): Promise<ChatResult> {
    const response = await this.fetchFn(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 8192,
          response_format: { type: "json_object" },
          messages: messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      }
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `OpenAI chat error: ${response.status} ${response.statusText} — ${body}`
      );
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    const raw = data.choices[0].message.content;
    try {
      return {
        response: JSON.parse(raw) as Record<string, unknown>,
        usage: {
          inputTokens: data.usage.prompt_tokens,
          outputTokens: data.usage.completion_tokens,
        },
      };
    } catch {
      throw new Error(`LLM returned invalid JSON: ${raw.slice(0, 200)}`);
    }
  }
}
