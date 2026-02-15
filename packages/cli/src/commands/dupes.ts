import { Command } from "commander";
import { ApiClient, ApiError } from "../client.js";
import { parseSlug } from "./track.js";

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

export function dupesCommand(client: ApiClient): Command {
  return new Command("dupes")
    .description("Show duplicate PR groups for a repository")
    .argument("<owner/repo>", "Repository slug (e.g. facebook/react)")
    .option("--json", "Output as JSON")
    .option("--min-score <score>", "Minimum score to display", parseFloat)
    .action(
      async (
        slug: string,
        opts: { json?: boolean; minScore?: number }
      ) => {
        const { owner, name } = parseSlug(slug);

        let data: DupesResponse;
        try {
          data = await client.get<DupesResponse>(
            `/repos/${owner}/${name}/dupes`
          );
        } catch (err) {
          if (err instanceof ApiError) {
            if (err.status === 404) {
              try {
                const parsed = JSON.parse(err.body);
                console.error(parsed.error ?? err.body);
              } catch {
                console.error(err.body);
              }
              process.exitCode = 1;
              return;
            }
          }
          throw err;
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
          console.log(`No duplicates found for ${owner}/${name}.`);
          return;
        }

        console.log(
          `${data.groupCount} duplicate group(s) for ${data.repo} (scan #${data.scanId})\n`
        );

        for (const group of data.groups) {
          const label = group.label ?? "Unnamed group";
          console.log(`--- ${label} (${group.prCount} PRs) ---`);

          for (const member of group.members) {
            const recommended = member.rank === 1 ? " RECOMMENDED" : "";
            const stateTag =
              member.state === "open"
                ? ""
                : ` [${member.state}]`;

            console.log(
              `  #${member.rank} PR #${member.prNumber}: ${member.title}` +
                `${stateTag}`
            );
            console.log(
              `     Author: ${member.author} | Score: ${member.score.toFixed(2)}${recommended}`
            );
            if (member.rationale) {
              console.log(`     ${member.rationale}`);
            }
          }

          console.log();
        }
      }
    );
}
