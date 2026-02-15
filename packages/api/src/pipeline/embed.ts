import type { Job } from "@ossgard/shared";
import type { Database } from "../db/database.js";
import type { LLMProvider } from "../services/llm-provider.js";
import type { VectorStore } from "../services/vector-store.js";
import type { JobQueue } from "../queue/types.js";
import type { JobProcessor } from "../queue/worker.js";

const CODE_COLLECTION = "ossgard-code";
const INTENT_COLLECTION = "ossgard-intent";
const VECTOR_DIMENSIONS = 768;
const BATCH_SIZE = 50;

export class EmbedProcessor implements JobProcessor {
  readonly type = "embed";

  constructor(
    private db: Database,
    private llm: LLMProvider,
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

    // Ensure collections exist
    await this.vectorStore.ensureCollection(CODE_COLLECTION, VECTOR_DIMENSIONS);
    await this.vectorStore.ensureCollection(
      INTENT_COLLECTION,
      VECTOR_DIMENSIONS
    );

    // Read all open PRs
    const prs = this.db.listOpenPRs(repoId);

    // Process in batches of 50
    for (let i = 0; i < prs.length; i += BATCH_SIZE) {
      const batch = prs.slice(i, i + BATCH_SIZE);

      // Build code inputs
      const codeInputs = batch.map(
        (pr) => pr.filePaths.join("\n") + "\n" + (pr.diffHash ?? "")
      );

      // Build intent inputs
      const intentInputs = batch.map(
        (pr) =>
          pr.title +
          "\n" +
          (pr.body ?? "") +
          "\n" +
          pr.filePaths.join("\n")
      );

      // Generate embeddings
      const [codeEmbeddings, intentEmbeddings] = await Promise.all([
        this.llm.embed(codeInputs),
        this.llm.embed(intentInputs),
      ]);

      // Upsert code vectors
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

      // Upsert intent vectors
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

    // Enqueue cluster job
    if (this.queue) {
      await this.queue.enqueue({
        type: "cluster",
        payload: { repoId, scanId, owner, repo },
      });
    }
  }
}
