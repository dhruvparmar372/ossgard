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
import { chunkBatchRequests } from "./batch-chunker.js";

/** Strip markdown code-block wrapping that LLMs sometimes add around JSON. */
function stripCodeBlock(raw: string): string {
  return raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
}

/** Reasoning models (o-series, gpt-5 family) don't support temperature. */
function isReasoningModel(model: string): boolean {
  return /^o\d/.test(model) || /^gpt-5/.test(model);
}

const MAX_TOKEN_LIMIT_RETRIES = 5;
const TOKEN_LIMIT_BASE_DELAY_MS = 60_000; // 1 minute

export interface OpenAIBatchChatProviderOptions {
  apiKey: string;
  model: string;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  timeoutMs?: number;
  tokenLimitRetryBaseMs?: number;
  fetchFn?: typeof fetch;
  logger?: Logger;
}

export class OpenAIBatchChatProvider implements BatchChatProvider {
  readonly batch = true as const;
  readonly maxContextTokens = 128_000;
  static readonly INPUT_TOKEN_BUDGET = 1_000_000; // 50% of OpenAI's 2M enqueued limit

  private apiKey: string;
  private model: string;
  private basePollIntervalMs: number;
  private maxPollIntervalMs: number;
  private timeoutMs: number;
  private tokenLimitRetryBaseMs: number;
  private fetchFn: typeof fetch;
  private encoder: Tiktoken;
  private logger?: Logger;

  constructor(options: OpenAIBatchChatProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchFn = options.fetchFn ?? fetch;
    this.basePollIntervalMs = options.pollIntervalMs ?? 10_000;
    this.maxPollIntervalMs = options.maxPollIntervalMs ?? 600_000;
    this.timeoutMs = options.timeoutMs ?? 24 * 60 * 60 * 1000;
    this.tokenLimitRetryBaseMs = options.tokenLimitRetryBaseMs ?? TOKEN_LIMIT_BASE_DELAY_MS;
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
          ...(isReasoningModel(this.model) ? {} : { temperature: 0 }),
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

    // Resume path: unchanged (single batch only)
    if (options?.existingBatchId) {
      this.logger?.info("Resuming existing batch", { batchId: options.existingBatchId });
      const result = await this.pollBatchToCompletion(options.existingBatchId, Date.now() + this.timeoutMs);
      if (result.status !== "completed" || !result.outputFileId) {
        throw new Error(result.status === "completed"
          ? "OpenAI batch completed but no output_file_id — all requests may have failed."
          : `OpenAI batch ${result.error ?? "failed"}`);
      }
      return this.downloadAndParseResults(result.outputFileId, requests);
    }

    // Chunk requests to stay under token budget
    const chunks = chunkBatchRequests(
      requests,
      (text) => this.countTokens(text),
      OpenAIBatchChatProvider.INPUT_TOKEN_BUDGET
    );

    if (chunks.length === 1) {
      return this.processChunk(chunks[0], options);
    }

    this.logger?.info("Splitting batch into chunks", {
      totalRequests: requests.length,
      chunks: chunks.length,
      budgetPerChunk: OpenAIBatchChatProvider.INPUT_TOKEN_BUDGET,
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

  /** Processes a single chunk: build JSONL, upload, create batch, poll, download results. */
  private async processChunk(
    requests: BatchChatRequest[],
    options?: BatchChatOptions
  ): Promise<BatchChatResult[]> {
    // 1. Build JSONL content
    const jsonlLines = requests.map((req) =>
      JSON.stringify({
        custom_id: req.id,
        method: "POST",
        url: "/v1/chat/completions",
        body: {
          model: this.model,
          ...(isReasoningModel(this.model) ? {} : { temperature: 0 }),
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

    // 3. Create batch + poll (with token limit retry)
    const batchResult = await this.createAndPollBatch(inputFileId, options);

    // 4. Download and parse results
    return this.downloadAndParseResults(batchResult.outputFileId, requests);
  }

  /**
   * Creates a batch from an uploaded file and polls until completion.
   * Retries with exponential backoff when hitting the org's enqueued token limit.
   */
  private async createAndPollBatch(
    inputFileId: string,
    options?: BatchChatOptions
  ): Promise<{ outputFileId: string; batchId: string }> {
    const deadline = Date.now() + this.timeoutMs;

    for (let tokenLimitAttempt = 0; ; tokenLimitAttempt++) {
      // Create batch
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
      const batchId = batchData.id;
      this.logger?.info("Batch created", { batchId });
      options?.onBatchCreated?.(batchId);

      // Poll until completed
      const result = await this.pollBatchToCompletion(batchId, deadline);

      if (result.status === "completed") {
        if (!result.outputFileId) {
          throw new Error(
            "OpenAI batch completed but no output_file_id — all requests may have failed. Check error_file_id for details."
          );
        }
        return { outputFileId: result.outputFileId, batchId };
      }

      // Token limit error — retry with backoff
      if (result.status === "token_limit" && tokenLimitAttempt < MAX_TOKEN_LIMIT_RETRIES) {
        const delay = Math.min(
          this.tokenLimitRetryBaseMs * Math.pow(2, tokenLimitAttempt),
          10 * 60_000 // cap at 10 minutes
        );
        this.logger?.warn("Token limit reached, retrying batch creation", {
          batchId,
          attempt: tokenLimitAttempt + 1,
          maxAttempts: MAX_TOKEN_LIMIT_RETRIES,
          delayMs: delay,
          error: result.error,
        });
        await this.sleep(delay);
        continue;
      }

      // Non-retryable failure
      throw new Error(result.error ?? "OpenAI batch failed");
    }
  }

  /**
   * Polls a batch until it reaches a terminal state.
   * Returns a discriminated result indicating completion, token limit error, or other failure.
   */
  private async pollBatchToCompletion(
    batchId: string,
    deadline: number
  ): Promise<
    | { status: "completed"; outputFileId: string | null }
    | { status: "token_limit"; error: string }
    | { status: "failed"; error: string }
  > {
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
          return { status: "failed", error: `Poll failed after ${consecutiveErrors} consecutive errors: ${errMsg}` };
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
        return { status: "failed", error: `Poll error: ${pollRes.status} ${pollRes.statusText}` };
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
        this.logger?.info("Batch completed", { batchId, elapsedMs });
        return { status: "completed", outputFileId: pollData.output_file_id ?? null };
      }

      if (
        pollData.status === "failed" ||
        pollData.status === "expired" ||
        pollData.status === "cancelled"
      ) {
        const firstError = pollData.errors?.data?.[0]?.message;
        const detail = firstError ?? `Batch ${pollData.status}`;

        // Detect token limit errors — these are retryable
        if (firstError && /enqueued token limit/i.test(firstError)) {
          return { status: "token_limit", error: detail };
        }

        return { status: "failed", error: `OpenAI batch ${pollData.status}: ${detail}` };
      }

      if (Date.now() + nextInterval > deadline) {
        return { status: "failed", error: `Batch timed out after ${this.timeoutMs}ms` };
      }
    }

    return { status: "failed", error: `Batch timed out after ${this.timeoutMs}ms` };
  }

  /** Downloads batch output file and parses JSONL results. */
  private async downloadAndParseResults(
    outputFileId: string,
    requests: BatchChatRequest[]
  ): Promise<BatchChatResult[]> {
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
