import { Command } from "commander";
import { ApiClient } from "../client.js";
import { requireSetup } from "../guard.js";
import type { Repo, ScanStatus } from "@ossgard/shared";

type RepoWithScanStatus = Repo & {
  activeScanStatus: ScanStatus | null;
  activeScanPrCount: number | null;
  activeScanDupeGroupCount: number | null;
};

const PHASE_LABELS: Record<ScanStatus, string> = {
  queued: "Queued",
  ingesting: "Ingesting PRs",
  embedding: "Computing embeddings",
  verifying: "Verifying with LLM",
  ranking: "Ranking duplicates",
  done: "Done",
  failed: "Failed",
  paused: "Paused",
};

export function statusCommand(client: ApiClient): Command {
  return new Command("status")
    .description("Show tracked repositories and their status")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      if (!requireSetup()) return;
      let repos: RepoWithScanStatus[];
      try {
        repos = await client.get<RepoWithScanStatus[]>("/repos");
      } catch {
        console.error("Failed to connect to ossgard API. Is it running? (ossgard-api)");
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(repos, null, 2));
        return;
      }

      if (repos.length === 0) {
        console.log("No repositories tracked. Use `ossgard scan <owner/repo>` to get started.");
        return;
      }

      console.log("Tracked repositories:\n");
      for (const repo of repos) {
        if (repo.activeScanStatus) {
          const label = PHASE_LABELS[repo.activeScanStatus] ?? repo.activeScanStatus;
          const counts: string[] = [];
          if (repo.activeScanPrCount && repo.activeScanPrCount > 0) {
            counts.push(`${repo.activeScanPrCount} PRs`);
          }
          if (repo.activeScanDupeGroupCount && repo.activeScanDupeGroupCount > 0) {
            counts.push(`${repo.activeScanDupeGroupCount} dupe groups`);
          }
          const suffix = counts.length > 0 ? ` — ${counts.join(", ")}` : "";
          console.log(`  ${repo.owner}/${repo.name} (scanning: ${label}${suffix})`);
        } else {
          const lastScan = repo.lastScanAt ?? "never";
          console.log(`  ${repo.owner}/${repo.name} (last scan: ${lastScan})`);
        }
      }
    });
}
