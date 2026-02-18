import type { DuplicateStrategy } from "./strategy.js";
import type { DuplicateStrategyName } from "@ossgard/shared";
import { LegacyStrategy } from "./strategies/legacy.js";
import { PairwiseLLMStrategy } from "./strategies/pairwise-llm/index.js";

const strategies = new Map<DuplicateStrategyName, DuplicateStrategy>([
  ["legacy", new LegacyStrategy()],
  ["pairwise-llm", new PairwiseLLMStrategy()],
]);

export function getStrategy(name: DuplicateStrategyName): DuplicateStrategy {
  const strategy = strategies.get(name);
  if (!strategy) throw new Error(`Unknown strategy: ${name}`);
  return strategy;
}
