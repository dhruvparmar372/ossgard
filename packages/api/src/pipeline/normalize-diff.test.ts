import { describe, it, expect } from "vitest";
import { normalizeDiff, hashDiff } from "./normalize-diff.js";

const sampleDiff = `diff --git a/src/utils.ts b/src/utils.ts
index abc1234..def5678 100644
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,3 +1,4 @@
+import { foo } from 'bar';
 export function hello() {
   return 'world';
 }
diff --git a/src/index.ts b/src/index.ts
index 1111111..2222222 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -5,6 +5,7 @@
 const app = express();
+app.use(cors());
 app.listen(3000);
`;

describe("normalizeDiff", () => {
  it("strips metadata lines (index, ---, +++, @@)", () => {
    const result = normalizeDiff(sampleDiff);
    expect(result).not.toContain("index abc1234");
    expect(result).not.toContain("--- a/");
    expect(result).not.toContain("+++ b/");
    expect(result).not.toContain("@@ ");
  });

  it("sorts hunks by file path", () => {
    const result = normalizeDiff(sampleDiff);
    // src/index.ts content should come before src/utils.ts content
    const indexOfIndexTs = result.indexOf("app.use(cors());");
    const indexOfUtilsTs = result.indexOf("import { foo }");
    expect(indexOfIndexTs).toBeLessThan(indexOfUtilsTs);
  });

  it("trims whitespace from content lines", () => {
    const diffWithWhitespace = `diff --git a/file.ts b/file.ts
index abc..def 100644
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,4 @@
  +added line with leading spaces
   existing line
`;
    const result = normalizeDiff(diffWithWhitespace);
    // Lines should be trimmed
    const lines = result.split("\n");
    for (const line of lines) {
      expect(line).toBe(line.trim());
    }
  });

  it("preserves actual code content", () => {
    const result = normalizeDiff(sampleDiff);
    expect(result).toContain("import { foo } from 'bar';");
    expect(result).toContain("export function hello()");
    expect(result).toContain("app.use(cors());");
  });

  it("handles empty diff", () => {
    const result = normalizeDiff("");
    expect(result).toBe("");
  });
});

describe("hashDiff", () => {
  it("produces same hash for equivalent diffs", () => {
    // Same content but hunks in different order
    const diff1 = `diff --git a/b.ts b/b.ts
index abc..def 100644
--- a/b.ts
+++ b/b.ts
@@ -1,1 +1,2 @@
+second file change
diff --git a/a.ts b/a.ts
index 111..222 100644
--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,2 @@
+first file change
`;

    const diff2 = `diff --git a/a.ts b/a.ts
index 111..222 100644
--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,2 @@
+first file change
diff --git a/b.ts b/b.ts
index abc..def 100644
--- a/b.ts
+++ b/b.ts
@@ -1,1 +1,2 @@
+second file change
`;

    expect(hashDiff(diff1)).toBe(hashDiff(diff2));
  });

  it("produces different hash for different diffs", () => {
    const diff1 = `diff --git a/file.ts b/file.ts
index abc..def 100644
--- a/file.ts
+++ b/file.ts
@@ -1,1 +1,2 @@
+added line A
`;

    const diff2 = `diff --git a/file.ts b/file.ts
index abc..def 100644
--- a/file.ts
+++ b/file.ts
@@ -1,1 +1,2 @@
+added line B
`;

    expect(hashDiff(diff1)).not.toBe(hashDiff(diff2));
  });

  it("returns a 64-character hex string (SHA-256)", () => {
    const hash = hashDiff(sampleDiff);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces same hash regardless of metadata differences", () => {
    const diff1 = `diff --git a/file.ts b/file.ts
index abc1234..def5678 100644
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,4 @@
+new line
`;

    const diff2 = `diff --git a/file.ts b/file.ts
index 9999999..0000000 100644
--- a/file.ts
+++ b/file.ts
@@ -10,20 +10,21 @@
+new line
`;

    expect(hashDiff(diff1)).toBe(hashDiff(diff2));
  });
});
