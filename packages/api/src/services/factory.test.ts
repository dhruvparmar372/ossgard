import { ServiceFactory, type ServiceConfig } from "./factory.js";

function makeConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    github: { token: "gh-test-token" },
    llm: { provider: "ollama", url: "http://localhost:11434", model: "llama3", apiKey: "" },
    embedding: { provider: "ollama", url: "http://localhost:11434", model: "nomic-embed-text", apiKey: "" },
    vectorStoreUrl: "http://localhost:6333",
    ...overrides,
  };
}

describe("ServiceFactory", () => {
  describe("createLLMProvider", () => {
    it("returns OllamaProvider when provider is ollama", () => {
      const factory = new ServiceFactory(makeConfig({ llm: { provider: "ollama", url: "http://localhost:11434", model: "llama3", apiKey: "" } }));
      const llm = factory.createLLMProvider();
      expect(llm.constructor.name).toBe("OllamaProvider");
    });

    it("returns AnthropicProvider when provider is anthropic", () => {
      const factory = new ServiceFactory(
        makeConfig({ llm: { provider: "anthropic", url: "http://localhost:11434", model: "claude-sonnet-4-20250514", apiKey: "sk-test" } })
      );
      const llm = factory.createLLMProvider();
      expect(llm.constructor.name).toBe("AnthropicProvider");
    });

    it("defaults to OllamaProvider for unknown providers", () => {
      const factory = new ServiceFactory(
        makeConfig({ llm: { provider: "unknown", url: "http://localhost:11434", model: "model", apiKey: "" } })
      );
      const llm = factory.createLLMProvider();
      expect(llm.constructor.name).toBe("OllamaProvider");
    });

    it("returns AnthropicBatchProvider when provider is anthropic with batch=true", () => {
      const factory = new ServiceFactory(
        makeConfig({ llm: { provider: "anthropic", url: "http://localhost:11434", model: "claude-sonnet-4-20250514", apiKey: "sk-test", batch: true } })
      );
      const llm = factory.createLLMProvider();
      expect(llm.constructor.name).toBe("AnthropicBatchProvider");
    });

    it("ignores batch flag for Ollama (no batch API)", () => {
      const factory = new ServiceFactory(
        makeConfig({ llm: { provider: "ollama", url: "http://localhost:11434", model: "llama3", apiKey: "", batch: true } })
      );
      const llm = factory.createLLMProvider();
      expect(llm.constructor.name).toBe("OllamaProvider");
    });

    it("returns OpenAIChatProvider when provider is openai", () => {
      const factory = new ServiceFactory(
        makeConfig({ llm: { provider: "openai", url: "", model: "gpt-4o-mini", apiKey: "sk-test" } })
      );
      const llm = factory.createLLMProvider();
      expect(llm.constructor.name).toBe("OpenAIChatProvider");
    });

    it("returns OpenAIBatchChatProvider when provider is openai with batch=true", () => {
      const factory = new ServiceFactory(
        makeConfig({ llm: { provider: "openai", url: "", model: "gpt-4o-mini", apiKey: "sk-test", batch: true } })
      );
      const llm = factory.createLLMProvider();
      expect(llm.constructor.name).toBe("OpenAIBatchChatProvider");
    });
  });

  describe("createEmbeddingProvider", () => {
    it("returns OllamaProvider when embedding provider is ollama", () => {
      const factory = new ServiceFactory(makeConfig());
      const embedding = factory.createEmbeddingProvider();
      expect(embedding.constructor.name).toBe("OllamaProvider");
    });

    it("returns OpenAIEmbeddingProvider when embedding provider is openai", () => {
      const factory = new ServiceFactory(
        makeConfig({
          embedding: { provider: "openai", url: "http://localhost:11434", model: "text-embedding-3-large", apiKey: "sk-test" },
        })
      );
      const embedding = factory.createEmbeddingProvider();
      expect(embedding.constructor.name).toBe("OpenAIEmbeddingProvider");
    });

    it("defaults to OllamaProvider for unknown embedding providers", () => {
      const factory = new ServiceFactory(
        makeConfig({
          embedding: { provider: "unknown", url: "http://localhost:11434", model: "some-model", apiKey: "" },
        })
      );
      const embedding = factory.createEmbeddingProvider();
      expect(embedding.constructor.name).toBe("OllamaProvider");
    });

    it("returns OpenAIBatchEmbeddingProvider when provider is openai with batch=true", () => {
      const factory = new ServiceFactory(
        makeConfig({
          embedding: { provider: "openai", url: "http://localhost:11434", model: "text-embedding-3-large", apiKey: "sk-test", batch: true },
        })
      );
      const embedding = factory.createEmbeddingProvider();
      expect(embedding.constructor.name).toBe("OpenAIBatchEmbeddingProvider");
    });

    it("ignores batch flag for Ollama embeddings (no batch API)", () => {
      const factory = new ServiceFactory(
        makeConfig({
          embedding: { provider: "ollama", url: "http://localhost:11434", model: "nomic-embed-text", apiKey: "", batch: true },
        })
      );
      const embedding = factory.createEmbeddingProvider();
      expect(embedding.constructor.name).toBe("OllamaProvider");
    });
  });

  describe("createGitHubClient", () => {
    it("returns a GitHubClient with the configured token", () => {
      const factory = new ServiceFactory(makeConfig());
      const client = factory.createGitHubClient();
      expect(client.constructor.name).toBe("GitHubClient");
    });
  });

  // Note: createVectorStore is not tested here because it requires
  // the actual @qdrant/js-client-rest library to connect to a Qdrant instance.
});
