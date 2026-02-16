import { Command } from "commander";
import { ApiClient } from "../client.js";
import { requireSetup } from "../guard.js";
import type { Repo } from "@ossgard/shared";

export function statusCommand(client: ApiClient): Command {
  return new Command("status")
    .description("Show tracked repositories and their status")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      if (!requireSetup()) return;
      let repos: Repo[];
      try {
        repos = await client.get<Repo[]>("/repos");
      } catch {
        console.error("Failed to connect to ossgard API. Is it running? (ossgard up)");
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(repos, null, 2));
        return;
      }

      if (repos.length === 0) {
        console.log("No repositories tracked. Use `ossgard track <owner/repo>` to get started.");
        return;
      }

      console.log("Tracked repositories:\n");
      for (const repo of repos) {
        const lastScan = repo.lastScanAt ?? "never";
        console.log(`  ${repo.owner}/${repo.name} (last scan: ${lastScan})`);
      }
    });
}
