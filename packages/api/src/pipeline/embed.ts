import type { Job } from "@ossgard/shared";
import type { Database } from "../db/database.js";
import type { EmbeddingProvider } from "../services/llm-provider.js";
import { isBatchEmbeddingProvider } from "../services/llm-provider.js";
import type { VectorStore } from "../services/vector-store.js";
import type { ServiceResolver } from "../services/service-resolver.js";
import type { JobQueue } from "../queue/types.js";
import type { JobProcessor } from "../queue/worker.js";
import { log } from "../logger.js";

const CODE_COLLECTION = "ossgard-code";
const INTENT_COLLECTION = "ossgard-intent";
const BATCH_SIZE = 50;

const embedLog = log.child("embed");

export class EmbedProcessor implements JobProcessor {
  readonly type = "embed";

  constructor(
    private db: Database,
    private resolver: ServiceResolver,
    private queue?: JobQueue
  ) {}

  async process(job: Job): Promise<void> {
    const { repoId, scanId, accountId, owner, repo } = job.payload as {
      repoId: number;
      scanId: number;
      accountId: number;
      owner: string;
      repo: string;
    };

    // Update scan status to "embedding"
    this.db.updateScanStatus(scanId, "embedding");

    // Resolve services from account config
    const { embedding: embeddingProvider, vectorStore } = await this.resolver.resolve(accountId);

    const dimensions = embeddingProvider.dimensions;

    // Ensure collections exist
    await vectorStore.ensureCollection(CODE_COLLECTION, dimensions);
    await vectorStore.ensureCollection(INTENT_COLLECTION, dimensions);

    // Read all open PRs
    const prs = this.db.listOpenPRs(repoId);

    const useBatch = isBatchEmbeddingProvider(embeddingProvider) && prs.length > 0;
    embedLog.info("Embed started", { scanId, prCount: prs.length, mode: useBatch ? "batch" : "sequential" });

    if (useBatch) {
      await this.processBatch(repoId, prs, embeddingProvider, vectorStore);
    } else {
      await this.processSequential(repoId, prs, embeddingProvider, vectorStore);
    }

    // Enqueue cluster job
    if (this.queue) {
      await this.queue.enqueue({
        type: "cluster",
        payload: { repoId, scanId, accountId, owner, repo },
      });
      embedLog.info("Enqueued cluster", { scanId });
    }
  }

  private async processSequential(
    repoId: number,
    prs: Array<{ id: number; number: number; title: string; body: string | null; filePaths: string[] }>,
    embeddingProvider: EmbeddingProvider,
    vectorStore: VectorStore
  ): Promise<void> {
    const totalBatches = Math.ceil(prs.length / BATCH_SIZE);
    for (let i = 0; i < prs.length; i += BATCH_SIZE) {
      const batch = prs.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const batchStart = Date.now();

      embedLog.info("Embedding batch", {
        batch: `${batchNum}/${totalBatches}`,
        prs: batch.length,
        prRange: `#${batch[0].number}..#${batch[batch.length - 1].number}`,
      });

      const codeInputs = batch.map((pr) => pr.filePaths.join("\n"));
      const intentInputs = batch.map(
        (pr) =>
          pr.title + "\n" + (pr.body ?? "") + "\n" + pr.filePaths.join("\n")
      );

      const [codeEmbeddings, intentEmbeddings] = await Promise.all([
        embeddingProvider.embed(codeInputs),
        embeddingProvider.embed(intentInputs),
      ]);

      await this.upsertBatch(repoId, batch, codeEmbeddings, intentEmbeddings, vectorStore);

      embedLog.info("Batch embedded", {
        batch: `${batchNum}/${totalBatches}`,
        durationMs: Date.now() - batchStart,
        progress: `${Math.min(i + BATCH_SIZE, prs.length)}/${prs.length}`,
      });
    }
  }

  private async processBatch(
    repoId: number,
    prs: Array<{ id: number; number: number; title: string; body: string | null; filePaths: string[] }>,
    embeddingProvider: EmbeddingProvider,
    vectorStore: VectorStore
  ): Promise<void> {
    const provider = embeddingProvider as import("../services/llm-provider.js").BatchEmbeddingProvider;

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

    embedLog.info("Sending batch embedding request", { requests: requests.length });
    const batchStart = Date.now();
    const results = await provider.embedBatch(requests);
    embedLog.info("Batch embedding complete", { durationMs: Date.now() - batchStart });

    // Map results by id
    const resultMap = new Map(results.map((r) => [r.id, r.embeddings]));

    // Upsert for each batch
    const totalBatches = Math.ceil(prs.length / BATCH_SIZE);
    for (let i = 0; i < prs.length; i += BATCH_SIZE) {
      const batch = prs.slice(i, i + BATCH_SIZE);
      const batchIdx = Math.floor(i / BATCH_SIZE);

      const codeEmbeddings = resultMap.get(`code-${batchIdx}`)!;
      const intentEmbeddings = resultMap.get(`intent-${batchIdx}`)!;

      await this.upsertBatch(repoId, batch, codeEmbeddings, intentEmbeddings, vectorStore);
      embedLog.info("Batch upserted to vector store", {
        batch: `${batchIdx + 1}/${totalBatches}`,
        progress: `${Math.min(i + BATCH_SIZE, prs.length)}/${prs.length}`,
      });
    }
  }

  private async upsertBatch(
    repoId: number,
    batch: Array<{ id: number; number: number }>,
    codeEmbeddings: number[][],
    intentEmbeddings: number[][],
    vectorStore: VectorStore
  ): Promise<void> {
    await vectorStore.upsert(
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

    await vectorStore.upsert(
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
