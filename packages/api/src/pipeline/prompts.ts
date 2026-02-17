import type { PR } from "@ossgard/shared";
import type { Message } from "../services/llm-provider.js";

export interface TokenCounter {
  countTokens(text: string): number;
  maxContextTokens: number;
}

const OUTPUT_TOKEN_RESERVE = 4096;
const TRUNCATED_BODY_CHARS = 500;
const TRUNCATED_FILE_COUNT = 20;

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
export function buildVerifyPrompt(prs: PR[], tokenCounter?: TokenCounter): Message[] {
  const systemContent = `You are a code review assistant that identifies duplicate or closely related pull requests.
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
}`;

  const userPreamble = "Analyze these candidate duplicate PRs and identify which are actually duplicates:\n\n";

  const prSummaries = buildPRSummaries(prs, systemContent, userPreamble, tokenCounter, true);

  return [
    { role: "system", content: systemContent },
    { role: "user", content: userPreamble + prSummaries },
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
export function buildRankPrompt(prs: PR[], groupLabel: string, tokenCounter?: TokenCounter): Message[] {
  const systemContent = `You are a code review assistant that ranks duplicate pull requests by quality.
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

Sort rankings by score descending (best PR first).`;

  const userPreamble = "Rank these duplicate PRs by code quality and completeness:\n\n";

  const prSummaries = buildPRSummaries(prs, systemContent, userPreamble, tokenCounter, false);

  return [
    { role: "system", content: systemContent },
    { role: "user", content: userPreamble + prSummaries },
  ];
}

function buildPRSummaries(
  prs: PR[],
  systemContent: string,
  userPreamble: string,
  tokenCounter: TokenCounter | undefined,
  includeDiffHash: boolean
): string {
  // Without token counter, use full summaries (backward compat)
  if (!tokenCounter) {
    return prs.map((pr) => formatPRSummary(pr, includeDiffHash)).join("\n\n");
  }

  const overheadTokens =
    tokenCounter.countTokens(systemContent) +
    tokenCounter.countTokens(userPreamble) +
    OUTPUT_TOKEN_RESERVE;

  const budget = tokenCounter.maxContextTokens - overheadTokens;

  // First try full summaries
  const fullSummaries = prs.map((pr) => formatPRSummary(pr, includeDiffHash));
  const fullText = fullSummaries.join("\n\n");
  if (tokenCounter.countTokens(fullText) <= budget) {
    return fullText;
  }

  // Truncate: limit body to 500 chars and files to 20
  const truncatedSummaries = prs.map((pr) =>
    formatPRSummary(pr, includeDiffHash, TRUNCATED_BODY_CHARS, TRUNCATED_FILE_COUNT)
  );
  return truncatedSummaries.join("\n\n");
}

function formatPRSummary(
  pr: PR,
  includeDiffHash: boolean,
  maxBodyChars?: number,
  maxFiles?: number
): string {
  const files = maxFiles && pr.filePaths.length > maxFiles
    ? pr.filePaths.slice(0, maxFiles).join(", ") + `, ... (+${pr.filePaths.length - maxFiles} more)`
    : pr.filePaths.join(", ");

  let body = pr.body ?? "(none)";
  if (maxBodyChars && body.length > maxBodyChars) {
    body = body.slice(0, maxBodyChars) + "...";
  }

  let summary = `PR #${pr.number} (id: ${pr.id}):
  Title: ${pr.title}
  Author: ${pr.author}
  Files: ${files}
  Body: ${body}`;

  if (includeDiffHash) {
    summary += `\n  DiffHash: ${pr.diffHash ?? "(none)"}`;
  }

  return summary;
}
