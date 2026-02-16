import { Config, type OssgardConfig } from "./config.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Config", () => {
  let tempDir: string;
  let config: Config;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ossgard-config-"));
    config = new Config(tempDir);
  });

  it("init writes url fields to config.toml", () => {
    config.init("ghp_test123");
    const raw = readFileSync(join(tempDir, "config.toml"), "utf-8");

    expect(raw).toContain("[llm]");
    expect(raw).toContain('url = "http://localhost:11434"');
    expect(raw).toContain("[embedding]");
    expect(raw).toContain("[vector_store]");
    expect(raw).toContain('url = "http://localhost:6333"');
  });

  it("load returns url defaults when config file doesn't exist", () => {
    const cfg = config.load();

    expect(cfg.llm.url).toBe("http://localhost:11434");
    expect(cfg.embedding.url).toBe("http://localhost:11434");
    expect(cfg.vector_store.url).toBe("http://localhost:6333");
  });

  it("get/set works with new url fields", () => {
    config.init("ghp_test");
    config.set("llm.url", "http://remote:11434");
    expect(config.get("llm.url")).toBe("http://remote:11434");

    config.set("vector_store.url", "https://cloud.qdrant.io:6333");
    expect(config.get("vector_store.url")).toBe("https://cloud.qdrant.io:6333");
  });

  it("vector_store.api_key defaults to empty string", () => {
    const cfg = config.load();
    expect(cfg.vector_store.api_key).toBe("");
  });

  it("get/set works with vector_store.api_key", () => {
    config.init("ghp_test");
    config.set("vector_store.api_key", "qdrant-cloud-key-123");
    expect(config.get("vector_store.api_key")).toBe("qdrant-cloud-key-123");
  });

  describe("isComplete", () => {
    it("returns false when config file doesn't exist", () => {
      expect(config.isComplete()).toBe(false);
    });

    it("returns false when github.token is empty", () => {
      config.init("");
      expect(config.isComplete()).toBe(false);
    });

    it("returns false when llm.provider is empty", () => {
      config.init("ghp_test");
      config.set("llm.provider", "");
      expect(config.isComplete()).toBe(false);
    });

    it("returns false when embedding.provider is empty", () => {
      config.init("ghp_test");
      config.set("embedding.provider", "");
      expect(config.isComplete()).toBe(false);
    });

    it("returns false when vector_store.url is empty", () => {
      config.init("ghp_test");
      config.set("vector_store.url", "");
      expect(config.isComplete()).toBe(false);
    });

    it("returns false when api.url is empty", () => {
      config.init("ghp_test");
      config.set("api.url", "");
      expect(config.isComplete()).toBe(false);
    });

    it("returns true when all required fields are populated", () => {
      config.init("ghp_test");
      expect(config.isComplete()).toBe(true);
    });
  });

  describe("save", () => {
    it("writes config that can be loaded back with matching values", () => {
      const input: OssgardConfig = {
        api: { url: "http://myapi:3400" },
        github: { token: "ghp_saved" },
        llm: {
          provider: "anthropic",
          url: "",
          model: "claude-sonnet-4-20250514",
          api_key: "sk-ant-key",
        },
        embedding: {
          provider: "openai",
          url: "",
          model: "text-embedding-3-small",
          api_key: "sk-openai-key",
        },
        vector_store: {
          url: "https://cloud.qdrant.io:6333",
          api_key: "qdrant-key",
        },
        scan: {
          concurrency: 5,
          code_similarity_threshold: 0.9,
          intent_similarity_threshold: 0.75,
        },
      };

      config.save(input);
      const loaded = config.load();

      expect(loaded.api.url).toBe(input.api.url);
      expect(loaded.github.token).toBe(input.github.token);
      expect(loaded.llm.provider).toBe(input.llm.provider);
      expect(loaded.llm.model).toBe(input.llm.model);
      expect(loaded.llm.api_key).toBe(input.llm.api_key);
      expect(loaded.embedding.provider).toBe(input.embedding.provider);
      expect(loaded.embedding.model).toBe(input.embedding.model);
      expect(loaded.vector_store.url).toBe(input.vector_store.url);
      expect(loaded.vector_store.api_key).toBe(input.vector_store.api_key);
      expect(loaded.scan.concurrency).toBe(input.scan.concurrency);
    });

    it("creates config directory if it doesn't exist", () => {
      const nested = join(tempDir, "nested", "deep");
      const nestedConfig = new Config(nested);

      const input: OssgardConfig = {
        api: { url: "http://localhost:3400" },
        github: { token: "ghp_test" },
        llm: { provider: "ollama", url: "http://localhost:11434", model: "llama3", api_key: "" },
        embedding: { provider: "ollama", url: "http://localhost:11434", model: "nomic-embed-text", api_key: "" },
        vector_store: { url: "http://localhost:6333", api_key: "" },
        scan: { concurrency: 10, code_similarity_threshold: 0.85, intent_similarity_threshold: 0.80 },
      };

      nestedConfig.save(input);
      expect(nestedConfig.exists()).toBe(true);
      expect(nestedConfig.load().github.token).toBe("ghp_test");
    });
  });
});
