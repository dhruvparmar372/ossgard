export class UnionFind<T> {
  private parent = new Map<T, T>();
  private rank = new Map<T, number>();

  add(x: T): void {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
    }
  }

  find(x: T): T {
    if (!this.parent.has(x)) {
      throw new Error(`Element not found in UnionFind: ${x}`);
    }

    let root = x;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }

    // Path compression
    let current = x;
    while (current !== root) {
      const next = this.parent.get(current)!;
      this.parent.set(current, root);
      current = next;
    }

    return root;
  }

  union(a: T, b: T): void {
    const rootA = this.find(a);
    const rootB = this.find(b);

    if (rootA === rootB) return;

    const rankA = this.rank.get(rootA)!;
    const rankB = this.rank.get(rootB)!;

    // Union by rank
    if (rankA < rankB) {
      this.parent.set(rootA, rootB);
    } else if (rankA > rankB) {
      this.parent.set(rootB, rootA);
    } else {
      this.parent.set(rootB, rootA);
      this.rank.set(rootA, rankA + 1);
    }
  }

  connected(a: T, b: T): boolean {
    return this.find(a) === this.find(b);
  }

  getGroups(minSize?: number): T[][] {
    const groups = new Map<T, T[]>();

    for (const element of this.parent.keys()) {
      const root = this.find(element);
      if (!groups.has(root)) {
        groups.set(root, []);
      }
      groups.get(root)!.push(element);
    }

    const result = Array.from(groups.values());

    if (minSize !== undefined) {
      return result.filter((group) => group.length >= minSize);
    }

    return result;
  }
}
