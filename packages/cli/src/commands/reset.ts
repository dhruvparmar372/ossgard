import { Command } from "commander";
import { ApiClient } from "../client.js";
import { requireSetup } from "../guard.js";
import * as readline from "node:readline";

function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

export function clearScansCommand(client: ApiClient): Command {
  return new Command("clear-scans")
    .description("Delete all scans, analysis results, and jobs (keeps repos and PRs)")
    .option("--force", "Skip confirmation prompt")
    .action(async (opts: { force?: boolean }) => {
      if (!requireSetup()) return;

      if (!opts.force) {
        const yes = await confirm(
          "This will delete all scans, duplicate groups, and jobs. Repos and PRs will be kept. Continue? (y/N) "
        );
        if (!yes) {
          console.log("Aborted.");
          return;
        }
      }

      try {
        await client.post("/clear-scans");
        console.log("All scans and analysis data have been cleared.");
      } catch {
        console.error("Failed to clear scans. Is the ossgard API running? (ossgard up)");
        process.exitCode = 1;
      }
    });
}

export function clearReposCommand(client: ApiClient): Command {
  return new Command("clear-repos")
    .description("Delete all repositories, PRs, scans, and analysis data")
    .option("--force", "Skip confirmation prompt")
    .action(async (opts: { force?: boolean }) => {
      if (!requireSetup()) return;

      if (!opts.force) {
        const yes = await confirm(
          "This will delete ALL repositories, PRs, scans, and analysis data. Continue? (y/N) "
        );
        if (!yes) {
          console.log("Aborted.");
          return;
        }
      }

      try {
        await client.post("/clear-repos");
        console.log("All repositories and associated data have been cleared.");
      } catch {
        console.error("Failed to clear repos. Is the ossgard API running? (ossgard up)");
        process.exitCode = 1;
      }
    });
}
