import type { Job, PR } from "@ossgard/shared";
import type { Database } from "../db/database.js";
import type { EmbeddingProvider } from "../services/llm-provider.js";
import { isBatchEmbeddingProvider } from "../services/llm-provider.js";
import type { VectorStore } from "../services/vector-store.js";
import type { ServiceResolver } from "../services/service-resolver.js";
import type { JobQueue } from "../queue/types.js";
import type { JobProcessor } from "../queue/worker.js";
import { TOKEN_BUDGET_FACTOR } from "../services/token-counting.js";
import { log } from "../logger.js";
import { createHash } from "crypto";

const CODE_COLLECTION = "ossgard-code";
const INTENT_COLLECTION = "ossgard-intent";
const BATCH_SIZE = 50;

const embedLog = log.child("embed");

/** Compute a stable hash for a PR's embedding-relevant fields. */
export function computeEmbedHash(pr: Pick<PR, "diffHash" | "title" | "body" | "filePaths">): string {
  const input = `${pr.diffHash ?? ""}|${pr.title}|${pr.body ?? ""}|${JSON.stringify(pr.filePaths)}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

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

    // Read all open PRs and filter out already-embedded
    const allPrs = this.db.listOpenPRs(repoId);
    const prs = allPrs.filter((pr) => {
      const hash = computeEmbedHash(pr);
      return pr.embedHash !== hash;
    });

    const skipped = allPrs.length - prs.length;
    if (skipped > 0) {
      embedLog.info("Skipping already-embedded PRs", { skipped, total: allPrs.length });
    }

    const useBatch = isBatchEmbeddingProvider(embeddingProvider) && prs.length > 0;
    embedLog.info("Embed started", { scanId, prCount: prs.length, mode: useBatch ? "batch" : "sequential" });

    // Check for existing batch ID from phaseCursor (resume support)
    const scan = this.db.getScan(scanId);
    const existingBatchId = (scan?.phaseCursor as Record<string, unknown> | null)?.embedBatchId as string | undefined;

    if (useBatch) {
      try {
        await this.processBatch(repoId, scanId, prs, embeddingProvider, vectorStore, existingBatchId);
      } catch (err) {
        // Clear phaseCursor so next retry creates a fresh batch instead of resuming a failed one
        this.db.updateScanStatus(scanId, "embedding", { phaseCursor: null });
        throw err;
      }
    } else {
      await this.processSequential(repoId, prs, embeddingProvider, vectorStore);
    }

    // Stamp embed_hash on all successfully embedded PRs
    for (const pr of prs) {
      this.db.updatePREmbedHash(pr.id, computeEmbedHash(pr));
    }

    // Clear phaseCursor after successful completion
    this.db.updateScanStatus(scanId, "embedding", { phaseCursor: null });

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

      const tokenBudget = Math.floor(embeddingProvider.maxInputTokens * TOKEN_BUDGET_FACTOR);
      const countTokens = embeddingProvider.countTokens.bind(embeddingProvider);

      const codeInputs = batch.map((pr) => buildCodeInput(pr.filePaths, tokenBudget, countTokens, pr.title));
      const intentInputs = batch.map((pr) =>
        buildIntentInput(pr.title, pr.body, pr.filePaths, tokenBudget, countTokens)
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
    scanId: number,
    prs: Array<{ id: number; number: number; title: string; body: string | null; filePaths: string[] }>,
    embeddingProvider: EmbeddingProvider,
    vectorStore: VectorStore,
    existingBatchId?: string
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

      const tokenBudget = Math.floor(provider.maxInputTokens * TOKEN_BUDGET_FACTOR);
      const countTokens = provider.countTokens.bind(provider);

      const codeInputs = batch.map((pr) => buildCodeInput(pr.filePaths, tokenBudget, countTokens, pr.title));
      const intentInputs = batch.map((pr) =>
        buildIntentInput(pr.title, pr.body, pr.filePaths, tokenBudget, countTokens)
      );

      requests.push({ id: `code-${batchIdx}`, texts: codeInputs });
      batchMeta.push({ batchIndex: batchIdx, type: "code", prSlice: batch });

      requests.push({ id: `intent-${batchIdx}`, texts: intentInputs });
      batchMeta.push({ batchIndex: batchIdx, type: "intent", prSlice: batch });
    }

    embedLog.info("Sending batch embedding request", { requests: requests.length });
    const batchStart = Date.now();
    const results = await provider.embedBatch(requests, {
      existingBatchId,
      onBatchCreated: (batchId) => {
        this.db.updateScanStatus(scanId, "embedding", {
          phaseCursor: { embedBatchId: batchId },
        });
      },
    });
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

/** Join file paths up to the token budget, truncating at path boundaries. */
function buildCodeInput(
  filePaths: string[],
  tokenBudget: number,
  countTokens: (text: string) => number,
  fallbackTitle: string
): string {
  const result = joinWithinTokenBudget(filePaths, tokenBudget, countTokens);
  return result || fallbackTitle || "(no files)";
}

/**
 * Build intent embedding input with prioritized content:
 * title + body are always included (highest semantic signal), then
 * file paths fill remaining budget.
 */
function buildIntentInput(
  title: string,
  body: string | null,
  filePaths: string[],
  tokenBudget: number,
  countTokens: (text: string) => number
): string {
  const header = title + "\n" + (body ?? "");
  const headerTokens = countTokens(header);
  if (headerTokens >= tokenBudget) {
    // Truncate header by characters as a fallback — we can't split mid-token
    // Use a rough ratio: (budget / headerTokens) * header.length
    const charLimit = Math.floor((tokenBudget / headerTokens) * header.length);
    return header.slice(0, charLimit);
  }
  const remaining = tokenBudget - headerTokens - 1; // -1 for newline separator token
  const pathsPart = joinWithinTokenBudget(filePaths, remaining, countTokens);
  return pathsPart ? header + "\n" + pathsPart : header;
}

/** Join strings with newlines until the token budget is exhausted. */
function joinWithinTokenBudget(
  items: string[],
  budget: number,
  countTokens: (text: string) => number
): string {
  const parts: string[] = [];
  let usedTokens = 0;
  for (const item of items) {
    const itemTokens = countTokens(item) + (parts.length > 0 ? 1 : 0); // +1 for newline
    if (usedTokens + itemTokens > budget) break;
    parts.push(item);
    usedTokens += itemTokens;
  }
  return parts.join("\n");
}
