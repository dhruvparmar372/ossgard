import { Command } from "commander";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Config } from "../config.js";

/**
 * Look for docker-compose.yml relative to this package's location.
 * Walks up from packages/cli/ to the monorepo root.
 */
function findComposeFile(): string | null {
  // Start from this file's directory: packages/cli/src/commands/
  const thisDir = dirname(fileURLToPath(import.meta.url));
  let dir = thisDir;

  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "docker-compose.yml");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  return null;
}

function pullOllamaModels(composePath: string): void {
  const config = new Config();
  const cfg = config.load();

  // Only pull if the LLM provider is ollama (or default)
  if (cfg.llm.provider && cfg.llm.provider !== "ollama") {
    return;
  }

  const models = new Set<string>();
  if (cfg.embedding.model) {
    models.add(cfg.embedding.model);
  }
  if (cfg.llm.model) {
    models.add(cfg.llm.model);
  }

  for (const model of models) {
    console.log(`Pulling Ollama model: ${model}...`);
    try {
      execSync(
        `docker compose -f ${composePath} exec ollama ollama pull ${model}`,
        { stdio: "inherit" }
      );
    } catch {
      console.warn(`Warning: failed to pull model "${model}". You may need to pull it manually.`);
    }
  }
}

export function registerStackCommands(program: Command): void {
  program
    .command("up")
    .description("Start the ossgard stack (Docker Compose)")
    .option("-d, --detach", "Run in background")
    .action((opts: { detach?: boolean }) => {
      // Ensure ~/.ossgard exists before docker compose creates it as root-owned
      const ossgardDir = join(process.env.HOME ?? "", ".ossgard");
      if (!existsSync(ossgardDir)) {
        mkdirSync(ossgardDir, { recursive: true });
      }

      const composePath = findComposeFile();
      if (!composePath) {
        console.error("docker-compose.yml not found. Are you in the ossgard project?");
        process.exitCode = 1;
        return;
      }

      const args = ["docker", "compose", "-f", composePath, "up", "--build"];
      if (opts.detach) {
        args.push("-d");
      }

      console.log("Starting ossgard stack...");
      try {
        execSync(args.join(" "), { stdio: "inherit" });
      } catch {
        process.exitCode = 1;
        return;
      }

      // After successful detached start, pull Ollama models if using ollama provider
      if (opts.detach) {
        pullOllamaModels(composePath);
      }
    });

  program
    .command("down")
    .description("Stop the ossgard stack")
    .action(() => {
      const composePath = findComposeFile();
      if (!composePath) {
        console.error("docker-compose.yml not found. Are you in the ossgard project?");
        process.exitCode = 1;
        return;
      }

      console.log("Stopping ossgard stack...");
      try {
        execSync(`docker compose -f ${composePath} down`, { stdio: "inherit" });
      } catch {
        process.exitCode = 1;
      }
    });
}
