import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { requireSetup } from "./guard.js";
import { Config } from "./config.js";

describe("requireSetup", () => {
  let tempDir: string;
  let originalExit: typeof process.exit;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ossgard-guard-"));
    originalExit = process.exit;
  });

  afterEach(() => {
    process.exit = originalExit;
  });

  it("returns true when config is complete", () => {
    const config = new Config(tempDir);
    config.save({ api: { url: "http://localhost:3400", key: "test-key-123" } });

    expect(requireSetup(tempDir)).toBe(true);
  });

  it("calls process.exit(3) when config is incomplete", () => {
    let exitCode: number | undefined;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error("process.exit");
    }) as never;

    const consoleSpy = mock(() => {});
    const origError = console.error;
    console.error = consoleSpy;

    try {
      requireSetup(tempDir);
    } catch {
      // expected — process.exit throws
    }

    console.error = origError;

    expect(exitCode).toBe(3);
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("outputs JSON error when in json mode", () => {
    let exitCode: number | undefined;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error("process.exit");
    }) as never;

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;

    // Enable JSON mode
    const { setJsonMode } = require("./json-mode.js");
    setJsonMode(true);

    try {
      requireSetup(tempDir);
    } catch {
      // expected
    }

    console.log = origLog;
    setJsonMode(false);

    expect(exitCode).toBe(3);
    expect(logSpy).toHaveBeenCalled();
    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.ok).toBe(false);
    expect(output.error.code).toBe("NOT_CONFIGURED");
  });
});
