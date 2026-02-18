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
import { createTiktokenEncoder, countTokensTiktoken, type Tiktoken } from "./token-counting.js";

/** Strip markdown code-block wrapping that LLMs sometimes add around JSON. */
function stripCodeBlock(raw: string): string {
  return raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
}

export interface OpenAIBatchChatProviderOptions {
  apiKey: string;
  model: string;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  logger?: Logger;
}

export class OpenAIBatchChatProvider implements BatchChatProvider {
  readonly batch = true as const;
  readonly maxContextTokens = 128_000;

  private apiKey: string;
  private model: string;
  private basePollIntervalMs: number;
  private maxPollIntervalMs: number;
  private timeoutMs: number;
  private fetchFn: typeof fetch;
  private encoder: Tiktoken;
  private logger?: Logger;

  constructor(options: OpenAIBatchChatProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchFn = options.fetchFn ?? fetch;
    this.basePollIntervalMs = options.pollIntervalMs ?? 10_000;
    this.maxPollIntervalMs = options.maxPollIntervalMs ?? 120_000;
    this.timeoutMs = options.timeoutMs ?? 24 * 60 * 60 * 1000;
    this.encoder = createTiktokenEncoder(options.model);
    this.logger = options.logger;
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
          max_completion_tokens: 8192,
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

    const firstChoice = data.choices[0];
    if (!firstChoice?.message?.content) {
      throw new Error("OpenAI chat returned no content in choices");
    }
    const raw = firstChoice.message.content;
    try {
      return {
        response: JSON.parse(stripCodeBlock(raw)) as Record<string, unknown>,
        usage: {
          inputTokens: data.usage.prompt_tokens,
          outputTokens: data.usage.completion_tokens,
        },
      };
    } catch {
      throw new Error(`LLM returned invalid JSON: ${raw.slice(0, 200)}`);
    }
  }

  async chatBatch(requests: BatchChatRequest[], options?: BatchChatOptions): Promise<BatchChatResult[]> {
    if (requests.length === 0) return [];

    // Single request: use sync path
    if (requests.length === 1 && !options?.existingBatchId) {
      const result = await this.chat(requests[0].messages);
      return [{ id: requests[0].id, response: result.response, usage: result.usage }];
    }

    let batchId: string;

    if (options?.existingBatchId) {
      // Resume: skip file upload + batch creation
      batchId = options.existingBatchId;
      this.logger?.info("Resuming existing batch", { batchId });
    } else {
      // 1. Build JSONL content
      const jsonlLines = requests.map((req) =>
        JSON.stringify({
          custom_id: req.id,
          method: "POST",
          url: "/v1/chat/completions",
          body: {
            model: this.model,
            max_completion_tokens: 8192,
            response_format: { type: "json_object" },
            messages: req.messages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
          },
        })
      );
      const jsonlContent = jsonlLines.join("\n");

      // 2. Upload file
      const formData = new FormData();
      formData.append("purpose", "batch");
      formData.append(
        "file",
        new Blob([jsonlContent], { type: "application/jsonl" }),
        "batch-input.jsonl"
      );

      const uploadRes = await this.fetchFn("https://api.openai.com/v1/files", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: formData,
      });

      if (!uploadRes.ok) {
        throw new Error(
          `OpenAI file upload error: ${uploadRes.status} ${uploadRes.statusText}`
        );
      }

      const uploadData = (await uploadRes.json()) as { id: string };
      const inputFileId = uploadData.id;

      // 3. Create batch
      const createRes = await this.fetchFn("https://api.openai.com/v1/batches", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          input_file_id: inputFileId,
          endpoint: "/v1/chat/completions",
          completion_window: "24h",
        }),
      });

      if (!createRes.ok) {
        throw new Error(
          `OpenAI batch create error: ${createRes.status} ${createRes.statusText}`
        );
      }

      const batchData = (await createRes.json()) as { id: string };
      batchId = batchData.id;
      this.logger?.info("Batch created", { batchId });
      options?.onBatchCreated?.(batchId);
    }

    // 4. Poll until completed (progressive intervals with transient error tolerance)
    const deadline = Date.now() + this.timeoutMs;
    const startTime = Date.now();
    let outputFileId: string | null = null;
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
          `https://api.openai.com/v1/batches/${batchId}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
            },
          }
        );
      } catch (err) {
        consecutiveErrors++;
        const errMsg = err instanceof Error ? err.message : String(err);
        if (consecutiveErrors >= 4) {
          throw new Error(`OpenAI batch poll failed after ${consecutiveErrors} consecutive errors: ${errMsg}`);
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
          `OpenAI batch poll error: ${pollRes.status} ${pollRes.statusText}`
        );
      }

      consecutiveErrors = 0;

      const pollData = (await pollRes.json()) as {
        status: string;
        output_file_id?: string | null;
        error_file_id?: string | null;
        request_counts?: { total: number; completed: number; failed: number };
        errors?: { data?: Array<{ message?: string }> };
      };

      const elapsedMs = Date.now() - startTime;
      const nextInterval = Math.min(
        this.basePollIntervalMs * Math.pow(1.5, pollCount),
        this.maxPollIntervalMs
      );
      this.logger?.info("Polling batch", {
        batchId,
        status: pollData.status,
        elapsedMs,
        nextPollMs: nextInterval,
      });

      if (pollData.status === "completed") {
        outputFileId = pollData.output_file_id ?? null;
        this.logger?.info("Batch completed", { batchId, elapsedMs });
        break;
      }

      if (
        pollData.status === "failed" ||
        pollData.status === "expired" ||
        pollData.status === "cancelled"
      ) {
        const firstError = pollData.errors?.data?.[0]?.message;
        const detail = firstError ? `: ${firstError}` : "";
        throw new Error(`OpenAI batch ${pollData.status}${detail}`);
      }

      if (Date.now() + nextInterval > deadline) {
        throw new Error(`OpenAI batch timed out after ${this.timeoutMs}ms`);
      }
    }

    if (!outputFileId) {
      throw new Error("OpenAI batch completed but no output_file_id — all requests may have failed. Check error_file_id for details.");
    }

    // 5. Download results
    const downloadRes = await this.fetchFn(
      `https://api.openai.com/v1/files/${outputFileId}/content`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      }
    );

    if (!downloadRes.ok) {
      throw new Error(
        `OpenAI file download error: ${downloadRes.status} ${downloadRes.statusText}`
      );
    }

    const resultsText = await downloadRes.text();
    const resultMap = new Map<string, BatchChatResult>();

    for (const line of resultsText.split("\n")) {
      if (!line.trim()) continue;

      const parsed = JSON.parse(line) as {
        custom_id: string;
        response: {
          status_code: number;
          body: {
            choices?: Array<{ message: { content: string } }>;
            usage?: { prompt_tokens: number; completion_tokens: number };
            error?: { message: string };
          };
        };
      };

      if (parsed.response.status_code !== 200) {
        const errorMsg =
          parsed.response.body?.error?.message ??
          `Status ${parsed.response.status_code}`;
        resultMap.set(parsed.custom_id, {
          id: parsed.custom_id,
          response: {},
          usage: { inputTokens: 0, outputTokens: 0 },
          error: errorMsg,
        });
        continue;
      }

      const firstChoice = parsed.response.body.choices?.[0];
      if (!firstChoice?.message?.content) {
        resultMap.set(parsed.custom_id, {
          id: parsed.custom_id,
          response: {},
          usage: { inputTokens: 0, outputTokens: 0 },
          error: "No content in choices",
        });
        continue;
      }

      const raw = firstChoice.message.content;
      const usage = parsed.response.body.usage;

      try {
        const response = JSON.parse(stripCodeBlock(raw)) as Record<string, unknown>;
        resultMap.set(parsed.custom_id, {
          id: parsed.custom_id,
          response,
          usage: {
            inputTokens: usage?.prompt_tokens ?? 0,
            outputTokens: usage?.completion_tokens ?? 0,
          },
        });
      } catch {
        resultMap.set(parsed.custom_id, {
          id: parsed.custom_id,
          response: {},
          usage: { inputTokens: 0, outputTokens: 0 },
          error: `Invalid JSON in response: ${raw.slice(0, 200)}`,
        });
      }
    }

    // Map results back in input order
    return requests.map((req) => {
      const result = resultMap.get(req.id);
      if (!result) {
        return {
          id: req.id,
          response: {},
          usage: { inputTokens: 0, outputTokens: 0 },
          error: "No result returned from batch",
        };
      }
      return result;
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
