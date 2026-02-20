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

// --- Shared types ---

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

// --- Review types (--pr mode) ---

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
  dupeGroups: DupeGroupResponse[];
  similarPrs: SimilarPR[];
}

// --- Helpers ---

function parsePRArg(pr: string): number {
  // Try GitHub URL: https://github.com/owner/repo/pull/123
  const urlMatch = pr.match(/\/pull\/(\d+)/);
  if (urlMatch) return parseInt(urlMatch[1], 10);

  const num = parseInt(pr, 10);
  if (isNaN(num)) {
    throw new Error(
      `Invalid --pr value: "${pr}". Expected a PR number or GitHub URL.`
    );
  }
  return num;
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

function handleApiError(err: unknown): never {
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

// --- PR review mode ---

async function runPRReview(
  client: ApiClient,
  owner: string,
  name: string,
  prArg: string,
  opts: { json?: boolean }
): Promise<void> {
  const prNumber = parsePRArg(prArg);

  let data: ReviewResponse;
  try {
    data = await client.get<ReviewResponse>(
      `/repos/${owner}/${name}/review/${prNumber}`
    );
  } catch (err) {
    handleApiError(err);
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

// --- All-groups mode ---

async function runAllGroups(
  client: ApiClient,
  owner: string,
  name: string,
  opts: { json?: boolean; minScore?: number }
): Promise<void> {
  let data: DupesResponse;
  try {
    data = await client.get<DupesResponse>(
      `/repos/${owner}/${name}/dupes`
    );
  } catch (err) {
    handleApiError(err);
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

// --- Command ---

export function checkDuplicatesCommand(client: ApiClient): Command {
  return new Command("check-duplicates")
    .description("Show duplicate PR groups for a repository")
    .argument("<owner/repo>", "Repository slug (e.g. facebook/react)")
    .option("--pr <number>", "Check duplicates for a specific PR (number or GitHub URL)")
    .option("--json", "Output as JSON")
    .option("--min-score <score>", "Minimum score to display", parseFloat)
    .addHelpText("after", `
Examples:
  $ ossgard check-duplicates facebook/react
  $ ossgard check-duplicates facebook/react --json
  $ ossgard check-duplicates facebook/react --min-score 70
  $ ossgard check-duplicates facebook/react --pr 1234
  $ ossgard check-duplicates facebook/react --pr https://github.com/facebook/react/pull/1234`)
    .action(
      async (
        slug: string,
        opts: { pr?: string; json?: boolean; minScore?: number }
      ) => {
        requireSetup();
        const { owner, name } = parseSlug(slug);

        if (opts.pr) {
          await runPRReview(client, owner, name, opts.pr, opts);
        } else {
          await runAllGroups(client, owner, name, opts);
        }
      }
    );
}
