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

    it("returns true after save", () => {
      config.save({ api: { url: "http://localhost:3400", key: "test-key" } });
      expect(config.exists()).toBe(true);
    });
  });

  describe("save()", () => {
    it("creates config file with api fields", () => {
      config.save({ api: { url: "http://localhost:3400", key: "test-key-123" } });
      const loaded = config.load();
      expect(loaded.api.url).toBe("http://localhost:3400");
      expect(loaded.api.key).toBe("test-key-123");
    });

    it("writes a valid TOML file", () => {
      config.save({ api: { url: "http://localhost:3400", key: "my-key" } });
      const raw = readFileSync(join(tempDir, "config.toml"), "utf-8");
      expect(raw).toContain("[api]");
      expect(raw).toContain('url = "http://localhost:3400"');
      expect(raw).toContain('key = "my-key"');
    });
  });

  describe("load()", () => {
    it("returns defaults when config file does not exist", () => {
      const loaded = config.load();
      expect(loaded.api.url).toBe("http://localhost:3400");
      expect(loaded.api.key).toBe("");
    });

    it("returns saved config when file exists", () => {
      config.save({ api: { url: "http://example.com:3400", key: "saved-key" } });
      const loaded = config.load();
      expect(loaded.api.url).toBe("http://example.com:3400");
      expect(loaded.api.key).toBe("saved-key");
    });
  });

  describe("get()", () => {
    it("gets top-level section", () => {
      config.save({ api: { url: "http://localhost:3400", key: "get-key" } });
      const api = config.get("api") as { url: string; key: string };
      expect(api.key).toBe("get-key");
    });

    it("gets nested value with dot notation", () => {
      config.save({ api: { url: "http://localhost:3400", key: "dot-key" } });
      expect(config.get("api.url")).toBe("http://localhost:3400");
      expect(config.get("api.key")).toBe("dot-key");
    });

    it("returns undefined for non-existent key", () => {
      config.save({ api: { url: "http://localhost:3400", key: "none-key" } });
      expect(config.get("nonexistent")).toBeUndefined();
      expect(config.get("api.nonexistent")).toBeUndefined();
    });

    it("returns defaults when no config file exists", () => {
      expect(config.get("api.url")).toBe("http://localhost:3400");
    });
  });

  describe("set()", () => {
    it("sets a string value", () => {
      config.save({ api: { url: "http://localhost:3400", key: "old-key" } });
      config.set("api.key", "new-key");
      expect(config.get("api.key")).toBe("new-key");
    });

    it("sets the api url", () => {
      config.save({ api: { url: "http://localhost:3400", key: "set-key" } });
      config.set("api.url", "http://remote:3400");
      expect(config.get("api.url")).toBe("http://remote:3400");
    });

    it("persists changes to disk", () => {
      config.save({ api: { url: "http://localhost:3400", key: "persist-key" } });
      config.set("api.key", "updated-key");

      // Create a new Config instance to verify disk persistence
      const config2 = new Config(tempDir);
      expect(config2.get("api.key")).toBe("updated-key");
    });

    it("creates config file if it does not exist", () => {
      config.set("api.key", "create-key");
      expect(config.exists()).toBe(true);
      expect(config.get("api.key")).toBe("create-key");
    });
  });
});
