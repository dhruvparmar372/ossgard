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

  it("load returns defaults when config file doesn't exist", () => {
    const cfg = config.load();

    expect(cfg.api.url).toBe("http://localhost:3400");
    expect(cfg.api.key).toBe("");
  });

  it("get/set works with api fields", () => {
    config.save({ api: { url: "http://localhost:3400", key: "test-key" } });
    config.set("api.url", "http://remote:3400");
    expect(config.get("api.url")).toBe("http://remote:3400");

    config.set("api.key", "new-key-456");
    expect(config.get("api.key")).toBe("new-key-456");
  });

  it("api.key defaults to empty string", () => {
    const cfg = config.load();
    expect(cfg.api.key).toBe("");
  });

  describe("isComplete", () => {
    it("returns false when config file doesn't exist", () => {
      expect(config.isComplete()).toBe(false);
    });

    it("returns false when api.url is empty", () => {
      config.save({ api: { url: "", key: "test-key" } });
      expect(config.isComplete()).toBe(false);
    });

    it("returns false when api.key is empty", () => {
      config.save({ api: { url: "http://localhost:3400", key: "" } });
      expect(config.isComplete()).toBe(false);
    });

    it("returns true when all required fields are populated", () => {
      config.save({ api: { url: "http://localhost:3400", key: "test-key-123" } });
      expect(config.isComplete()).toBe(true);
    });
  });

  describe("save", () => {
    it("writes config that can be loaded back with matching values", () => {
      const input: OssgardConfig = {
        api: { url: "http://myapi:3400", key: "my-api-key-123" },
      };

      config.save(input);
      const loaded = config.load();

      expect(loaded.api.url).toBe(input.api.url);
      expect(loaded.api.key).toBe(input.api.key);
    });

    it("creates config directory if it doesn't exist", () => {
      const nested = join(tempDir, "nested", "deep");
      const nestedConfig = new Config(nested);

      const input: OssgardConfig = {
        api: { url: "http://localhost:3400", key: "nested-key" },
      };

      nestedConfig.save(input);
      expect(nestedConfig.exists()).toBe(true);
      expect(nestedConfig.load().api.key).toBe("nested-key");
    });
  });
});
