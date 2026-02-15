import { describe, it, expect } from "vitest";
import { ServiceFactory, type ServiceConfig } from "./factory.js";

function makeConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    github: { token: "gh-test-token" },
    llm: { provider: "ollama", model: "llama3", apiKey: "" },
    embedding: { model: "nomic-embed-text" },
    ollamaUrl: "http://localhost:11434",
    qdrantUrl: "http://localhost:6333",
    ...overrides,
  };
}

describe("ServiceFactory", () => {
  describe("createLLMProvider", () => {
    it("returns OllamaProvider when provider is ollama", () => {
      const factory = new ServiceFactory(makeConfig({ llm: { provider: "ollama", model: "llama3", apiKey: "" } }));
      const llm = factory.createLLMProvider();
      expect(llm.constructor.name).toBe("OllamaProvider");
    });

    it("returns AnthropicProvider when provider is anthropic", () => {
      const factory = new ServiceFactory(
        makeConfig({ llm: { provider: "anthropic", model: "claude-sonnet-4-20250514", apiKey: "sk-test" } })
      );
      const llm = factory.createLLMProvider();
      expect(llm.constructor.name).toBe("AnthropicProvider");
    });

    it("defaults to OllamaProvider for unknown providers", () => {
      const factory = new ServiceFactory(
        makeConfig({ llm: { provider: "unknown", model: "model", apiKey: "" } })
      );
      const llm = factory.createLLMProvider();
      expect(llm.constructor.name).toBe("OllamaProvider");
    });
  });

  describe("createEmbeddingProvider", () => {
    it("always returns OllamaProvider", () => {
      const factory = new ServiceFactory(
        makeConfig({ llm: { provider: "anthropic", model: "claude-sonnet-4-20250514", apiKey: "sk-test" } })
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
