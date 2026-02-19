import type { Database } from "../db/database.js";
import type { GitHubClient } from "./github-client.js";
import type { ChatProvider } from "./llm-provider.js";
import type { EmbeddingProvider } from "./llm-provider.js";
import type { VectorStore } from "./vector-store.js";
import { ServiceFactory } from "./factory.js";
import { log } from "../logger.js";

export interface ResolvedServices {
  github: GitHubClient;
  llm: ChatProvider;
  embedding: EmbeddingProvider;
  vectorStore: VectorStore;
  scanConfig: {
    candidateThreshold: number;
    maxCandidatesPerPr: number;
  };
}

export class ServiceResolver {
  constructor(private db: Database) {}

  private resolverLog = log.child("resolver");

  async resolve(accountId: number): Promise<ResolvedServices> {
    const account = this.db.getAccount(accountId);
    if (!account) throw new Error(`Account not found: ${accountId}`);

    this.resolverLog.debug("Resolving services", { accountId });

    const cfg = account.config;
    const factory = new ServiceFactory({
      github: { token: cfg.github.token },
      llm: {
        provider: cfg.llm.provider,
        url: cfg.llm.url,
        model: cfg.llm.model,
        apiKey: cfg.llm.api_key,
        batch: cfg.llm.batch,
      },
      embedding: {
        provider: cfg.embedding.provider,
        url: cfg.embedding.url,
        model: cfg.embedding.model,
        apiKey: cfg.embedding.api_key,
        batch: cfg.embedding.batch,
      },
      vectorStoreUrl: cfg.vector_store.url,
      vectorStoreApiKey: cfg.vector_store.api_key,
    });

    return {
      github: factory.createGitHubClient(),
      llm: factory.createLLMProvider(),
      embedding: factory.createEmbeddingProvider(),
      vectorStore: await factory.createVectorStore(),
      scanConfig: {
        candidateThreshold: cfg.scan?.candidate_threshold ?? 0.65,
        maxCandidatesPerPr: cfg.scan?.max_candidates_per_pr ?? 5,
      },
    };
  }
}
