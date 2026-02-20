import type { PR } from "@ossgard/shared";
import { createHash } from "crypto";

export const CODE_COLLECTION = "ossgard-code";
export const INTENT_COLLECTION = "ossgard-intent";

/** Compute a stable hash for a PR's embedding-relevant fields. */
export function computeEmbedHash(pr: Pick<PR, "diffHash" | "title" | "body" | "filePaths">): string {
  const input = `${pr.diffHash ?? ""}|${pr.title}|${pr.body ?? ""}|${JSON.stringify(pr.filePaths)}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function buildCodeInput(
  filePaths: string[],
  tokenBudget: number,
  countTokens: (text: string) => number,
  fallbackTitle: string
): string {
  const result = joinWithinTokenBudget(filePaths, tokenBudget, countTokens);
  return result || fallbackTitle || "(no files)";
}

/**
 * Build intent embedding input with prioritized content:
 * title + body are always included (highest semantic signal), then
 * file paths fill remaining budget.
 */
export function buildIntentInput(
  title: string,
  body: string | null,
  filePaths: string[],
  tokenBudget: number,
  countTokens: (text: string) => number
): string {
  const header = title + "\n" + (body ?? "");
  const headerTokens = countTokens(header);
  if (headerTokens >= tokenBudget) {
    const charLimit = Math.floor((tokenBudget / headerTokens) * header.length);
    return header.slice(0, charLimit);
  }
  const remaining = tokenBudget - headerTokens - 1;
  const pathsPart = joinWithinTokenBudget(filePaths, remaining, countTokens);
  return pathsPart ? header + "\n" + pathsPart : header;
}

/** Join strings with newlines until the token budget is exhausted. */
function joinWithinTokenBudget(
  items: string[],
  budget: number,
  countTokens: (text: string) => number
): string {
  const parts: string[] = [];
  let usedTokens = 0;
  for (const item of items) {
    const itemTokens = countTokens(item) + (parts.length > 0 ? 1 : 0);
    if (usedTokens + itemTokens > budget) break;
    parts.push(item);
    usedTokens += itemTokens;
  }
  return parts.join("\n");
}
