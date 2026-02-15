import { Command } from "commander";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

export function registerStackCommands(program: Command): void {
  program
    .command("up")
    .description("Start the ossgard stack (Docker Compose)")
    .option("-d, --detach", "Run in background")
    .action((opts: { detach?: boolean }) => {
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
