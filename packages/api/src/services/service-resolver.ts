import type { Database } from "../db/database.js";
import type { GitHubClient } from "./github-client.js";
import type { ChatProvider } from "./llm-provider.js";
import type { EmbeddingProvider } from "./llm-provider.js";
import type { VectorStore } from "./vector-store.js";
import { ServiceFactory } from "./factory.js";

export interface ResolvedServices {
  github: GitHubClient;
  llm: ChatProvider;
  embedding: EmbeddingProvider;
  vectorStore: VectorStore;
  scanConfig: {
    codeSimilarityThreshold: number;
    intentSimilarityThreshold: number;
  };
}

export class ServiceResolver {
  constructor(private db: Database) {}

  async resolve(accountId: number): Promise<ResolvedServices> {
    const account = this.db.getAccount(accountId);
    if (!account) throw new Error(`Account not found: ${accountId}`);

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
        codeSimilarityThreshold: cfg.scan?.code_similarity_threshold ?? 0.85,
        intentSimilarityThreshold: cfg.scan?.intent_similarity_threshold ?? 0.80,
      },
    };
  }
}
