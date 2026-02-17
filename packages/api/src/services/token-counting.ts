import { getEncoding, encodingForModel, type Tiktoken } from "js-tiktoken";

export { type Tiktoken };
export const TOKEN_BUDGET_FACTOR = 0.95;

export function createTiktokenEncoder(model: string): Tiktoken {
  try {
    return encodingForModel(model as Parameters<typeof encodingForModel>[0]);
  } catch {
    return getEncoding("cl100k_base");
  }
}

export function countTokensTiktoken(encoder: Tiktoken, text: string): number {
  return encoder.encode(text).length;
}

export function countTokensHeuristic(text: string, charsPerToken: number): number {
  return Math.ceil(text.length / charsPerToken);
}
