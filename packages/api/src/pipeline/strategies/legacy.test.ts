import { LegacyStrategy } from "./legacy.js";
import type { StrategyContext } from "../strategy.js";
import type { Database } from "../../db/database.js";
import type { ServiceResolver } from "../../services/service-resolver.js";

// Mock all four run* functions
vi.mock("../embed.js", () => ({
  runEmbed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../cluster.js", () => ({
  runCluster: vi.fn().mockResolvedValue([
    { prNumbers: [1, 2], prIds: [10, 20] },
  ]),
}));

vi.mock("../verify.js", () => ({
  runVerify: vi.fn().mockResolvedValue({
    verifiedGroups: [
      { prIds: [10, 20], label: "Fix login bug", confidence: 0.95, relationship: "near_duplicate" },
    ],
    tokenUsage: { inputTokens: 500, outputTokens: 100 },
  }),
}));

vi.mock("../rank.js", () => ({
  runRank: vi.fn().mockResolvedValue({
    groups: [
      {
        label: "Fix login bug",
        confidence: 0.95,
        relationship: "near_duplicate",
        members: [
          { prId: 10, prNumber: 1, rank: 1, score: 85, rationale: "Well-structured code" },
          { prId: 20, prNumber: 2, rank: 2, score: 70, rationale: "Good but missing tests" },
        ],
      },
    ],
    tokenUsage: { inputTokens: 300, outputTokens: 60 },
  }),
}));

// Import mocked functions for assertions
import { runEmbed } from "../embed.js";
import { runCluster } from "../cluster.js";
import { runVerify } from "../verify.js";
import { runRank } from "../rank.js";

describe("LegacyStrategy", () => {
  let strategy: LegacyStrategy;
  let ctx: StrategyContext;

  beforeEach(() => {
    vi.clearAllMocks();

    strategy = new LegacyStrategy();
    ctx = {
      prs: [],
      scanId: 1,
      repoId: 42,
      accountId: 7,
      resolver: {} as ServiceResolver,
      db: {} as Database,
    };
  });

  it("has name 'legacy'", () => {
    expect(strategy.name).toBe("legacy");
  });

  it("calls all four phases in order", async () => {
    const callOrder: string[] = [];

    (runEmbed as any).mockImplementation(async () => {
      callOrder.push("embed");
    });
    (runCluster as any).mockImplementation(async () => {
      callOrder.push("cluster");
      return [{ prNumbers: [1, 2], prIds: [10, 20] }];
    });
    (runVerify as any).mockImplementation(async () => {
      callOrder.push("verify");
      return {
        verifiedGroups: [{ prIds: [10, 20], label: "Test", confidence: 0.9, relationship: "near_duplicate" }],
        tokenUsage: { inputTokens: 100, outputTokens: 20 },
      };
    });
    (runRank as any).mockImplementation(async () => {
      callOrder.push("rank");
      return {
        groups: [],
        tokenUsage: { inputTokens: 50, outputTokens: 10 },
      };
    });

    await strategy.execute(ctx);

    expect(callOrder).toEqual(["embed", "cluster", "verify", "rank"]);
  });

  it("passes context to runEmbed and runCluster", async () => {
    await strategy.execute(ctx);

    expect(runEmbed).toHaveBeenCalledWith(ctx);
    expect(runCluster).toHaveBeenCalledWith(ctx);
  });

  it("passes candidateGroups from runCluster to runVerify", async () => {
    const candidateGroups = [{ prNumbers: [1, 2], prIds: [10, 20] }];
    (runCluster as any).mockResolvedValue(candidateGroups);

    await strategy.execute(ctx);

    expect(runVerify).toHaveBeenCalledWith({
      ...ctx,
      candidateGroups,
    });
  });

  it("passes verifiedGroups from runVerify to runRank", async () => {
    const verifiedGroups = [
      { prIds: [10, 20], label: "Fix login bug", confidence: 0.95, relationship: "near_duplicate" },
    ];
    (runVerify as any).mockResolvedValue({
      verifiedGroups,
      tokenUsage: { inputTokens: 500, outputTokens: 100 },
    });

    await strategy.execute(ctx);

    expect(runRank).toHaveBeenCalledWith({
      ...ctx,
      verifiedGroups,
    });
  });

  it("returns StrategyResult with combined token usage from verify + rank", async () => {
    (runVerify as any).mockResolvedValue({
      verifiedGroups: [],
      tokenUsage: { inputTokens: 500, outputTokens: 100 },
    });
    (runRank as any).mockResolvedValue({
      groups: [
        {
          label: "Test Group",
          confidence: 0.9,
          relationship: "near_duplicate",
          members: [
            { prId: 10, prNumber: 1, rank: 1, score: 85, rationale: "Good" },
          ],
        },
      ],
      tokenUsage: { inputTokens: 300, outputTokens: 60 },
    });

    const result = await strategy.execute(ctx);

    expect(result.tokenUsage).toEqual({
      inputTokens: 800,
      outputTokens: 160,
    });
  });

  it("returns groups from runRank in the result", async () => {
    const expectedGroups = [
      {
        label: "Fix login bug",
        confidence: 0.95,
        relationship: "near_duplicate",
        members: [
          { prId: 10, prNumber: 1, rank: 1, score: 85, rationale: "Well-structured code" },
          { prId: 20, prNumber: 2, rank: 2, score: 70, rationale: "Good but missing tests" },
        ],
      },
    ];
    (runRank as any).mockResolvedValue({
      groups: expectedGroups,
      tokenUsage: { inputTokens: 300, outputTokens: 60 },
    });

    const result = await strategy.execute(ctx);

    expect(result.groups).toEqual(expectedGroups);
  });

  it("handles empty pipeline (no candidates, no verified groups)", async () => {
    (runCluster as any).mockResolvedValue([]);
    (runVerify as any).mockResolvedValue({
      verifiedGroups: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
    });
    (runRank as any).mockResolvedValue({
      groups: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
    });

    const result = await strategy.execute(ctx);

    expect(result.groups).toEqual([]);
    expect(result.tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});
