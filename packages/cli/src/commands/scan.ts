import { Command } from "commander";
import { ApiClient } from "../client.js";
import { requireSetup } from "../guard.js";
import { parseSlug } from "./track.js";
import type { Scan, ScanStatus } from "@ossgard/shared";

const PHASE_LABELS: Record<ScanStatus, string> = {
  queued: "Queued",
  ingesting: "Ingesting PRs",
  embedding: "Computing embeddings",
  clustering: "Clustering duplicates",
  verifying: "Verifying with LLM",
  ranking: "Ranking duplicates",
  done: "Done",
  failed: "Failed",
  paused: "Paused",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function scanCommand(client: ApiClient): Command {
  return new Command("scan")
    .description("Start a duplicate scan for a repository")
    .argument("<owner/repo>", "Repository slug (e.g. facebook/react)")
    .option("--full", "Run a full scan (re-scan everything)")
    .option("--limit <count>", "Maximum number of PRs to ingest", parseInt)
    .option("--no-wait", "Don't wait for scan to complete")
    .option("--json", "Output as JSON")
    .action(
      async (
        slug: string,
        opts: { full?: boolean; limit?: number; wait?: boolean; json?: boolean }
      ) => {
        if (!requireSetup()) return;
        const { owner, name } = parseSlug(slug);

        const body: Record<string, unknown> = {};
        if (opts.full) body.full = true;
        if (opts.limit) body.maxPrs = opts.limit;

        const result = await client.post<{
          scanId: number;
          jobId?: string;
          status: string;
        }>(`/repos/${owner}/${name}/scan`, Object.keys(body).length > 0 ? body : undefined);
        const scanId = result.scanId;
        const alreadyRunning = !result.jobId;

        if (alreadyRunning) {
          console.log(`Scan #${scanId} already in progress for ${owner}/${name}`);
        } else {
          console.log(`Scan #${scanId} started for ${owner}/${name}`);
        }

        // --no-wait: just print the scan ID and exit
        if (opts.wait === false) {
          if (opts.json) {
            console.log(JSON.stringify({ scanId, status: "queued" }));
          }
          return;
        }

        // Poll until done or failed
        let lastStatus = "";
        while (true) {
          const scan = await client.get<Scan>(`/scans/${scanId}`);

          if (scan.status !== lastStatus) {
            lastStatus = scan.status;
            const label = PHASE_LABELS[scan.status] ?? scan.status;

            if (opts.json) {
              console.log(JSON.stringify(scan));
            } else {
              const parts = [`  [${label}]`];
              if (scan.prCount > 0) {
                parts.push(`${scan.prCount} PRs`);
              }
              if (scan.dupeGroupCount > 0) {
                parts.push(`${scan.dupeGroupCount} dupe groups`);
              }
              console.log(parts.join(" | "));
            }
          }

          if (scan.status === "done") {
            if (!opts.json) {
              console.log(
                `\nScan complete. Found ${scan.dupeGroupCount} duplicate group(s).`
              );
              if (scan.dupeGroupCount > 0) {
                console.log(
                  `Run \`ossgard dupes ${owner}/${name}\` to view results.`
                );
              }
            }
            return;
          }

          if (scan.status === "failed") {
            if (!opts.json) {
              console.error(`\nScan failed: ${scan.error ?? "unknown error"}`);
            }
            process.exitCode = 1;
            return;
          }

          await sleep(1000);
        }
      }
    );
}
