import type {
  BatchEmbeddingProvider,
  BatchEmbedRequest,
  BatchEmbedResult,
} from "./llm-provider.js";

const DIMENSION_MAP: Record<string, number> = {
  "text-embedding-3-large": 3072,
  "text-embedding-3-small": 1536,
  "text-embedding-ada-002": 1536,
};

export interface OpenAIBatchEmbeddingProviderOptions {
  apiKey: string;
  model: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class OpenAIBatchEmbeddingProvider implements BatchEmbeddingProvider {
  readonly batch = true as const;
  readonly dimensions: number;

  private apiKey: string;
  private model: string;
  private pollIntervalMs: number;
  private timeoutMs: number;
  private fetchFn: typeof fetch;

  constructor(options: OpenAIBatchEmbeddingProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchFn = options.fetchFn ?? fetch;
    this.dimensions = DIMENSION_MAP[options.model] ?? 3072;
    this.pollIntervalMs = options.pollIntervalMs ?? 10_000;
    this.timeoutMs = options.timeoutMs ?? 2 * 60 * 60 * 1000;
  }

  async embed(texts: string[]): Promise<number[][]> {
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
      throw new Error(
        `OpenAI embedding error: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as {
      data: Array<{ index: number; embedding: number[] }>;
    };

    return data.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }

  async embedBatch(requests: BatchEmbedRequest[]): Promise<BatchEmbedResult[]> {
    if (requests.length === 0) return [];

    // Single request: use sync path
    if (requests.length === 1) {
      const embeddings = await this.embed(requests[0].texts);
      return [{ id: requests[0].id, embeddings }];
    }

    // 1. Build JSONL content
    const jsonlLines = requests.map((req) =>
      JSON.stringify({
        custom_id: req.id,
        method: "POST",
        url: "/v1/embeddings",
        body: { model: this.model, input: req.texts },
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
    const batchId = batchData.id;

    // 4. Poll until completed
    const deadline = Date.now() + this.timeoutMs;
    let outputFileId: string | null = null;

    while (Date.now() < deadline) {
      await this.sleep(this.pollIntervalMs);

      const pollRes = await this.fetchFn(
        `https://api.openai.com/v1/batches/${batchId}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
        }
      );

      if (!pollRes.ok) {
        throw new Error(
          `OpenAI batch poll error: ${pollRes.status} ${pollRes.statusText}`
        );
      }

      const pollData = (await pollRes.json()) as {
        status: string;
        output_file_id?: string;
      };

      if (pollData.status === "completed") {
        outputFileId = pollData.output_file_id ?? null;
        break;
      }

      if (
        pollData.status === "failed" ||
        pollData.status === "expired" ||
        pollData.status === "cancelled"
      ) {
        throw new Error(`OpenAI batch ${pollData.status}`);
      }

      if (Date.now() + this.pollIntervalMs > deadline) {
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
