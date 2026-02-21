import type {
  BatchEmbeddingProvider,
  BatchEmbedOptions,
  BatchEmbedRequest,
  BatchEmbedResult,
} from "./llm-provider.js";
import type { Logger } from "../logger.js";
import { createTiktokenEncoder, countTokensTiktoken, truncateToTokenLimit, type Tiktoken } from "./token-counting.js";
import { chunkEmbeddingTexts } from "./batch-chunker.js";

const DIMENSION_MAP: Record<string, number> = {
  "text-embedding-3-large": 3072,
  "text-embedding-3-small": 1536,
  "text-embedding-ada-002": 1536,
};

export interface OpenAIBatchEmbeddingProviderOptions {
  apiKey: string;
  model: string;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  logger?: Logger;
}

/** OpenAI max is 300k tokens per embedding request; use 250k for safety */
const EMBEDDING_TOKEN_BUDGET = 250_000;

/** Per-input overhead tokens OpenAI charges beyond the text itself (BOS/EOS/separators) */
const PER_TEXT_OVERHEAD_TOKENS = 20;

export class OpenAIBatchEmbeddingProvider implements BatchEmbeddingProvider {
  readonly batch = true as const;
  readonly dimensions: number;
  readonly maxInputTokens = 8191;

  private apiKey: string;
  private model: string;
  private basePollIntervalMs: number;
  private maxPollIntervalMs: number;
  private timeoutMs: number;
  private fetchFn: typeof fetch;
  private encoder: Tiktoken;
  private logger?: Logger;

  constructor(options: OpenAIBatchEmbeddingProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchFn = options.fetchFn ?? fetch;
    this.dimensions = DIMENSION_MAP[options.model] ?? 3072;
    this.basePollIntervalMs = options.pollIntervalMs ?? 10_000;
    this.maxPollIntervalMs = options.maxPollIntervalMs ?? 600_000;
    this.timeoutMs = options.timeoutMs ?? 24 * 60 * 60 * 1000;
    this.encoder = createTiktokenEncoder(options.model);
    this.logger = options.logger;
  }

  countTokens(text: string): number {
    return countTokensTiktoken(this.encoder, text);
  }

  async embed(texts: string[]): Promise<number[][]> {
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
    for (const chunk of chunks) {
      const embeddings = await this.embedChunk(chunk);
      allEmbeddings.push(...embeddings);
    }
    return allEmbeddings;
  }

  private async embedChunk(texts: string[]): Promise<number[][]> {
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
    };

    return data.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }

  async embedBatch(requests: BatchEmbedRequest[], options?: BatchEmbedOptions): Promise<BatchEmbedResult[]> {
    if (requests.length === 0) return [];

    // Single request: use sync path
    if (requests.length === 1 && !options?.existingBatchId) {
      const embeddings = await this.embed(requests[0].texts);
      return [{ id: requests[0].id, embeddings }];
    }

    let batchId: string;

    if (options?.existingBatchId) {
      // Resume: skip file upload + batch creation
      batchId = options.existingBatchId;
      this.logger?.info("Resuming existing batch", { batchId });
    } else {
      // 1. Build JSONL content (sanitize + truncate texts)
      const jsonlLines = requests.map((req) => {
        const input = req.texts.map((t) => {
          const s = t.length === 0 ? " " : t;
          return truncateToTokenLimit(this.encoder, s, this.maxInputTokens);
        });
        return JSON.stringify({
          custom_id: req.id,
          method: "POST",
          url: "/v1/embeddings",
          body: { model: this.model, input },
        });
      });
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
          endpoint: "/v1/embeddings",
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
        output_file_id?: string;
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
      throw new Error("OpenAI batch completed but no output_file_id");
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
    const resultMap = new Map<string, number[][]>();

    for (const line of resultsText.split("\n")) {
      if (!line.trim()) continue;

      const parsed = JSON.parse(line) as {
        custom_id: string;
        response: {
          status_code: number;
          body: {
            data: Array<{ index: number; embedding: number[] }>;
          };
        };
      };

      if (parsed.response.status_code !== 200) {
        throw new Error(
          `OpenAI batch item ${parsed.custom_id} returned status ${parsed.response.status_code}`
        );
      }

      const embeddings = parsed.response.body.data
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);

      resultMap.set(parsed.custom_id, embeddings);
    }

    // Map results back in input order
    return requests.map((req) => ({
      id: req.id,
      embeddings: resultMap.get(req.id)!,
    }));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
