import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Config } from "../src/config.js";

describe("Config", () => {
  let tempDir: string;
  let config: Config;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ossgard-test-"));
    config = new Config(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("exists()", () => {
    it("returns false when config file does not exist", () => {
      expect(config.exists()).toBe(false);
    });

    it("returns true after init", () => {
      config.init("ghp_test123");
      expect(config.exists()).toBe(true);
    });
  });

  describe("init()", () => {
    it("creates config file with github token", () => {
      config.init("ghp_test123");
      const loaded = config.load();
      expect(loaded.github.token).toBe("ghp_test123");
    });

    it("creates config file with default values", () => {
      config.init("ghp_test123");
      const loaded = config.load();
      expect(loaded.llm.provider).toBe("ollama");
      expect(loaded.llm.model).toBe("llama3");
      expect(loaded.llm.api_key).toBe("");
      expect(loaded.embedding.model).toBe("nomic-embed-text");
      expect(loaded.scan.concurrency).toBe(10);
      expect(loaded.scan.code_similarity_threshold).toBe(0.85);
      expect(loaded.scan.intent_similarity_threshold).toBe(0.80);
    });

    it("writes a valid TOML file", () => {
      config.init("ghp_abc");
      const raw = readFileSync(join(tempDir, "config.toml"), "utf-8");
      expect(raw).toContain("[github]");
      expect(raw).toContain('token = "ghp_abc"');
      expect(raw).toContain("[llm]");
      expect(raw).toContain("[scan]");
    });
  });

  describe("load()", () => {
    it("returns defaults when config file does not exist", () => {
      const loaded = config.load();
      expect(loaded.github.token).toBe("");
      expect(loaded.llm.provider).toBe("ollama");
      expect(loaded.scan.concurrency).toBe(10);
    });

    it("returns saved config when file exists", () => {
      config.init("ghp_saved");
      const loaded = config.load();
      expect(loaded.github.token).toBe("ghp_saved");
    });
  });

  describe("get()", () => {
    it("gets top-level section", () => {
      config.init("ghp_get");
      const github = config.get("github") as { token: string };
      expect(github.token).toBe("ghp_get");
    });

    it("gets nested value with dot notation", () => {
      config.init("ghp_dot");
      expect(config.get("llm.provider")).toBe("ollama");
      expect(config.get("scan.concurrency")).toBe(10);
      expect(config.get("github.token")).toBe("ghp_dot");
    });

    it("returns undefined for non-existent key", () => {
      config.init("ghp_none");
      expect(config.get("nonexistent")).toBeUndefined();
      expect(config.get("llm.nonexistent")).toBeUndefined();
    });

    it("returns defaults when no config file exists", () => {
      expect(config.get("llm.provider")).toBe("ollama");
    });
  });

  describe("set()", () => {
    it("sets a string value", () => {
      config.init("ghp_set");
      config.set("github.token", "ghp_new");
      expect(config.get("github.token")).toBe("ghp_new");
    });

    it("sets a value on a provider", () => {
      config.init("ghp_set");
      config.set("llm.provider", "anthropic");
      expect(config.get("llm.provider")).toBe("anthropic");
    });

    it("preserves number types for existing numeric values", () => {
      config.init("ghp_num");
      config.set("scan.concurrency", "20");
      expect(config.get("scan.concurrency")).toBe(20);
      expect(typeof config.get("scan.concurrency")).toBe("number");
    });

    it("preserves float number types", () => {
      config.init("ghp_float");
      config.set("scan.code_similarity_threshold", "0.90");
      expect(config.get("scan.code_similarity_threshold")).toBe(0.90);
    });

    it("persists changes to disk", () => {
      config.init("ghp_persist");
      config.set("llm.model", "gpt-4");

      // Create a new Config instance to verify disk persistence
      const config2 = new Config(tempDir);
      expect(config2.get("llm.model")).toBe("gpt-4");
    });

    it("creates config file if it does not exist", () => {
      config.set("github.token", "ghp_create");
      expect(config.exists()).toBe(true);
      expect(config.get("github.token")).toBe("ghp_create");
    });
  });
});
