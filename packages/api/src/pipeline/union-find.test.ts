import { describe, it, expect } from "vitest";
import { UnionFind } from "./union-find.js";

describe("UnionFind", () => {
  it("keeps elements isolated initially", () => {
    const uf = new UnionFind<number>();
    uf.add(1);
    uf.add(2);
    uf.add(3);

    expect(uf.connected(1, 2)).toBe(false);
    expect(uf.connected(2, 3)).toBe(false);
    expect(uf.connected(1, 3)).toBe(false);
  });

  it("unions two elements", () => {
    const uf = new UnionFind<number>();
    uf.add(1);
    uf.add(2);

    uf.union(1, 2);

    expect(uf.connected(1, 2)).toBe(true);
  });

  it("supports transitive unions", () => {
    const uf = new UnionFind<number>();
    uf.add(1);
    uf.add(2);
    uf.add(3);

    uf.union(1, 2);
    uf.union(2, 3);

    expect(uf.connected(1, 3)).toBe(true);
  });

  it("keeps separate groups distinct", () => {
    const uf = new UnionFind<number>();
    uf.add(1);
    uf.add(2);
    uf.add(3);
    uf.add(4);

    uf.union(1, 2);
    uf.union(3, 4);

    expect(uf.connected(1, 2)).toBe(true);
    expect(uf.connected(3, 4)).toBe(true);
    expect(uf.connected(1, 3)).toBe(false);
    expect(uf.connected(2, 4)).toBe(false);
  });

  it("find returns the root representative", () => {
    const uf = new UnionFind<string>();
    uf.add("a");
    uf.add("b");
    uf.add("c");

    uf.union("a", "b");
    uf.union("b", "c");

    const root = uf.find("a");
    expect(uf.find("b")).toBe(root);
    expect(uf.find("c")).toBe(root);
  });

  it("find throws for unknown element", () => {
    const uf = new UnionFind<number>();

    expect(() => uf.find(99)).toThrow("Element not found in UnionFind: 99");
  });

  it("getGroups returns all groups", () => {
    const uf = new UnionFind<number>();
    uf.add(1);
    uf.add(2);
    uf.add(3);
    uf.add(4);
    uf.add(5);

    uf.union(1, 2);
    uf.union(3, 4);

    const groups = uf.getGroups();
    expect(groups).toHaveLength(3); // {1,2}, {3,4}, {5}

    // Verify group contents (order may vary)
    const sorted = groups.map((g) => g.sort()).sort((a, b) => a[0] - b[0]);
    expect(sorted).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("getGroups with minSize filters small groups", () => {
    const uf = new UnionFind<number>();
    uf.add(1);
    uf.add(2);
    uf.add(3);
    uf.add(4);
    uf.add(5);

    uf.union(1, 2);
    uf.union(3, 4);

    const groups = uf.getGroups(2);
    expect(groups).toHaveLength(2); // only {1,2} and {3,4}
    expect(groups.every((g) => g.length >= 2)).toBe(true);
  });

  it("getGroups(3) returns only groups with 3+ members", () => {
    const uf = new UnionFind<number>();
    uf.add(1);
    uf.add(2);
    uf.add(3);
    uf.add(4);
    uf.add(5);

    uf.union(1, 2);
    uf.union(2, 3);
    uf.union(4, 5);

    const groups = uf.getGroups(3);
    expect(groups).toHaveLength(1);
    expect(groups[0].sort()).toEqual([1, 2, 3]);
  });

  it("handles large graph (1000 elements)", () => {
    const uf = new UnionFind<number>();

    for (let i = 0; i < 1000; i++) {
      uf.add(i);
    }

    // Create 10 groups of 100 each
    for (let group = 0; group < 10; group++) {
      const base = group * 100;
      for (let i = 1; i < 100; i++) {
        uf.union(base, base + i);
      }
    }

    const groups = uf.getGroups(2);
    expect(groups).toHaveLength(10);
    expect(groups.every((g) => g.length === 100)).toBe(true);

    // Verify elements in different groups are not connected
    expect(uf.connected(0, 100)).toBe(false);
    expect(uf.connected(0, 99)).toBe(true);
    expect(uf.connected(100, 199)).toBe(true);
  });

  it("union is idempotent", () => {
    const uf = new UnionFind<number>();
    uf.add(1);
    uf.add(2);

    uf.union(1, 2);
    uf.union(1, 2); // second union should be a no-op
    uf.union(2, 1); // reverse should also be a no-op

    const groups = uf.getGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].sort()).toEqual([1, 2]);
  });

  it("works with string elements", () => {
    const uf = new UnionFind<string>();
    uf.add("pr-1");
    uf.add("pr-2");
    uf.add("pr-3");

    uf.union("pr-1", "pr-2");

    expect(uf.connected("pr-1", "pr-2")).toBe(true);
    expect(uf.connected("pr-1", "pr-3")).toBe(false);

    const groups = uf.getGroups(2);
    expect(groups).toHaveLength(1);
    expect(groups[0].sort()).toEqual(["pr-1", "pr-2"]);
  });
});
