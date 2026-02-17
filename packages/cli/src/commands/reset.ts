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

export function resetCommand(client: ApiClient): Command {
  return new Command("reset")
    .description("Delete all repositories, scans, and analysis data")
    .option("--force", "Skip confirmation prompt")
    .action(async (opts: { force?: boolean }) => {
      if (!requireSetup()) return;

      if (!opts.force) {
        const yes = await confirm(
          "This will delete ALL repositories, scans, and analysis data. Continue? (y/N) "
        );
        if (!yes) {
          console.log("Aborted.");
          return;
        }
      }

      try {
        await client.post("/reset");
        console.log("All data has been reset.");
      } catch {
        console.error("Failed to reset. Is the ossgard API running? (ossgard up)");
        process.exitCode = 1;
      }
    });
}
