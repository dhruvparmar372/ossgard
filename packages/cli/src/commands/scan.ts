import { Command } from "commander";
import { ApiClient } from "../client.js";
import { requireSetup } from "../guard.js";
import { exitWithError } from "../errors.js";
import { parseSlug } from "./track.js";
import type { Scan, ScanStatus } from "@ossgard/shared";

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
    .option("--json", "Output as JSON (JSONL progress events)")
    .addHelpText("after", `
Examples:
  $ ossgard scan facebook/react
  $ ossgard scan facebook/react --limit 100 --no-wait
  $ ossgard scan facebook/react --full --json`)
    .action(
      async (
        slug: string,
        opts: { full?: boolean; limit?: number; wait?: boolean; json?: boolean }
      ) => {
        requireSetup();
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

        if (opts.json) {
          // JSONL: one JSON object per line
          console.log(JSON.stringify({ event: "started", scanId, status: "queued" }));
        } else if (alreadyRunning) {
          console.log(`Scan #${scanId} already in progress for ${owner}/${name}`);
        } else {
          console.log(`Scan #${scanId} started for ${owner}/${name}`);
        }

        // --no-wait: just print the scan ID and exit
        if (opts.wait === false) {
          return;
        }

        // Poll until done or failed
        let lastStatus = "";
        while (true) {
          const scan = await client.get<Scan>(`/scans/${scanId}`);

          if (scan.status !== lastStatus) {
            lastStatus = scan.status;

            if (opts.json) {
              const event = scan.status === "done" ? "done"
                : scan.status === "failed" ? "failed"
                : "progress";
              console.log(JSON.stringify({
                event,
                scanId: scan.id,
                status: scan.status,
                prCount: scan.prCount,
                dupeGroupCount: scan.dupeGroupCount,
              }));
            } else {
              const label = PHASE_LABELS[scan.status] ?? scan.status;
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
                  `Run \`ossgard duplicates ${owner}/${name}\` to view results.`
                );
              }
            }
            return;
          }

          if (scan.status === "failed") {
            exitWithError("SCAN_FAILED", scan.error ?? "Scan failed: unknown error", {
              exitCode: 1,
            });
          }

          await sleep(1000);
        }
      }
    );
}
