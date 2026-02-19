import { Command } from "commander";
import { ApiClient } from "../client.js";
import { requireSetup } from "../guard.js";
import * as readline from "node:readline";

type CleanScope = "scans" | "repos" | "all";

function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

function chooseScope(): Promise<CleanScope | null> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    console.log("What should be deleted?\n");
    console.log("  1. scans   — Delete scans, analysis results, and jobs (keep repos and PRs)");
    console.log("  2. repos   — Delete repos, PRs, scans, and analysis");
    console.log("  3. all     — Full reset — delete everything including accounts");
    console.log();
    rl.question("Choose (1/2/3): ", (answer) => {
      rl.close();
      const choice = answer.trim();
      if (choice === "1") resolve("scans");
      else if (choice === "2") resolve("repos");
      else if (choice === "3") resolve("all");
      else resolve(null);
    });
  });
}

const SCOPE_ENDPOINTS: Record<CleanScope, string> = {
  scans: "/clear-scans",
  repos: "/clear-repos",
  all: "/reset",
};

const SCOPE_WARNINGS: Record<CleanScope, string> = {
  scans: "This will delete all scans, duplicate groups, and jobs. Repos and PRs will be kept.",
  repos: "This will delete ALL repositories, PRs, scans, and analysis data.",
  all: "This will DELETE ALL DATA: accounts, config, repositories, PRs, scans, and analysis results. This cannot be undone.",
};

const SCOPE_SUCCESS: Record<CleanScope, string> = {
  scans: "All scans and analysis data have been cleared.",
  repos: "All repositories and associated data have been cleared.",
  all: "Full reset complete. All data has been cleared.",
};

export function cleanCommand(client: ApiClient): Command {
  return new Command("clean")
    .description("Delete ossgard data")
    .option("--scans", "Delete scans, analysis results, and jobs (keep repos and PRs)")
    .option("--repos", "Delete repos, PRs, scans, and analysis")
    .option("--all", "Full reset — delete everything including accounts")
    .option("--force", "Skip confirmation prompt")
    .action(async (opts: { scans?: boolean; repos?: boolean; all?: boolean; force?: boolean }) => {
      if (!requireSetup()) return;

      // Check for multiple flags
      const flagCount = [opts.scans, opts.repos, opts.all].filter(Boolean).length;
      if (flagCount > 1) {
        console.error("Specify exactly one of --scans, --repos, or --all.");
        process.exitCode = 1;
        return;
      }

      let scope: CleanScope;
      if (opts.scans) scope = "scans";
      else if (opts.repos) scope = "repos";
      else if (opts.all) scope = "all";
      else {
        // Interactive: ask which scope
        const chosen = await chooseScope();
        if (!chosen) {
          console.log("Aborted.");
          return;
        }
        scope = chosen;
      }

      // Confirm unless --force
      if (!opts.force) {
        const yes = await confirm(`${SCOPE_WARNINGS[scope]} Continue? (y/N) `);
        if (!yes) {
          console.log("Aborted.");
          return;
        }
      }

      try {
        await client.post(SCOPE_ENDPOINTS[scope]);
        console.log(SCOPE_SUCCESS[scope]);
      } catch {
        console.error("Failed to clean data. Is the ossgard API running? (ossgard-api)");
        process.exitCode = 1;
      }
    });
}
