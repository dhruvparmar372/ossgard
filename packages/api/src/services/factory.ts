import type { EmbeddingProvider, ChatProvider } from "./llm-provider.js";
import type { VectorStore } from "./vector-store.js";
import { OllamaProvider } from "./ollama-provider.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { OpenAIEmbeddingProvider } from "./openai-embedding-provider.js";
import { GitHubClient } from "./github-client.js";
import { QdrantStore, type QdrantClient } from "./qdrant-store.js";

export interface ServiceConfig {
  github: { token: string };
  llm: { provider: string; model: string; apiKey: string };
  embedding: { provider: string; model: string; apiKey: string };
  ollamaUrl: string;
  qdrantUrl: string;
}

export class ServiceFactory {
  constructor(private config: ServiceConfig) {}

  /** Create the chat provider (Ollama or Anthropic based on config). */
  createLLMProvider(): ChatProvider {
    if (this.config.llm.provider === "anthropic") {
      return new AnthropicProvider({
        apiKey: this.config.llm.apiKey,
        model: this.config.llm.model,
      });
    }

    // Default to Ollama for chat
    return new OllamaProvider({
      baseUrl: this.config.ollamaUrl,
      embeddingModel: this.config.embedding.model,
      chatModel: this.config.llm.model,
    });
  }

  /** Create the embedding provider (Ollama or OpenAI based on config). */
  createEmbeddingProvider(): EmbeddingProvider {
    if (this.config.embedding.provider === "openai") {
      return new OpenAIEmbeddingProvider({
        apiKey: this.config.embedding.apiKey,
        model: this.config.embedding.model,
      });
    }

    // Default to Ollama for embeddings
    return new OllamaProvider({
      baseUrl: this.config.ollamaUrl,
      embeddingModel: this.config.embedding.model,
      chatModel: this.config.llm.model,
    });
  }

  /** Create a GitHub client with the configured token. */
  createGitHubClient(): GitHubClient {
    return new GitHubClient({ token: this.config.github.token });
  }

  /** Create a vector store backed by Qdrant. Uses dynamic import for the Qdrant client. */
  async createVectorStore(): Promise<VectorStore> {
    const { QdrantClient: RealQdrantClient } = await import("@qdrant/js-client-rest");
    const realClient = new RealQdrantClient({ url: this.config.qdrantUrl });

    // Adapt the real Qdrant client to our minimal QdrantClient interface
    const adapter: QdrantClient = {
      getCollections: () => realClient.getCollections(),
      createCollection: (name, opts) =>
        realClient.createCollection(name, opts) as Promise<void>,
      getCollection: (name) =>
        realClient.getCollection(name) as Promise<any>,
      deleteCollection: (name) =>
        realClient.deleteCollection(name) as Promise<void>,
      upsert: (collection, opts) =>
        realClient.upsert(collection, opts) as Promise<void>,
      search: (collection, opts) =>
        realClient.search(collection, opts) as Promise<any>,
      delete: (collection, opts) =>
        realClient.delete(collection, opts) as Promise<void>,
      retrieve: (collection, opts) =>
        realClient.retrieve(collection, opts) as Promise<any>,
    };

    return new QdrantStore(adapter);
  }
}
