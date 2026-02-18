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

export const CODE_COLLECTION = "ossgard-code";
export const INTENT_COLLECTION = "ossgard-intent";
const BATCH_SIZE = 50;

/**
 * Stay under OpenAI's org-level enqueued token limit (3M for text-embedding-3-small).
 * We use 2.8M as buffer. When total tokens exceed this, the batch is split into
 * sequential chunks — each chunk completes before the next starts, freeing tokens.
 */
export const MAX_ENQUEUED_TOKENS = 2_800_000;

const embedLog = log.child("embed");

/** Compute a stable hash for a PR's embedding-relevant fields. */
export function computeEmbedHash(pr: Pick<PR, "diffHash" | "title" | "body" | "filePaths">): string {
  const input = `${pr.diffHash ?? ""}|${pr.title}|${pr.body ?? ""}|${JSON.stringify(pr.filePaths)}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/** Options for the standalone runEmbed function. */
export interface RunEmbedOpts {
  prs: PR[];
  scanId: number;
  repoId: number;
  accountId: number;
  resolver: ServiceResolver;
  db: Database;
}

/**
 * Standalone embed logic: resolve provider, build inputs, embed, upsert vectors.
 * Does NOT update scan status or enqueue jobs — the caller handles that.
 */
export async function runEmbed(opts: RunEmbedOpts): Promise<void> {
  const { scanId, repoId, accountId, resolver, db } = opts;

  // Resolve services from account config
  const { embedding: embeddingProvider, vectorStore } = await resolver.resolve(accountId);

  const dimensions = embeddingProvider.dimensions;

  // Ensure collections exist
  await vectorStore.ensureCollection(CODE_COLLECTION, dimensions);
  await vectorStore.ensureCollection(INTENT_COLLECTION, dimensions);

  // Read all open PRs and filter out already-embedded
  const allPrs = db.listOpenPRs(repoId);
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
  const scan = db.getScan(scanId);
  const existingBatchId = (scan?.phaseCursor as Record<string, unknown> | null)?.embedBatchId as string | undefined;

  if (useBatch) {
    try {
      await processBatch(db, repoId, scanId, prs, embeddingProvider, vectorStore, existingBatchId);
    } catch (err) {
      // Clear phaseCursor so next retry creates a fresh batch instead of resuming a failed one
      db.updateScanStatus(scanId, "embedding", { phaseCursor: null });
      throw err;
    }
  } else {
    await processSequential(db, repoId, prs, embeddingProvider, vectorStore);
  }

  // Clear phaseCursor after successful completion
  db.updateScanStatus(scanId, "embedding", { phaseCursor: null });
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

    // Delegate to standalone runEmbed
    await runEmbed({
      prs: [], // prs are loaded from DB inside runEmbed
      scanId,
      repoId,
      accountId,
      resolver: this.resolver,
      db: this.db,
    });

    // Enqueue cluster job
    if (this.queue) {
      await this.queue.enqueue({
        type: "cluster",
        payload: { repoId, scanId, accountId, owner, repo },
      });
      embedLog.info("Enqueued cluster", { scanId });
    }
  }
}

async function processSequential(
  db: Database,
  repoId: number,
  prs: Array<{ id: number; number: number; title: string; body: string | null; filePaths: string[]; diffHash: string | null }>,
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

    await upsertBatch(repoId, batch, codeEmbeddings, intentEmbeddings, vectorStore);

    // Stamp embed_hash per batch for resume support
    for (const pr of batch) {
      db.updatePREmbedHash(pr.id, computeEmbedHash(pr));
    }

    embedLog.info("Batch embedded", {
      batch: `${batchNum}/${totalBatches}`,
      durationMs: Date.now() - batchStart,
      progress: `${Math.min(i + BATCH_SIZE, prs.length)}/${prs.length}`,
    });
  }
}

async function processBatch(
  db: Database,
  repoId: number,
  scanId: number,
  prs: Array<{ id: number; number: number; title: string; body: string | null; filePaths: string[]; diffHash: string | null }>,
  embeddingProvider: EmbeddingProvider,
  vectorStore: VectorStore,
  existingBatchId?: string
): Promise<void> {
  const provider = embeddingProvider as import("../services/llm-provider.js").BatchEmbeddingProvider;
  const countTokens = provider.countTokens.bind(provider);
  const tokenBudget = Math.floor(provider.maxInputTokens * TOKEN_BUDGET_FACTOR);

  // Build all requests and track tokens per PR-batch group
  const groups: Array<{
    batchIdx: number;
    prSlice: typeof prs;
    codeRequest: { id: string; texts: string[] };
    intentRequest: { id: string; texts: string[] };
    tokenCount: number;
  }> = [];

  for (let i = 0; i < prs.length; i += BATCH_SIZE) {
    const batch = prs.slice(i, i + BATCH_SIZE);
    const batchIdx = Math.floor(i / BATCH_SIZE);

    const codeInputs = batch.map((pr) => buildCodeInput(pr.filePaths, tokenBudget, countTokens, pr.title));
    const intentInputs = batch.map((pr) =>
      buildIntentInput(pr.title, pr.body, pr.filePaths, tokenBudget, countTokens)
    );

    let tokenCount = 0;
    for (const text of codeInputs) tokenCount += countTokens(text);
    for (const text of intentInputs) tokenCount += countTokens(text);

    groups.push({
      batchIdx,
      prSlice: batch,
      codeRequest: { id: `code-${batchIdx}`, texts: codeInputs },
      intentRequest: { id: `intent-${batchIdx}`, texts: intentInputs },
      tokenCount,
    });
  }

  // Chunk groups to stay under org-level enqueued token limit.
  // Each chunk is submitted as a separate batch API call; the previous
  // chunk completes before the next starts, freeing tokens.
  const chunks: (typeof groups)[] = [];
  let currentChunk: typeof groups = [];
  let currentTokens = 0;

  for (const group of groups) {
    if (currentChunk.length > 0 && currentTokens + group.tokenCount > MAX_ENQUEUED_TOKENS) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }
    currentChunk.push(group);
    currentTokens += group.tokenCount;
  }
  if (currentChunk.length > 0) chunks.push(currentChunk);

  const totalTokens = groups.reduce((sum, g) => sum + g.tokenCount, 0);
  embedLog.info("Batch token analysis", {
    scanId,
    totalTokens,
    chunks: chunks.length,
    tokenLimit: MAX_ENQUEUED_TOKENS,
    groups: groups.length,
  });

  // Process each chunk as a separate batch API call
  let processedPrs = 0;
  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    const chunk = chunks[chunkIdx];
    const chunkRequests = chunk.flatMap((g) => [g.codeRequest, g.intentRequest]);
    const chunkTokens = chunk.reduce((sum, g) => sum + g.tokenCount, 0);
    const chunkPrCount = chunk.reduce((sum, g) => sum + g.prSlice.length, 0);

    embedLog.info("Processing batch chunk", {
      scanId,
      chunk: `${chunkIdx + 1}/${chunks.length}`,
      requests: chunkRequests.length,
      tokens: chunkTokens,
      prs: chunkPrCount,
    });

    // Resume support: only use existingBatchId for first chunk
    const useExistingBatchId = chunkIdx === 0 ? existingBatchId : undefined;

    const chunkStart = Date.now();
    const results = await provider.embedBatch(chunkRequests, {
      existingBatchId: useExistingBatchId,
      onBatchCreated: (batchId) => {
        db.updateScanStatus(scanId, "embedding", {
          phaseCursor: { embedBatchId: batchId },
        });
      },
    });

    embedLog.info("Batch chunk complete", {
      scanId,
      chunk: `${chunkIdx + 1}/${chunks.length}`,
      durationMs: Date.now() - chunkStart,
    });

    // Map results and upsert
    const resultMap = new Map(results.map((r) => [r.id, r.embeddings]));

    for (const group of chunk) {
      const codeEmbeddings = resultMap.get(group.codeRequest.id)!;
      const intentEmbeddings = resultMap.get(group.intentRequest.id)!;
      await upsertBatch(repoId, group.prSlice, codeEmbeddings, intentEmbeddings, vectorStore);
    }

    // Stamp embed_hash per chunk for resume support
    for (const group of chunk) {
      for (const pr of group.prSlice) {
        db.updatePREmbedHash(pr.id, computeEmbedHash(pr));
      }
    }

    processedPrs += chunkPrCount;
    embedLog.info("Batch chunk upserted", {
      scanId,
      chunk: `${chunkIdx + 1}/${chunks.length}`,
      progress: `${processedPrs}/${prs.length}`,
    });
  }
}

async function upsertBatch(
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

/** Join file paths up to the token budget, truncating at path boundaries. */
export function buildCodeInput(
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
export function buildIntentInput(
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
