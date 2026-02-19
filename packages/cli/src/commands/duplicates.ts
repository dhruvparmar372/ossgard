import { Command } from "commander";
import { createInterface, Interface as RLInterface } from "node:readline";
import { ApiClient, ApiError } from "../client.js";
import { requireSetup } from "../guard.js";
import { exitWithError } from "../errors.js";
import { isInteractive } from "../interactive.js";
import { parseSlug } from "./track.js";

function ask(rl: RLInterface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer.trim()));
  });
}

interface DupeMember {
  prId: number;
  prNumber: number;
  title: string;
  author: string;
  state: string;
  rank: number;
  score: number;
  rationale: string | null;
}

interface DupeGroupResponse {
  groupId: number;
  label: string | null;
  prCount: number;
  members: DupeMember[];
}

interface DupesResponse {
  repo: string;
  scanId: number;
  completedAt: string | null;
  groupCount: number;
  groups: DupeGroupResponse[];
}

function printGroup(group: DupeGroupResponse): void {
  const label = group.label ?? "Unnamed group";
  console.log(`--- Group: ${label} (${group.prCount} PRs) ---`);

  for (const member of group.members) {
    const tag = member.rank === 1 ? "MERGE" : "CLOSE";
    const stateTag = member.state === "open" ? "" : ` [${member.state}]`;
    console.log(
      `  ${tag}  PR #${member.prNumber}: ${member.title} (by ${member.author})${stateTag} — score: ${member.score.toFixed(2)}`
    );
    if (member.rationale) {
      console.log(`         ${member.rationale}`);
    }
  }
}

export function duplicatesCommand(client: ApiClient): Command {
  return new Command("duplicates")
    .description("Show duplicate PR groups for a repository")
    .argument("<owner/repo>", "Repository slug (e.g. facebook/react)")
    .option("--json", "Output as JSON")
    .option("--min-score <score>", "Minimum score to display", parseFloat)
    .addHelpText("after", `
Examples:
  $ ossgard duplicates facebook/react
  $ ossgard duplicates facebook/react --json
  $ ossgard duplicates facebook/react --min-score 70`)
    .action(
      async (
        slug: string,
        opts: { json?: boolean; minScore?: number }
      ) => {
        requireSetup();
        const { owner, name } = parseSlug(slug);

        let data: DupesResponse;
        try {
          data = await client.get<DupesResponse>(
            `/repos/${owner}/${name}/dupes`
          );
        } catch (err) {
          if (err instanceof ApiError) {
            if (err.status === 404) {
              let message: string;
              try {
                const parsed = JSON.parse(err.body);
                message = parsed.error ?? err.body;
              } catch {
                message = err.body;
              }
              exitWithError("NOT_FOUND", message, { exitCode: 1 });
            }
          }
          exitWithError("API_UNREACHABLE", "Failed to connect to ossgard API. Is it running?", {
            suggestion: "ossgard-api",
            exitCode: 4,
          });
        }

        // Filter by min-score if specified
        if (opts.minScore !== undefined) {
          for (const group of data.groups) {
            group.members = group.members.filter(
              (m) => m.score >= opts.minScore!
            );
          }
          data.groups = data.groups.filter((g) => g.members.length > 0);
          data.groupCount = data.groups.length;
        }

        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }

        if (data.groupCount === 0) {
          console.log(`No duplicate groups found for ${owner}/${name}.`);
          return;
        }

        // Stats summary
        const totalPrs = data.groups.reduce((sum, g) => sum + g.prCount, 0);
        console.log(`${owner}/${name} — scan #${data.scanId}`);
        console.log(
          `${data.groupCount} duplicate group(s) found, covering ${totalPrs} PRs total\n`
        );

        // Sort by prCount descending
        const sorted = [...data.groups].sort((a, b) => b.prCount - a.prCount);

        // Non-interactive: dump all groups without prompts
        if (!isInteractive()) {
          for (const group of sorted) {
            console.log();
            printGroup(group);
          }
          return;
        }

        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        try {
          const answer = await ask(rl, "Review duplicate groups? (Y/n): ");
          if (answer.toLowerCase() === "n") {
            return;
          }

          for (let i = 0; i < sorted.length; i++) {
            console.log();
            printGroup(sorted[i]);

            if (i < sorted.length - 1) {
              const next = await ask(rl, "\nNext group? (Y/n): ");
              if (next.toLowerCase() === "n") {
                return;
              }
            }
          }

          console.log(`\nAll ${sorted.length} group(s) reviewed.`);
        } finally {
          rl.close();
        }
      }
    );
}
