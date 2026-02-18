import type { PairwiseResult } from "./pairwise-verifier.js";

export interface ConfirmedEdge {
  prA: number;
  prB: number;
  result: PairwiseResult;
}

export interface CliqueGroup {
  members: number[];
  avgConfidence: number;
  relationship: string;
}

/**
 * Groups PRs into cliques where every member is a confirmed duplicate
 * of every other member. Uses greedy clique building from highest
 * confidence edges. NO transitivity — if A-C was not confirmed,
 * they will not be in the same group.
 */
export class CliqueGrouper {
  group(edges: ConfirmedEdge[]): CliqueGroup[] {
    // Filter to only confirmed duplicate edges
    const confirmed = edges.filter((e) => e.result.isDuplicate);
    if (confirmed.length === 0) return [];

    // Sort by confidence descending
    confirmed.sort((a, b) => b.result.confidence - a.result.confidence);

    // Build adjacency set for fast lookup
    const adj = new Map<number, Set<number>>();
    const edgeMap = new Map<string, ConfirmedEdge>();
    for (const edge of confirmed) {
      if (!adj.has(edge.prA)) adj.set(edge.prA, new Set());
      if (!adj.has(edge.prB)) adj.set(edge.prB, new Set());
      adj.get(edge.prA)!.add(edge.prB);
      adj.get(edge.prB)!.add(edge.prA);
      const key = edge.prA < edge.prB ? `${edge.prA}-${edge.prB}` : `${edge.prB}-${edge.prA}`;
      edgeMap.set(key, edge);
    }

    // Greedy clique building
    const used = new Set<number>();
    const groups: CliqueGroup[] = [];

    for (const edge of confirmed) {
      if (used.has(edge.prA) || used.has(edge.prB)) continue;

      // Start a clique with this edge
      const clique = [edge.prA, edge.prB];
      used.add(edge.prA);
      used.add(edge.prB);

      // Try to expand: for each unused neighbor, check if it's connected to ALL current clique members
      const candidates = new Set<number>();
      for (const member of clique) {
        for (const neighbor of adj.get(member) ?? []) {
          if (!used.has(neighbor)) candidates.add(neighbor);
        }
      }

      for (const candidate of candidates) {
        const connectedToAll = clique.every((member) => {
          const neighbors = adj.get(member);
          return neighbors?.has(candidate) ?? false;
        });
        if (connectedToAll) {
          clique.push(candidate);
          used.add(candidate);
        }
      }

      if (clique.length >= 2) {
        // Compute average confidence across all edges in the clique
        let totalConf = 0;
        let edgeCount = 0;
        for (let i = 0; i < clique.length; i++) {
          for (let j = i + 1; j < clique.length; j++) {
            const a = Math.min(clique[i], clique[j]);
            const b = Math.max(clique[i], clique[j]);
            const e = edgeMap.get(`${a}-${b}`);
            if (e) {
              totalConf += e.result.confidence;
              edgeCount++;
            }
          }
        }

        groups.push({
          members: clique.sort((a, b) => a - b),
          avgConfidence: edgeCount > 0 ? totalConf / edgeCount : 0,
          relationship: edge.result.relationship,
        });
      }
    }

    return groups;
  }
}
