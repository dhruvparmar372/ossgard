import { Command } from "commander";
import { ApiClient, ApiError } from "../client.js";
import { requireSetup } from "../guard.js";
import { exitWithError } from "../errors.js";
import { parseSlug } from "./track.js";

interface ReviewMember {
  prId: number;
  prNumber: number;
  title: string;
  author: string;
  state: string;
  rank: number;
  score: number;
  rationale: string | null;
}

interface ReviewGroup {
  groupId: number;
  label: string | null;
  prCount: number;
  members: ReviewMember[];
}

interface SimilarPR {
  prId: number;
  prNumber: number;
  title: string;
  author: string;
  state: string;
  codeScore: number;
  intentScore: number;
}

interface ReviewResponse {
  repo: string;
  scanId: number;
  pr: {
    id: number;
    number: number;
    title: string;
    author: string;
    state: string;
  };
  dupeGroups: ReviewGroup[];
  similarPrs: SimilarPR[];
}

function parsePRArg(pr: string): number {
  // Try GitHub URL: https://github.com/owner/repo/pull/123
  const urlMatch = pr.match(/\/pull\/(\d+)/);
  if (urlMatch) return parseInt(urlMatch[1], 10);

  const num = parseInt(pr, 10);
  if (isNaN(num)) {
    throw new Error(
      `Invalid PR argument: "${pr}". Expected a PR number or GitHub URL.`
    );
  }
  return num;
}

export function reviewCommand(client: ApiClient): Command {
  return new Command("review")
    .description("Find duplicates for a specific PR")
    .argument("<owner/repo>", "Repository slug (e.g. facebook/react)")
    .argument("<pr>", "PR number or GitHub URL")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  $ ossgard review facebook/react 1234
  $ ossgard review facebook/react https://github.com/facebook/react/pull/1234 --json`)
    .action(
      async (
        slug: string,
        prArg: string,
        opts: { json?: boolean }
      ) => {
        requireSetup();
        const { owner, name } = parseSlug(slug);
        const prNumber = parsePRArg(prArg);

        let data: ReviewResponse;
        try {
          data = await client.get<ReviewResponse>(
            `/repos/${owner}/${name}/review/${prNumber}`
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

        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }

        const hasGroups = data.dupeGroups.length > 0;
        const hasSimilar = data.similarPrs.length > 0;

        if (!hasGroups && !hasSimilar) {
          console.log(`No duplicates found for PR #${prNumber} in ${owner}/${name}.`);
          return;
        }

        console.log(
          `Duplicates found for PR #${data.pr.number}: ${data.pr.title} (by ${data.pr.author})\n`
        );

        if (hasGroups) {
          for (const group of data.dupeGroups) {
            const label = group.label ?? "Unnamed group";
            console.log(`--- Existing group: ${label} (${group.prCount} PRs) ---`);

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
            console.log();
          }
        }

        if (hasSimilar) {
          console.log("--- Similar PRs (by vector similarity) ---");
          for (const sp of data.similarPrs) {
            const stateTag = sp.state === "open" ? "" : ` [${sp.state}]`;
            console.log(
              `  PR #${sp.prNumber}: ${sp.title} (by ${sp.author})${stateTag} — code: ${sp.codeScore.toFixed(2)}, intent: ${sp.intentScore.toFixed(2)}`
            );
          }
          console.log();
        }
      }
    );
}
