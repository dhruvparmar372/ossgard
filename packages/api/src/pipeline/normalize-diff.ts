import { createHash } from "node:crypto";

/**
 * Normalize a unified diff for consistent comparison:
 * - Split by `diff --git` into per-file hunks
 * - Sort hunks by file path
 * - Strip metadata lines (index, ---, +++, @@)
 * - Trim whitespace from content lines
 */
export function normalizeDiff(raw: string): string {
  // Split into hunks at "diff --git" boundaries
  const parts = raw.split(/^diff --git /m).filter((part) => part.trim() !== "");

  const hunks = parts.map((part) => {
    // Extract file path from the first line: "a/path b/path"
    const firstLineEnd = part.indexOf("\n");
    const firstLine = firstLineEnd === -1 ? part : part.slice(0, firstLineEnd);
    // Extract the b/path (destination file path)
    const bPathMatch = firstLine.match(/\sb\/(.+)$/);
    const filePath = bPathMatch ? bPathMatch[1] : firstLine.trim();

    // Get the remaining lines after the first line
    const lines = firstLineEnd === -1 ? [] : part.slice(firstLineEnd + 1).split("\n");

    // Filter out metadata lines and trim content lines
    const contentLines = lines
      .filter((line) => {
        // Strip index lines (e.g., "index abc..def 100644")
        if (line.startsWith("index ")) return false;
        // Strip --- lines
        if (line.startsWith("--- ")) return false;
        // Strip +++ lines
        if (line.startsWith("+++ ")) return false;
        // Strip @@ hunk headers
        if (line.startsWith("@@ ")) return false;
        return true;
      })
      .map((line) => line.trim())
      .filter((line) => line !== "");

    return { filePath, content: contentLines.join("\n") };
  });

  // Sort by file path
  hunks.sort((a, b) => a.filePath.localeCompare(b.filePath));

  return hunks.map((h) => h.content).join("\n");
}

/**
 * Compute a SHA-256 hash of a normalized diff.
 */
export function hashDiff(diff: string): string {
  const normalized = normalizeDiff(diff);
  return createHash("sha256").update(normalized).digest("hex");
}
