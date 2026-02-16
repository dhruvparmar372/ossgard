import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse, stringify } from "@iarna/toml";

export interface OssgardConfig {
  api: { url: string; key: string };
}

const DEFAULT_CONFIG: OssgardConfig = {
  api: { url: "http://localhost:3400", key: "" },
};

export class Config {
  private readonly configDir: string;
  private readonly configPath: string;

  constructor(configDir?: string) {
    this.configDir = configDir ?? join(homedir(), ".ossgard");
    this.configPath = join(this.configDir, "config.toml");
  }

  /** Load config from disk, returning defaults if the file doesn't exist. */
  load(): OssgardConfig {
    if (!existsSync(this.configPath)) {
      return structuredClone(DEFAULT_CONFIG);
    }
    const raw = readFileSync(this.configPath, "utf-8");
    const parsed = parse(raw) as unknown as OssgardConfig;
    return parsed;
  }

  /** Get a config value using dot-notation (e.g. "api.url"). */
  get(key: string): unknown {
    const config = this.load();
    const parts = key.split(".");
    let current: unknown = config;
    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== "object") {
        return undefined;
      }
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  /** Set a config value using dot-notation. Preserves number types. */
  set(key: string, value: string): void {
    const config = this.load();
    const parts = key.split(".");
    let current: Record<string, unknown> = config as unknown as Record<string, unknown>;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (current[part] === undefined || typeof current[part] !== "object") {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }

    const lastKey = parts[parts.length - 1];
    const existingValue = current[lastKey];

    // Preserve number types: if the existing value is a number, parse as number
    if (typeof existingValue === "number") {
      const num = Number(value);
      if (!Number.isNaN(num)) {
        current[lastKey] = num;
      } else {
        current[lastKey] = value;
      }
    } else {
      current[lastKey] = value;
    }

    mkdirSync(this.configDir, { recursive: true });
    writeFileSync(this.configPath, stringify(config as any), "utf-8");
  }

  /** Return the raw TOML config file contents, or a serialised default. */
  raw(): string {
    if (existsSync(this.configPath)) {
      return readFileSync(this.configPath, "utf-8");
    }
    return stringify(structuredClone(DEFAULT_CONFIG) as any);
  }

  /** Check if the config file exists. */
  exists(): boolean {
    return existsSync(this.configPath);
  }

  /** Check if all required config fields are populated. */
  isComplete(): boolean {
    if (!this.exists()) return false;
    const cfg = this.load();
    return !!(cfg.api.url && cfg.api.key);
  }

  /** Write a full config object to disk. */
  save(config: OssgardConfig): void {
    mkdirSync(this.configDir, { recursive: true });
    writeFileSync(this.configPath, stringify(config as any), "utf-8");
  }
}
