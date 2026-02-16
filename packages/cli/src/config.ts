import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse, stringify } from "@iarna/toml";

export interface OssgardConfig {
  github: { token: string };
  llm: {
    provider: string;
    url: string;
    model: string;
    api_key: string;
    batch?: boolean;
  };
  embedding: {
    provider: string;
    url: string;
    model: string;
    api_key: string;
    batch?: boolean;
  };
  vector_store: {
    url: string;
  };
  scan: {
    concurrency: number;
    code_similarity_threshold: number;
    intent_similarity_threshold: number;
  };
}

const DEFAULT_CONFIG: OssgardConfig = {
  github: { token: "" },
  llm: {
    provider: "ollama",
    url: "http://localhost:11434",
    model: "llama3",
    api_key: "",
  },
  embedding: {
    provider: "ollama",
    url: "http://localhost:11434",
    model: "nomic-embed-text",
    api_key: "",
  },
  vector_store: {
    url: "http://localhost:6333",
  },
  scan: {
    concurrency: 10,
    code_similarity_threshold: 0.85,
    intent_similarity_threshold: 0.80,
  },
};

export class Config {
  private readonly configDir: string;
  private readonly configPath: string;

  constructor(configDir?: string) {
    this.configDir = configDir ?? join(homedir(), ".ossgard");
    this.configPath = join(this.configDir, "config.toml");
  }

  /** Create a default config file with the given GitHub token. */
  init(githubToken: string): void {
    mkdirSync(this.configDir, { recursive: true });
    const config: OssgardConfig = {
      ...structuredClone(DEFAULT_CONFIG),
      github: { token: githubToken },
    };
    writeFileSync(this.configPath, stringify(config as any), "utf-8");
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

  /** Get a config value using dot-notation (e.g. "llm.provider"). */
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

  /** Check if the config file exists. */
  exists(): boolean {
    return existsSync(this.configPath);
  }
}
