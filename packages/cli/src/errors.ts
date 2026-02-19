import { globalJsonMode } from "./json-mode.js";

export type ErrorCode =
  | "NOT_CONFIGURED"
  | "API_UNREACHABLE"
  | "AUTH_FAILED"
  | "NOT_FOUND"
  | "SCAN_FAILED"
  | "INVALID_INPUT"
  | "SERVER_ERROR";

export function exitWithError(
  code: ErrorCode,
  message: string,
  opts?: { suggestion?: string; exitCode?: number }
): never {
  const exitCode = opts?.exitCode ?? 1;
  if (globalJsonMode()) {
    const error: Record<string, string> = { code, message };
    if (opts?.suggestion) error.suggestion = opts.suggestion;
    console.log(JSON.stringify({ ok: false, error }));
  } else {
    console.error(message);
    if (opts?.suggestion) console.error(`Hint: ${opts.suggestion}`);
  }
  process.exit(exitCode);
}
