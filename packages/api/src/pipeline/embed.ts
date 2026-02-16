import type { Job } from "@ossgard/shared";
import type { Database } from "../db/database.js";
import type { EmbeddingProvider } from "../services/llm-provider.js";
import { isBatchEmbeddingProvider } from "../services/llm-provider.js";
import type { VectorStore } from "../services/vector-store.js";
import type { JobQueue } from "../queue/types.js";
import type { JobProcessor } from "../queue/worker.js";

const CODE_COLLECTION = "ossgard-code";
const INTENT_COLLECTION = "ossgard-intent";
const BATCH_SIZE = 50;

export class EmbedProcessor implements JobProcessor {
  readonly type = "embed";

  constructor(
    private db: Database,
    private embeddingProvider: EmbeddingProvider,
    private vectorStore: VectorStore,
    private queue?: JobQueue
  ) {}

  async process(job: Job): Promise<void> {
    const { repoId, scanId, owner, repo } = job.payload as {
      repoId: number;
      scanId: number;
      owner: string;
      repo: string;
    };

    // Update scan status to "embedding"
    this.db.updateScanStatus(scanId, "embedding");

    const dimensions = this.embeddingProvider.dimensions;

    // Ensure collections exist
    await this.vectorStore.ensureCollection(CODE_COLLECTION, dimensions);
    await this.vectorStore.ensureCollection(
      INTENT_COLLECTION,
      dimensions
    );

    // Read all open PRs
    const prs = this.db.listOpenPRs(repoId);

    if (
      isBatchEmbeddingProvider(this.embeddingProvider) &&
      prs.length > 0
    ) {
      await this.processBatch(repoId, prs);
    } else {
      await this.processSequential(repoId, prs);
    }

    // Enqueue cluster job
    if (this.queue) {
      await this.queue.enqueue({
        type: "cluster",
        payload: { repoId, scanId, owner, repo },
      });
    }
  }

  private async processSequential(
    repoId: number,
    prs: Array<{ id: number; number: number; title: string; body: string | null; filePaths: string[] }>
  ): Promise<void> {
    for (let i = 0; i < prs.length; i += BATCH_SIZE) {
      const batch = prs.slice(i, i + BATCH_SIZE);

      const codeInputs = batch.map((pr) => pr.filePaths.join("\n"));
      const intentInputs = batch.map(
        (pr) =>
          pr.title + "\n" + (pr.body ?? "") + "\n" + pr.filePaths.join("\n")
      );

      const [codeEmbeddings, intentEmbeddings] = await Promise.all([
        this.embeddingProvider.embed(codeInputs),
        this.embeddingProvider.embed(intentInputs),
      ]);

      await this.upsertBatch(repoId, batch, codeEmbeddings, intentEmbeddings);
    }
  }

  private async processBatch(
    repoId: number,
    prs: Array<{ id: number; number: number; title: string; body: string | null; filePaths: string[] }>
  ): Promise<void> {
    const provider = this.embeddingProvider as import("../services/llm-provider.js").BatchEmbeddingProvider;

    // Collect all batch requests
    const requests: Array<{ id: string; texts: string[] }> = [];
    const batchMeta: Array<{
      batchIndex: number;
      type: "code" | "intent";
      prSlice: typeof prs;
    }> = [];

    for (let i = 0; i < prs.length; i += BATCH_SIZE) {
      const batch = prs.slice(i, i + BATCH_SIZE);
      const batchIdx = Math.floor(i / BATCH_SIZE);

      const codeInputs = batch.map((pr) => pr.filePaths.join("\n"));
      const intentInputs = batch.map(
        (pr) =>
          pr.title + "\n" + (pr.body ?? "") + "\n" + pr.filePaths.join("\n")
      );

      requests.push({ id: `code-${batchIdx}`, texts: codeInputs });
      batchMeta.push({ batchIndex: batchIdx, type: "code", prSlice: batch });

      requests.push({ id: `intent-${batchIdx}`, texts: intentInputs });
      batchMeta.push({ batchIndex: batchIdx, type: "intent", prSlice: batch });
    }

    const results = await provider.embedBatch(requests);

    // Map results by id
    const resultMap = new Map(results.map((r) => [r.id, r.embeddings]));

    // Upsert for each batch
    for (let i = 0; i < prs.length; i += BATCH_SIZE) {
      const batch = prs.slice(i, i + BATCH_SIZE);
      const batchIdx = Math.floor(i / BATCH_SIZE);

      const codeEmbeddings = resultMap.get(`code-${batchIdx}`)!;
      const intentEmbeddings = resultMap.get(`intent-${batchIdx}`)!;

      await this.upsertBatch(repoId, batch, codeEmbeddings, intentEmbeddings);
    }
  }

  private async upsertBatch(
    repoId: number,
    batch: Array<{ id: number; number: number }>,
    codeEmbeddings: number[][],
    intentEmbeddings: number[][]
  ): Promise<void> {
    await this.vectorStore.upsert(
      CODE_COLLECTION,
      batch.map((pr, idx) => ({
        id: `${repoId}-${pr.number}-code`,
        vector: codeEmbeddings[idx],
        payload: {
          repoId,
          prNumber: pr.number,
          prId: pr.id,
        },
      }))
    );

    await this.vectorStore.upsert(
      INTENT_COLLECTION,
      batch.map((pr, idx) => ({
        id: `${repoId}-${pr.number}-intent`,
        vector: intentEmbeddings[idx],
        payload: {
          repoId,
          prNumber: pr.number,
          prId: pr.id,
        },
      }))
    );
  }
}
