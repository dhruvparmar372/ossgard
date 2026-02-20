import type {
  BatchChatOptions,
  BatchChatProvider,
  BatchChatRequest,
  BatchChatResult,
  ChatResult,
  Message,
  TokenUsage,
} from "./llm-provider.js";
import type { Logger } from "../logger.js";
import { countTokensHeuristic } from "./token-counting.js";
import { chunkBatchRequests } from "./batch-chunker.js";

export interface AnthropicBatchProviderOptions {
  apiKey: string;
  model: string;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  logger?: Logger;
}

/** Strip markdown code-block wrapping that LLMs sometimes add around JSON. */
function stripCodeBlock(raw: string): string {
  return raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
}

export class AnthropicBatchProvider implements BatchChatProvider {
  readonly batch = true as const;
  readonly maxContextTokens = 200_000;
  static readonly INPUT_TOKEN_BUDGET = 1_000_000; // conservative budget

  private apiKey: string;
  private model: string;
  private basePollIntervalMs: number;
  private maxPollIntervalMs: number;
  private timeoutMs: number;
  private fetchFn: typeof fetch;
  private logger?: Logger;

  constructor(options: AnthropicBatchProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.basePollIntervalMs = options.pollIntervalMs ?? 10_000;
    this.maxPollIntervalMs = options.maxPollIntervalMs ?? 120_000;
    this.timeoutMs = options.timeoutMs ?? 4 * 60 * 60 * 1000;
    this.fetchFn = options.fetchFn ?? fetch;
    this.logger = options.logger;
  }

  countTokens(text: string): number {
    return countTokensHeuristic(text, 3.5);
  }

  async chat(messages: Message[]): Promise<ChatResult> {
    const systemMessage = messages.find((m) => m.role === "system");
    const nonSystemMessages = messages.filter((m) => m.role !== "system");

    const body: Record<string, unknown> = {
      model: this.model,
      temperature: 0,
      max_tokens: 8192,
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
        response: JSON.parse(stripCodeBlock(raw)) as Record<string, unknown>,
        usage: {
          inputTokens: data.usage.input_tokens,
          outputTokens: data.usage.output_tokens,
        },
      };
    } catch {
      throw new Error(`LLM returned invalid JSON: ${raw.slice(0, 200)}`);
    }
  }

  async chatBatch(requests: BatchChatRequest[], options?: BatchChatOptions): Promise<BatchChatResult[]> {
    if (requests.length === 0) return [];

    // Single request: use sync path for efficiency
    if (requests.length === 1 && !options?.existingBatchId) {
      const result = await this.chat(requests[0].messages);
      return [{ id: requests[0].id, response: result.response, usage: result.usage }];
    }

    // Resume path: unchanged (single batch only)
    if (options?.existingBatchId) {
      this.logger?.info("Resuming existing batch", { batchId: options.existingBatchId });
      return this.processChunk(requests, options);
    }

    // Chunk requests to stay under token budget
    const chunks = chunkBatchRequests(
      requests,
      (text) => this.countTokens(text),
      AnthropicBatchProvider.INPUT_TOKEN_BUDGET
    );

    if (chunks.length === 1) {
      return this.processChunk(chunks[0], options);
    }

    this.logger?.info("Splitting batch into chunks", {
      totalRequests: requests.length,
      chunks: chunks.length,
      budgetPerChunk: AnthropicBatchProvider.INPUT_TOKEN_BUDGET,
    });

    const allResults = new Map<string, BatchChatResult>();
    for (let i = 0; i < chunks.length; i++) {
      this.logger?.info("Processing chunk", {
        chunk: i + 1,
        of: chunks.length,
        requests: chunks[i].length,
      });
      const chunkResults = await this.processChunk(chunks[i], options);
      for (const r of chunkResults) allResults.set(r.id, r);
    }

    return requests.map((req) => allResults.get(req.id) ?? {
      id: req.id,
      response: {},
      usage: { inputTokens: 0, outputTokens: 0 },
      error: "No result returned from batch",
    });
  }

  /** Processes a single chunk: create batch, poll, retrieve results. */
  private async processChunk(
    requests: BatchChatRequest[],
    options?: BatchChatOptions
  ): Promise<BatchChatResult[]> {
    let batchId: string;

    if (options?.existingBatchId) {
      batchId = options.existingBatchId;
    } else {
      // Build batch requests
      const batchRequests = requests.map((req) => {
        const systemMessage = req.messages.find((m) => m.role === "system");
        const nonSystemMessages = req.messages.filter(
          (m) => m.role !== "system"
        );

        const params: Record<string, unknown> = {
          model: this.model,
          temperature: 0,
          max_tokens: 8192,
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
      batchId = batch.id;
      this.logger?.info("Batch created", { batchId });
      options?.onBatchCreated?.(batchId);
    }

    // 2. Poll until ended (progressive intervals with transient error tolerance)
    const deadline = Date.now() + this.timeoutMs;
    const startTime = Date.now();
    let pollCount = 0;
    let consecutiveErrors = 0;

    while (Date.now() < deadline) {
      const pollInterval = Math.min(
        this.basePollIntervalMs * Math.pow(1.5, pollCount),
        this.maxPollIntervalMs
      );
      await this.sleep(pollInterval);
      pollCount++;

      let pollRes: Response;
      try {
        pollRes = await this.fetchFn(
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
      } catch (err) {
        consecutiveErrors++;
        const errMsg = err instanceof Error ? err.message : String(err);
        if (consecutiveErrors >= 4) {
          throw new Error(`Anthropic batch poll failed after ${consecutiveErrors} consecutive errors: ${errMsg}`);
        }
        this.logger?.warn("Transient poll error (network)", { batchId, consecutiveErrors, error: errMsg });
        continue;
      }

      if (!pollRes.ok) {
        const status = pollRes.status;
        if (status >= 500 && consecutiveErrors < 3) {
          consecutiveErrors++;
          this.logger?.warn("Transient poll error", { batchId, status, consecutiveErrors });
          continue;
        }
        throw new Error(
          `Anthropic batch poll error: ${pollRes.status} ${pollRes.statusText}`
        );
      }

      consecutiveErrors = 0;

      const statusData = (await pollRes.json()) as {
        processing_status: string;
      };

      const elapsedMs = Date.now() - startTime;
      const nextInterval = Math.min(
        this.basePollIntervalMs * Math.pow(1.5, pollCount),
        this.maxPollIntervalMs
      );
      this.logger?.info("Polling batch", {
        batchId,
        status: statusData.processing_status,
        elapsedMs,
        nextPollMs: nextInterval,
      });

      if (statusData.processing_status === "ended") {
        this.logger?.info("Batch completed", { batchId, elapsedMs });
        break;
      }

      if (Date.now() + nextInterval > deadline) {
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
    const resultMap = new Map<string, { response: Record<string, unknown>; usage: TokenUsage; error?: string }>();

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
        const errorMsg = parsed.result.error?.message ?? "unknown error";
        this.logger?.warn("Batch item errored", { customId: parsed.custom_id, error: errorMsg });
        resultMap.set(parsed.custom_id, {
          response: {},
          usage: { inputTokens: 0, outputTokens: 0 },
          error: errorMsg,
        });
        continue;
      }

      const msg = parsed.result.message!;
      const raw = msg.content[0].text;
      try {
        resultMap.set(parsed.custom_id, {
          response: JSON.parse(stripCodeBlock(raw)),
          usage: {
            inputTokens: msg.usage?.input_tokens ?? 0,
            outputTokens: msg.usage?.output_tokens ?? 0,
          },
        });
      } catch {
        const errorMsg = `Invalid JSON: ${raw.slice(0, 200)}`;
        this.logger?.warn("Batch item returned invalid JSON", { customId: parsed.custom_id, preview: raw.slice(0, 200) });
        resultMap.set(parsed.custom_id, {
          response: {},
          usage: {
            inputTokens: msg.usage?.input_tokens ?? 0,
            outputTokens: msg.usage?.output_tokens ?? 0,
          },
          error: errorMsg,
        });
      }
    }

    // Map results back in input order
    return requests.map((req) => {
      const entry = resultMap.get(req.id);
      if (!entry) {
        return { id: req.id, response: {}, usage: { inputTokens: 0, outputTokens: 0 }, error: "No result returned from batch" };
      }
      return { id: req.id, response: entry.response, usage: entry.usage, error: entry.error };
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
