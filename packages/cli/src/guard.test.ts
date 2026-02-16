import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { requireSetup } from "./guard.js";
import { Config } from "./config.js";

describe("requireSetup", () => {
  let tempDir: string;
  let originalExitCode: number | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ossgard-guard-"));
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it("returns true when config is complete", () => {
    const config = new Config(tempDir);
    config.save({ api: { url: "http://localhost:3400", key: "test-key-123" } });

    expect(requireSetup(tempDir)).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("returns false and sets exitCode when config is incomplete", () => {
    const consoleSpy = mock(() => {});
    const origError = console.error;
    console.error = consoleSpy;

    const result = requireSetup(tempDir);

    console.error = origError;
    // Capture before resetting — reset to 0 so bun doesn't exit non-zero
    const exitCode = process.exitCode;
    process.exitCode = 0;

    expect(result).toBe(false);
    expect(exitCode).toBe(1);
    expect(consoleSpy).toHaveBeenCalled();
  });
});
