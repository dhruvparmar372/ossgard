# CLI Agent-Friendliness Improvements

Make the ossgard CLI easy for coding agents (e.g. Claude Code) to discover, invoke, and parse programmatically.

## Current Problems

1. **No discovery mechanism** — an agent must read `--help` and parse human-readable text to learn what commands exist and what arguments they take
2. **Interactive prompts block agents** — `duplicates` opens a readline prompt ("Review duplicate groups? (Y/n)") that hangs a non-TTY caller; `clean` prompts for scope selection and confirmation with no way to skip except `--force`
3. **Error output is unstructured** — errors are `console.error(string)`, so an agent can't distinguish error types or extract actionable suggestions
4. **Exit codes are binary** — everything is 0 or 1, no way to distinguish "not configured" from "API unreachable" from "scan failed"
5. **No progress streaming in JSON mode** — `scan --json` prints a full JSON object per status change but they're separate `console.log` calls with no newline-delimited protocol; an agent can't reliably parse the stream
6. **Commands lack usage examples** — `--help` shows flags but no concrete invocations

## Changes

### 1. Machine-readable command discovery (`ossgard --commands`)

**File:** `packages/cli/src/index.ts`

Add a hidden `--commands` flag to the root program that outputs a JSON array describing every registered command:

```typescript
program
  .option("--commands", "List all commands as JSON (for tooling)")
  .on("option:commands", () => {
    const commands = program.commands.map((cmd) => ({
      name: cmd.name(),
      description: cmd.description(),
      arguments: cmd.registeredArguments.map((a) => ({
        name: a.name(),
        description: a.description,
        required: a.required,
      })),
      options: cmd.options
        .filter((o) => !o.hidden)
        .map((o) => ({
          flags: o.flags,
          description: o.description,
          required: o.required,
          defaultValue: o.defaultValue,
        })),
    }));
    console.log(JSON.stringify(commands, null, 2));
    process.exit(0);
  });
```

Output example:
```json
[
  {
    "name": "scan",
    "description": "Start a duplicate scan for a repository",
    "arguments": [{"name": "owner/repo", "description": "Repository slug (e.g. facebook/react)", "required": true}],
    "options": [
      {"flags": "--full", "description": "Run a full scan (re-scan everything)", "required": false},
      {"flags": "--limit <count>", "description": "Maximum number of PRs to ingest", "required": false},
      {"flags": "--no-wait", "description": "Don't wait for scan to complete", "required": false},
      {"flags": "--json", "description": "Output as JSON", "required": false}
    ]
  }
]
```

An agent runs `ossgard --commands` once to build a tool schema for all available commands.

### 2. Non-interactive mode (TTY detection + `--no-interactive`)

**Files:** `packages/cli/src/commands/duplicates.ts`, `packages/cli/src/commands/clean.ts`

**Rule:** When stdout is not a TTY (`!process.stdout.isTTY`) or `--no-interactive` is passed, skip all interactive prompts and print all output directly.

Changes per command:

**`duplicates.ts`**:
- When non-interactive: skip the "Review duplicate groups?" prompt and print all groups immediately
- The readline-based pagination loop becomes a single sequential dump

**`clean.ts`**:
- When non-interactive and `--force` is not set: exit with error code 2 and message `"Confirmation required. Use --force to skip."` instead of hanging on a readline prompt
- When non-interactive and no scope flag given: exit with error code 2 and message `"Specify one of --scans, --repos, or --all."` instead of opening interactive scope picker
- When `--force` is set: proceed as today (no change)

**`index.ts`**:
- Add global `--no-interactive` option on the root program
- Pass it through to commands via `program.opts().noInteractive`

### 3. Structured JSON errors

**File:** `packages/cli/src/client.ts`

Wrap API errors in a consistent JSON envelope when `--json` is active:

```json
{
  "ok": false,
  "error": {
    "code": "NOT_CONFIGURED",
    "message": "ossgard is not configured. Run \"ossgard setup\" first.",
    "suggestion": "ossgard setup"
  }
}
```

Error codes:

| Code | Meaning |
|------|---------|
| `NOT_CONFIGURED` | Setup hasn't been run |
| `API_UNREACHABLE` | Can't connect to ossgard-api |
| `AUTH_FAILED` | API key rejected (401) |
| `NOT_FOUND` | Repo/scan/PR not found (404) |
| `SCAN_FAILED` | Scan completed with error |
| `INVALID_INPUT` | Bad arguments or flags |
| `SERVER_ERROR` | 5xx from API |

**Implementation:**

Create `packages/cli/src/errors.ts`:
```typescript
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
  suggestion?: string,
  exitCode: number = 1
): never {
  if (globalJsonMode()) {
    console.log(JSON.stringify({ ok: false, error: { code, message, suggestion } }));
  } else {
    console.error(message);
    if (suggestion) console.error(`Hint: ${suggestion}`);
  }
  process.exit(exitCode);
}
```

Update `guard.ts` and each command's catch blocks to use `exitWithError` instead of raw `console.error`.

### 4. Meaningful exit codes

Standardize across all commands:

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error (scan failed, API error, etc.) |
| 2 | Usage error (bad arguments, missing required flags, confirmation required but not given) |
| 3 | Not configured (setup not run) |
| 4 | API unreachable (connection refused / timeout) |

**Files:** `packages/cli/src/guard.ts`, all command files.

- `guard.ts`: change `process.exitCode = 1` to `process.exitCode = 3`
- Connection errors: `process.exitCode = 4`
- Bad arguments: `process.exitCode = 2`

### 5. JSONL progress streaming for scans

**File:** `packages/cli/src/commands/scan.ts`

When `--json` is passed with a waiting scan, emit one JSON object per line (JSONL) instead of pretty-printed JSON:

```jsonl
{"event":"started","scanId":42,"status":"queued"}
{"event":"progress","scanId":42,"status":"ingesting","prCount":45}
{"event":"progress","scanId":42,"status":"embedding","prCount":87}
{"event":"progress","scanId":42,"status":"verifying","prCount":87}
{"event":"progress","scanId":42,"status":"ranking","prCount":87,"dupeGroupCount":5}
{"event":"done","scanId":42,"status":"done","prCount":87,"dupeGroupCount":8}
```

Each line is a self-contained JSON object. An agent reads line-by-line and parses each independently.

Changes:
- Replace `console.log(JSON.stringify(scan))` with `console.log(JSON.stringify({ event: "progress", scanId: scan.id, status: scan.status, prCount: scan.prCount, dupeGroupCount: scan.dupeGroupCount }))`
- Add `event: "started"` on initial dispatch
- Add `event: "done"` or `event: "failed"` on terminal states

### 6. Usage examples in help text

**Files:** all command files in `packages/cli/src/commands/`

Commander supports `.addHelpText("after", ...)`. Add examples to every command:

```typescript
.addHelpText("after", `
Examples:
  $ ossgard scan facebook/react
  $ ossgard scan facebook/react --limit 100 --no-wait
  $ ossgard scan facebook/react --json
`)
```

Commands and their examples:

| Command | Examples |
|---------|---------|
| `setup` | `ossgard setup`, `ossgard setup --force` |
| `config` | `ossgard config show`, `ossgard config get api.url`, `ossgard config set api.url http://localhost:3400` |
| `scan` | `ossgard scan facebook/react`, `ossgard scan facebook/react --limit 100 --no-wait`, `ossgard scan facebook/react --full --json` |
| `duplicates` | `ossgard duplicates facebook/react`, `ossgard duplicates facebook/react --json`, `ossgard duplicates facebook/react --min-score 70` |
| `review` | `ossgard review facebook/react 1234`, `ossgard review facebook/react https://github.com/facebook/react/pull/1234 --json` |
| `status` | `ossgard status`, `ossgard status --json` |
| `clean` | `ossgard clean --scans --force`, `ossgard clean --repos`, `ossgard clean --all --force` |
| `doctor` | `ossgard doctor`, `ossgard doctor --json` |

### 7. Consistent `--json` on all commands

**File:** `packages/cli/src/commands/clean.ts`

Currently `clean` has no `--json` flag. Add it:

```json
{"ok": true, "action": "clean-scans", "message": "All scans and analysis data have been cleared."}
```

This lets an agent confirm the action succeeded without parsing human text.

### 8. Global `--json` awareness

**File:** `packages/cli/src/index.ts`, `packages/cli/src/json-mode.ts` (new)

Instead of each command independently checking `opts.json`, provide a global mechanism:

```typescript
// json-mode.ts
let _jsonMode = false;
export function setJsonMode(v: boolean) { _jsonMode = v; }
export function globalJsonMode(): boolean { return _jsonMode; }
```

Root program sets it:
```typescript
program.option("--json", "Output as JSON (global)");
program.hook("preAction", (thisCommand) => {
  if (thisCommand.opts().json) setJsonMode(true);
});
```

Commands still accept `--json` for backward compat, but the error handling layer (`exitWithError`) can check `globalJsonMode()` without commands passing it through.

## Implementation Order

Changes 1-2 are independent. Change 3 depends on 8 (global JSON mode). Changes 4-7 are independent of each other but 3 should land first since 4-7 use `exitWithError`.

Suggested batch order:
1. **Batch 1:** Changes 8, 3, 4 (global JSON mode, structured errors, exit codes — foundational)
2. **Batch 2:** Changes 1, 2 (discovery + non-interactive — biggest agent wins)
3. **Batch 3:** Changes 5, 6, 7 (JSONL progress, examples, --json on destructive — polish)

## Verification

```bash
bun test packages/cli/
bun run build && bun run build:cli

# Discovery
packages/cli/dist/ossgard --commands | jq '.[0].name'

# Non-interactive
echo '' | packages/cli/dist/ossgard duplicates facebook/react  # should not hang

# Structured errors
packages/cli/dist/ossgard scan foo --json  # should output JSON error

# Exit codes
packages/cli/dist/ossgard scan foo; echo $?  # should be 2 (invalid input)
packages/cli/dist/ossgard status; echo $?     # should be 3 if not configured, 4 if API down

# JSONL progress
packages/cli/dist/ossgard scan facebook/react --json | head -1 | jq .event
```
