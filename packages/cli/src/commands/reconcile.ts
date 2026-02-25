import { Command } from "commander";
import { ApiClient } from "../client.js";
import { requireSetup } from "../guard.js";
import { exitWithError } from "../errors.js";
import { parseSlug } from "./track.js";

export function reconcileCommand(client: ApiClient): Command {
  return new Command("reconcile")
    .description("Reconcile stale PRs — marks locally-open PRs as closed if they are closed on GitHub")
    .argument("<owner/repo>", "Repository slug (e.g. facebook/react)")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  $ ossgard reconcile openclaw/openclaw
  $ ossgard reconcile facebook/react --json`)
    .action(async (slug: string, opts: { json?: boolean }) => {
      requireSetup();
      const { owner, name } = parseSlug(slug);

      if (!opts.json) {
        console.log(`Reconciling ${owner}/${name}...`);
      }

      try {
        const result = await client.post<{
          repo: string;
          githubOpen: number;
          dbOpenBefore: number;
          dbOpenAfter: number;
          closed: number;
        }>(`/repos/${owner}/${name}/reconcile`);

        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(`  GitHub open PRs: ${result.githubOpen}`);
          console.log(`  DB open before:  ${result.dbOpenBefore}`);
          console.log(`  Stale PRs closed: ${result.closed}`);
          console.log(`  DB open after:   ${result.dbOpenAfter}`);

          if (result.closed > 0) {
            console.log(`\nReconciled ${result.closed} stale PR(s).`);
          } else {
            console.log("\nNo stale PRs found. DB is already in sync.");
          }
        }
      } catch {
        exitWithError("API_UNREACHABLE", "Failed to reconcile. Is the ossgard API running?", {
          suggestion: "ossgard doctor",
          exitCode: 4,
        });
      }
    });
}
