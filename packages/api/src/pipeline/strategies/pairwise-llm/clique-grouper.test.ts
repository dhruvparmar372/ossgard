import { CliqueGrouper } from "./clique-grouper.js";
import type { ConfirmedEdge } from "./clique-grouper.js";

function edge(prA: number, prB: number, isDuplicate: boolean, confidence = 0.9): ConfirmedEdge {
  return {
    prA,
    prB,
    result: {
      isDuplicate,
      confidence,
      relationship: isDuplicate ? "near_duplicate" : "unrelated",
      rationale: "",
    },
  };
}

describe("CliqueGrouper", () => {
  let grouper: CliqueGrouper;

  beforeEach(() => {
    grouper = new CliqueGrouper();
  });

  it("groups PRs that are all mutually confirmed duplicates", () => {
    // A-B, B-C, A-C all confirmed => single group {A, B, C}
    const edges = [
      edge(1, 2, true, 0.9),
      edge(2, 3, true, 0.85),
      edge(1, 3, true, 0.88),
    ];

    const groups = grouper.group(edges);

    expect(groups).toHaveLength(1);
    expect(groups[0].members).toEqual([1, 2, 3]);
  });

  it("does NOT group transitively — missing edge means separate groups", () => {
    // A-B confirmed, B-C confirmed, NO A-C edge
    // PRs 1 and 3 must NOT be in the same group
    const edges = [
      edge(1, 2, true, 0.9),
      edge(2, 3, true, 0.85),
      // No edge(1, 3) — this is the key invariant
    ];

    const groups = grouper.group(edges);

    // 1 and 3 must NOT be in the same group
    for (const group of groups) {
      const has1 = group.members.includes(1);
      const has3 = group.members.includes(3);
      expect(has1 && has3).toBe(false);
    }

    // We should have exactly 1 group (the first edge seeds {1,2}, then PR 3 can't join
    // because it's not connected to PR 1; and PR 2 is already used so {2,3} can't form)
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toEqual([1, 2]);
  });

  it("does NOT group transitively — even with a long chain", () => {
    // Chain: 1-2, 2-3, 3-4 — no direct edges for 1-3, 1-4, 2-4
    const edges = [
      edge(1, 2, true, 0.9),
      edge(2, 3, true, 0.85),
      edge(3, 4, true, 0.8),
    ];

    const groups = grouper.group(edges);

    // No group should contain both 1 and 3, or 1 and 4, or 2 and 4
    for (const group of groups) {
      const members = new Set(group.members);
      if (members.has(1)) {
        expect(members.has(3)).toBe(false);
        expect(members.has(4)).toBe(false);
      }
      if (members.has(2)) {
        expect(members.has(4)).toBe(false);
      }
    }
  });

  it("returns empty for no confirmed edges", () => {
    // Only isDuplicate=false edges
    const edges = [
      edge(1, 2, false, 0.1),
      edge(3, 4, false, 0.2),
    ];

    const groups = grouper.group(edges);

    expect(groups).toEqual([]);
  });

  it("returns empty for empty input", () => {
    const groups = grouper.group([]);

    expect(groups).toEqual([]);
  });

  it("handles multiple independent cliques", () => {
    // {1,2} and {3,4} confirmed separately
    const edges = [
      edge(1, 2, true, 0.9),
      edge(3, 4, true, 0.85),
    ];

    const groups = grouper.group(edges);

    expect(groups).toHaveLength(2);

    const allMembers = groups.flatMap((g) => g.members);
    expect(allMembers.sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);

    // Verify each group has exactly 2 members
    for (const group of groups) {
      expect(group.members).toHaveLength(2);
    }
  });

  it("computes average confidence", () => {
    // Three edges forming a triangle with different confidences
    const edges = [
      edge(1, 2, true, 0.9),
      edge(2, 3, true, 0.8),
      edge(1, 3, true, 0.7),
    ];

    const groups = grouper.group(edges);

    expect(groups).toHaveLength(1);
    // Average of 0.9, 0.8, 0.7 = 0.8
    expect(groups[0].avgConfidence).toBeCloseTo(0.8, 5);
  });

  it("greedy picks highest confidence first", () => {
    // Edge 3-4 has highest confidence so it seeds first
    // Edge 1-2 seeds second
    const edges = [
      edge(1, 2, true, 0.7),
      edge(3, 4, true, 0.95),
    ];

    const groups = grouper.group(edges);

    expect(groups).toHaveLength(2);

    // The first group should be [3,4] since it had the highest confidence edge
    expect(groups[0].members).toEqual([3, 4]);
    expect(groups[0].avgConfidence).toBeCloseTo(0.95, 5);

    expect(groups[1].members).toEqual([1, 2]);
    expect(groups[1].avgConfidence).toBeCloseTo(0.7, 5);
  });

  it("handles single edge (pair)", () => {
    const edges = [edge(5, 10, true, 0.92)];

    const groups = grouper.group(edges);

    expect(groups).toHaveLength(1);
    expect(groups[0].members).toEqual([5, 10]);
    expect(groups[0].avgConfidence).toBeCloseTo(0.92, 5);
    expect(groups[0].relationship).toBe("near_duplicate");
  });

  it("ignores non-duplicate edges when building cliques", () => {
    // Mix of duplicate and non-duplicate edges
    const edges = [
      edge(1, 2, true, 0.9),
      edge(1, 3, false, 0.1),  // not a duplicate
      edge(2, 3, true, 0.85),
      edge(1, 3, true, 0.88),  // this one IS a duplicate (overrides previous non-dup for same pair)
    ];

    // The non-duplicate edge should be filtered out
    const groups = grouper.group(edges);

    expect(groups).toHaveLength(1);
    expect(groups[0].members).toEqual([1, 2, 3]);
  });

  it("uses the relationship from the seed edge", () => {
    const edges: ConfirmedEdge[] = [
      {
        prA: 1,
        prB: 2,
        result: {
          isDuplicate: true,
          confidence: 0.95,
          relationship: "exact_duplicate",
          rationale: "Identical changes",
        },
      },
    ];

    const groups = grouper.group(edges);

    expect(groups).toHaveLength(1);
    expect(groups[0].relationship).toBe("exact_duplicate");
  });

  it("handles a 4-node complete graph (K4 clique)", () => {
    // All 6 edges of a K4 graph
    const edges = [
      edge(1, 2, true, 0.9),
      edge(1, 3, true, 0.85),
      edge(1, 4, true, 0.88),
      edge(2, 3, true, 0.92),
      edge(2, 4, true, 0.87),
      edge(3, 4, true, 0.91),
    ];

    const groups = grouper.group(edges);

    expect(groups).toHaveLength(1);
    expect(groups[0].members).toEqual([1, 2, 3, 4]);
    // Average of all 6 confidences: (0.9+0.85+0.88+0.92+0.87+0.91)/6
    const expectedAvg = (0.9 + 0.85 + 0.88 + 0.92 + 0.87 + 0.91) / 6;
    expect(groups[0].avgConfidence).toBeCloseTo(expectedAvg, 5);
  });

  it("a node missing one edge to the clique stays out", () => {
    // Triangle {1,2,3} plus node 4 connected to 1 and 2 but NOT 3
    const edges = [
      edge(1, 2, true, 0.9),
      edge(2, 3, true, 0.85),
      edge(1, 3, true, 0.88),
      edge(1, 4, true, 0.8),
      edge(2, 4, true, 0.82),
      // No edge(3, 4) — so 4 can't join the {1,2,3} clique
    ];

    const groups = grouper.group(edges);

    // The triangle {1,2,3} should form first (highest confidence edge 1-2 seeds it)
    // Node 4 is connected to 1 and 2 but not 3, so it can't join
    // After the clique {1,2,3} is formed, node 4 is unused but has no unused partner
    const triangleGroup = groups.find((g) => g.members.length === 3);
    expect(triangleGroup).toBeDefined();
    expect(triangleGroup!.members).toEqual([1, 2, 3]);

    // Node 4 should NOT be in the triangle group
    expect(triangleGroup!.members.includes(4)).toBe(false);
  });
});
