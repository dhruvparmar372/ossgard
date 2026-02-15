import { Command } from "commander";
import { ApiClient } from "../client.js";
import type { Repo } from "@ossgard/shared";

export function statusCommand(client: ApiClient): Command {
  return new Command("status")
    .description("Show tracked repositories and their status")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const repos = await client.get<Repo[]>("/repos");

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
        const lastScan = repo.last_scan_at ?? "never";
        console.log(`  ${repo.owner}/${repo.name} (last scan: ${lastScan})`);
      }
    });
}
