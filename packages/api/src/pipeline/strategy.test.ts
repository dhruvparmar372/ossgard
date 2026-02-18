import type { DuplicateStrategy, StrategyContext, StrategyResult } from "./strategy.js";

describe("DuplicateStrategy interface", () => {
  it("can be implemented with required fields", () => {
    const strategy: DuplicateStrategy = {
      name: "legacy",
      async execute(_ctx: StrategyContext): Promise<StrategyResult> {
        return { groups: [], tokenUsage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    expect(strategy.name).toBe("legacy");
  });
});
