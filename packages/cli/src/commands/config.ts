import { Command } from "commander";
import { Config } from "../config.js";
import type { ApiClient } from "../client.js";

/** Keys that belong to local CLI config (connection settings). */
const LOCAL_KEYS = new Set(["api", "api.url", "api.key"]);

function isLocalKey(key: string): boolean {
  return LOCAL_KEYS.has(key) || key.startsWith("api.");
}

/** Resolve a dot-notation key against an object. */
function resolve(obj: unknown, key: string): unknown {
  const parts = key.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Build a nested object from a dot-notation key and value. e.g. "llm.model", "gpt-4" => { llm: { model: "gpt-4" } } */
function buildPatch(key: string, value: string): Record<string, unknown> {
  const parts = key.split(".");
  if (parts.length < 2) {
    return { [key]: value };
  }

  const section = parts[0];
  const field = parts.slice(1).join(".");

  // Parse numbers for known numeric fields
  const numericFields = new Set([
    "concurrency",
    "code_similarity_threshold",
    "intent_similarity_threshold",
    "candidate_threshold",
    "max_candidates_per_pr",
  ]);
  const lastPart = parts[parts.length - 1];
  let parsed: string | number | boolean = value;
  if (numericFields.has(lastPart)) {
    const num = Number(value);
    if (!Number.isNaN(num)) parsed = num;
  }
  if (value === "true") parsed = true;
  if (value === "false") parsed = false;

  // Build nested structure
  const inner: Record<string, unknown> = {};
  const fieldParts = field.split(".");
  let cur = inner;
  for (let i = 0; i < fieldParts.length - 1; i++) {
    cur[fieldParts[i]] = {};
    cur = cur[fieldParts[i]] as Record<string, unknown>;
  }
  cur[fieldParts[fieldParts.length - 1]] = parsed;

  return { [section]: inner };
}

/** Pretty-print account config for terminal display. */
function formatAccountConfig(data: Record<string, unknown>, indent = ""): string {
  const lines: string[] = [];
  for (const [key, val] of Object.entries(data)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      lines.push(`${indent}${key}:`);
      lines.push(formatAccountConfig(val as Record<string, unknown>, indent + "  "));
    } else {
      lines.push(`${indent}${key}: ${val}`);
    }
  }
  return lines.join("\n");
}

/** Redact a string for display, showing only last 4 chars. */
function redactLocal(val: string): string {
  if (!val) return "(not set)";
  if (val.length <= 4) return "****";
  return "****" + val.slice(-4);
}

export function registerConfigCommand(program: Command, client: ApiClient): void {
  const configCmd = program
    .command("config")
    .description("Manage ossgard configuration")
    .addHelpText("after", `
Examples:
  $ ossgard config show
  $ ossgard config show --local
  $ ossgard config get api.url
  $ ossgard config set api.url http://localhost:3400`);

  configCmd
    .command("show")
    .description("Display account configuration from the server")
    .option("--json", "Output as JSON")
    .option("--local", "Show only local connection config")
    .action(async (opts: { json?: boolean; local?: boolean }) => {
      const config = new Config();
      const local = config.load();

      if (opts.local) {
        if (opts.json) {
          console.log(JSON.stringify(local, null, 2));
        } else {
          console.log(config.raw());
        }
        return;
      }

      // Fetch account config from server
      if (!config.isComplete()) {
        console.error('ossgard is not configured. Run "ossgard setup" first.');
        process.exitCode = 1;
        return;
      }

      try {
        const account = (await client.getAccountConfig()) as Record<string, unknown>;

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                connection: { url: local.api.url, key: redactLocal(local.api.key) },
                account: {
                  label: account.label,
                  config: account.config,
                  createdAt: account.createdAt,
                  updatedAt: account.updatedAt,
                },
              },
              null,
              2
            )
          );
        } else {
          console.log("Connection:");
          console.log(`  url: ${local.api.url}`);
          console.log(`  key: ${redactLocal(local.api.key)}`);
          console.log();
          if (account.label) {
            console.log(`Account: ${account.label}`);
          }
          console.log("Account Config:");
          console.log(formatAccountConfig(account.config as Record<string, unknown>, "  "));
          console.log();
          console.log(`Created: ${account.createdAt}`);
          console.log(`Updated: ${account.updatedAt}`);
        }
      } catch (err) {
        console.error(`Failed to fetch account config: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  configCmd
    .command("get <key>")
    .description("Get a config value (dot-notation, e.g. llm.model or api.url)")
    .action(async (key: string) => {
      // Local keys (api.*) come from local config
      if (isLocalKey(key)) {
        const config = new Config();
        const value = config.get(key);
        if (value === undefined) {
          console.error(`Key "${key}" not found.`);
          process.exitCode = 1;
          return;
        }
        if (typeof value === "object" && value !== null) {
          console.log(JSON.stringify(value, null, 2));
        } else {
          console.log(String(value));
        }
        return;
      }

      // Server-side keys
      const config = new Config();
      if (!config.isComplete()) {
        console.error('ossgard is not configured. Run "ossgard setup" first.');
        process.exitCode = 1;
        return;
      }

      try {
        const account = (await client.getAccountConfig()) as Record<string, unknown>;
        const serverConfig = account.config as Record<string, unknown>;
        const value = resolve(serverConfig, key);

        if (value === undefined) {
          console.error(`Key "${key}" not found in account config.`);
          process.exitCode = 1;
          return;
        }

        if (typeof value === "object" && value !== null) {
          console.log(JSON.stringify(value, null, 2));
        } else {
          console.log(String(value));
        }
      } catch (err) {
        console.error(`Failed to fetch account config: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  configCmd
    .command("set <key> <value>")
    .description("Set a config value (dot-notation, e.g. llm.model claude-sonnet-4-6)")
    .action(async (key: string, value: string) => {
      // Local keys (api.*) are saved to local config file only
      if (isLocalKey(key)) {
        const config = new Config();
        config.set(key, value);
        console.log(`Set ${key} = ${config.get(key)}`);
        return;
      }

      // Server-side keys are persisted via PATCH
      const config = new Config();
      if (!config.isComplete()) {
        console.error('ossgard is not configured. Run "ossgard setup" first.');
        process.exitCode = 1;
        return;
      }

      try {
        const patch = buildPatch(key, value);
        const result = await client.patchAccountConfig(patch);

        if (result.updated) {
          console.log(`Set ${key} = ${value}`);
        }

        if (result.warnings?.length) {
          for (const w of result.warnings) {
            console.warn(`Warning: ${w}`);
          }
        }
      } catch (err) {
        console.error(`Failed to update config: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
