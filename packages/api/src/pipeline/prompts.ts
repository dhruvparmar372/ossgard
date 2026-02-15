import type { PR } from "@ossgard/shared";
import type { Message } from "../services/llm-provider.js";

/**
 * Builds a prompt asking the LLM to verify which PRs in a candidate group
 * are actually duplicates of each other.
 *
 * Expected JSON response format:
 * {
 *   "groups": [{ "prIds": number[], "label": string, "confidence": number, "relationship": string }],
 *   "unrelated": number[]
 * }
 */
export function buildVerifyPrompt(prs: PR[]): Message[] {
  const prSummaries = prs
    .map(
      (pr) =>
        `PR #${pr.number} (id: ${pr.id}):
  Title: ${pr.title}
  Author: ${pr.author}
  Files: ${pr.filePaths.join(", ")}
  Body: ${pr.body ?? "(none)"}
  DiffHash: ${pr.diffHash ?? "(none)"}`
    )
    .join("\n\n");

  return [
    {
      role: "system",
      content: `You are a code review assistant that identifies duplicate or closely related pull requests.
Analyze the provided PRs and group the ones that are duplicates or near-duplicates.
Consider: identical file changes, similar intent/purpose, overlapping code modifications.

You MUST respond with valid JSON in this exact format:
{
  "groups": [
    {
      "prIds": [<list of PR id values that are duplicates>],
      "label": "<short description of what these PRs do>",
      "confidence": <0.0-1.0>,
      "relationship": "<exact_duplicate|near_duplicate|related>"
    }
  ],
  "unrelated": [<list of PR id values that are not duplicates of anything>]
}`,
    },
    {
      role: "user",
      content: `Analyze these candidate duplicate PRs and identify which are actually duplicates:\n\n${prSummaries}`,
    },
  ];
}

/**
 * Builds a prompt asking the LLM to rank PRs in a verified duplicate group
 * by code quality and completeness.
 *
 * Expected JSON response format:
 * {
 *   "rankings": [
 *     { "prNumber": number, "score": number, "codeQuality": number, "completeness": number, "rationale": string }
 *   ]
 * }
 */
export function buildRankPrompt(prs: PR[], groupLabel: string): Message[] {
  const prSummaries = prs
    .map(
      (pr) =>
        `PR #${pr.number} (id: ${pr.id}):
  Title: ${pr.title}
  Author: ${pr.author}
  Files: ${pr.filePaths.join(", ")}
  Body: ${pr.body ?? "(none)"}`
    )
    .join("\n\n");

  return [
    {
      role: "system",
      content: `You are a code review assistant that ranks duplicate pull requests by quality.
For the group labeled "${groupLabel}", rank each PR on:
- codeQuality (0-50): How well-written, clean, and maintainable the code changes appear
- completeness (0-50): How thorough the implementation is (tests, docs, edge cases)

The total score is codeQuality + completeness (0-100).

You MUST respond with valid JSON in this exact format:
{
  "rankings": [
    {
      "prNumber": <PR number>,
      "score": <total 0-100>,
      "codeQuality": <0-50>,
      "completeness": <0-50>,
      "rationale": "<brief explanation>"
    }
  ]
}

Sort rankings by score descending (best PR first).`,
    },
    {
      role: "user",
      content: `Rank these duplicate PRs by code quality and completeness:\n\n${prSummaries}`,
    },
  ];
}
