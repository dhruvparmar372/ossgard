import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Format a number with commas: 2942670 → "2,942,670" */
export function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}

/** Format USD: 0.087 → "$0.09", 1.234 → "$1.23" */
export function formatCost(usd: number): string {
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

// Pricing per million tokens (as of Feb 2026)
const MODEL_PRICING: Record<string, { input: number; output?: number }> = {
  "gpt-5-nano":               { input: 0.05, output: 0.40 },
  "text-embedding-3-small":   { input: 0.02 },
  "text-embedding-3-large":   { input: 0.13 },
};

/** Estimate cost for a given token count and model */
export function estimateTokenCost(
  inputTokens: number,
  outputTokens: number,
  model: string | null
): number {
  const pricing = model ? MODEL_PRICING[model] : undefined;
  if (!pricing) return 0;
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = pricing.output ? (outputTokens / 1_000_000) * pricing.output : 0;
  return inputCost + outputCost;
}
