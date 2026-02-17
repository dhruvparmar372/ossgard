import type {
  BatchChatProvider,
  BatchChatRequest,
  BatchChatResult,
  ChatResult,
  Message,
  TokenUsage,
} from "./llm-provider.js";

export interface AnthropicBatchProviderOptions {
  apiKey: string;
  model: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class AnthropicBatchProvider implements BatchChatProvider {
  readonly batch = true as const;

  private apiKey: string;
  private model: string;
  private pollIntervalMs: number;
  private timeoutMs: number;
  private fetchFn: typeof fetch;

  constructor(options: AnthropicBatchProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.pollIntervalMs = options.pollIntervalMs ?? 10_000;
    this.timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async chat(messages: Message[]): Promise<ChatResult> {
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
      body.system = [
        {
          type: "text",
          text: systemMessage.content,
          cache_control: { type: "ephemeral" },
        },
      ];
    }

    const response = await this.fetchFn(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "prompt-caching-2024-07-31",
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
      usage: { input_tokens: number; output_tokens: number };
    };

    const raw = data.content[0].text;
    try {
      return {
        response: JSON.parse(raw) as Record<string, unknown>,
        usage: {
          inputTokens: data.usage.input_tokens,
          outputTokens: data.usage.output_tokens,
        },
      };
    } catch {
      throw new Error(`LLM returned invalid JSON: ${raw.slice(0, 200)}`);
    }
  }

  async chatBatch(requests: BatchChatRequest[]): Promise<BatchChatResult[]> {
    if (requests.length === 0) return [];

    // Single request: use sync path for efficiency
    if (requests.length === 1) {
      const result = await this.chat(requests[0].messages);
      return [{ id: requests[0].id, response: result.response, usage: result.usage }];
    }

    // Build batch requests
    const batchRequests = requests.map((req) => {
      const systemMessage = req.messages.find((m) => m.role === "system");
      const nonSystemMessages = req.messages.filter(
        (m) => m.role !== "system"
      );

      const params: Record<string, unknown> = {
        model: this.model,
        max_tokens: 4096,
        messages: nonSystemMessages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      };

      if (systemMessage) {
        params.system = [
          {
            type: "text",
            text: systemMessage.content,
            cache_control: { type: "ephemeral" },
          },
        ];
      }

      return { custom_id: req.id, params };
    });

    // 1. Create batch
    const createRes = await this.fetchFn(
      "https://api.anthropic.com/v1/messages/batches",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "prompt-caching-2024-07-31,message-batches-2024-09-24",
        },
        body: JSON.stringify({ requests: batchRequests }),
      }
    );

    if (!createRes.ok) {
      throw new Error(
        `Anthropic batch create error: ${createRes.status} ${createRes.statusText}`
      );
    }

    const batch = (await createRes.json()) as { id: string };
    const batchId = batch.id;

    // 2. Poll until ended
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      await this.sleep(this.pollIntervalMs);

      const pollRes = await this.fetchFn(
        `https://api.anthropic.com/v1/messages/batches/${batchId}`,
        {
          method: "GET",
          headers: {
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "message-batches-2024-09-24",
          },
        }
      );

      if (!pollRes.ok) {
        throw new Error(
          `Anthropic batch poll error: ${pollRes.status} ${pollRes.statusText}`
        );
      }

      const status = (await pollRes.json()) as {
        processing_status: string;
      };

      if (status.processing_status === "ended") break;

      if (Date.now() + this.pollIntervalMs > deadline) {
        throw new Error(
          `Anthropic batch timed out after ${this.timeoutMs}ms`
        );
      }
    }

    // 3. Retrieve results (JSONL)
    const resultsRes = await this.fetchFn(
      `https://api.anthropic.com/v1/messages/batches/${batchId}/results`,
      {
        method: "GET",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "message-batches-2024-09-24",
        },
      }
    );

    if (!resultsRes.ok) {
      throw new Error(
        `Anthropic batch results error: ${resultsRes.status} ${resultsRes.statusText}`
      );
    }

    const resultsText = await resultsRes.text();
    const resultMap = new Map<string, { response: Record<string, unknown>; usage: TokenUsage }>();

    for (const line of resultsText.split("\n")) {
      if (!line.trim()) continue;

      const parsed = JSON.parse(line) as {
        custom_id: string;
        result: {
          type: string;
          message?: {
            content: Array<{ type: string; text: string }>;
            usage: { input_tokens: number; output_tokens: number };
          };
          error?: { message: string };
        };
      };

      if (parsed.result.type === "errored") {
        throw new Error(
          `Anthropic batch item ${parsed.custom_id} errored: ${parsed.result.error?.message ?? "unknown error"}`
        );
      }

      const msg = parsed.result.message!;
      const raw = msg.content[0].text;
      try {
        resultMap.set(parsed.custom_id, {
          response: JSON.parse(raw),
          usage: {
            inputTokens: msg.usage?.input_tokens ?? 0,
            outputTokens: msg.usage?.output_tokens ?? 0,
          },
        });
      } catch {
        throw new Error(
          `LLM returned invalid JSON for ${parsed.custom_id}: ${raw.slice(0, 200)}`
        );
      }
    }

    // Map results back in input order
    return requests.map((req) => {
      const entry = resultMap.get(req.id)!;
      return { id: req.id, response: entry.response, usage: entry.usage };
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
