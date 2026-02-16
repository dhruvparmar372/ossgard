import { Config, type OssgardConfig } from "./config.js";
import { mkdtempSync, readFileSync } from "node:fs";
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
});
