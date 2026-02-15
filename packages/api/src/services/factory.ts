import type { LLMProvider } from "./llm-provider.js";
import type { VectorStore } from "./vector-store.js";
import { OllamaProvider } from "./ollama-provider.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { GitHubClient } from "./github-client.js";
import { QdrantStore } from "./qdrant-store.js";

export interface ServiceConfig {
  github: { token: string };
  llm: { provider: string; model: string; apiKey: string };
  embedding: { model: string };
  ollamaUrl: string;
  qdrantUrl: string;
}

export class ServiceFactory {
  constructor(private config: ServiceConfig) {}

  /** Create the LLM provider for chat (Ollama or Anthropic based on config). */
  createLLMProvider(): LLMProvider {
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

  /** Create the embedding provider (always Ollama). */
  createEmbeddingProvider(): LLMProvider {
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
    const { QdrantClient } = await import("@qdrant/js-client-rest");
    const client = new QdrantClient({ url: this.config.qdrantUrl });
    return new QdrantStore(client as any);
  }
}
