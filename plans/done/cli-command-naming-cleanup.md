# CLI Command Naming Cleanup

Standardize CLI command names to follow established conventions. No backward compatibility — clean break.

## Current State

```
ossgard setup                          # one-time wizard
ossgard config show/get/set            # configuration management
ossgard status                         # show tracked repos + active scans
ossgard scan <owner/repo>              # start a duplicate scan
ossgard dupes <owner/repo>             # show duplicate groups
ossgard review <owner/repo> <pr>       # find duplicates for a specific PR
ossgard clear-scans                    # delete scans and analysis
ossgard clear-repos                    # delete repos, PRs, scans, analysis
ossgard reset                          # delete everything including accounts
```

9 top-level commands with inconsistent naming:
- `dupes` is slang (no established CLI uses informal abbreviations as command names)
- `clear-scans` / `clear-repos` / `reset` are three top-level commands for variations of "delete data" — clutters help output, hyphens break subcommand convention
- Mix of verbs (`scan`, `review`, `reset`) and nouns (`dupes`, `status`) with no consistent pattern

## Target State

```
ossgard setup                          # unchanged
ossgard doctor                         # NEW: check prerequisites + service health
ossgard config show/get/set            # unchanged
ossgard status                         # unchanged
ossgard scan <owner/repo>              # unchanged
ossgard duplicates <owner/repo>        # renamed from "dupes"
ossgard review <owner/repo> <pr>       # unchanged
ossgard clean [--scans|--repos|--all]  # consolidate 3 commands into 1
```

7 top-level commands.

## Changes

### 1. Rename `dupes` to `duplicates`

**File:** `packages/cli/src/commands/dupes.ts` → rename to `duplicates.ts`

- Rename the file
- Change `new Command("dupes")` → `new Command("duplicates")`
- Update description: `"Show duplicate PR groups for a repository"`
- Update `packages/cli/src/index.ts`: import path and registration

**File:** `packages/api/src/routes/dupes.ts` — no change needed (API route stays `/dupes`, only CLI command name changes)

**Other references to update:**
- `README.md`: all `ossgard dupes` → `ossgard duplicates`
- `plans/design/2026-02-15-ossgard-design.md`: CLI commands table
- Any test files referencing the command name

### 2. Consolidate `clear-scans`, `clear-repos`, `reset` into `clean`

**File:** `packages/cli/src/commands/reset.ts` — rewrite as `clean.ts`

Current: three separate commands each registered independently.

New: single `clean` command with mutually exclusive flags:

```typescript
new Command("clean")
  .description("Delete ossgard data")
  .option("--scans", "Delete scans, analysis results, and jobs (keep repos and PRs)")
  .option("--repos", "Delete repos, PRs, scans, and analysis")
  .option("--all", "Full reset — delete everything including accounts")
  .option("--force", "Skip confirmation prompt")
```

Behavior:
- No flags: interactive prompt asking which scope (scans / repos / all)
- `--scans`: calls `POST /clear-scans` (same as current `clear-scans`)
- `--repos`: calls `POST /clear-repos` (same as current `clear-repos`)
- `--all`: calls `POST /reset` (same as current `reset`)
- Multiple flags: error ("specify exactly one of --scans, --repos, --all")

Delete the old command registrations from `index.ts`, delete old file if commands were in separate files.

### 3. Add `doctor` command

**File:** `packages/cli/src/commands/doctor.ts` (new)

Checks:
1. Local config exists and is complete (`~/.ossgard/config.toml` has `api.url` + `api.key`)
2. API server is reachable (`GET /health`)
3. Account is valid (fetch account config to verify API key works)
4. Services are configured (GitHub token, LLM provider, embedding provider, vector store all present in account config)

Output (human-readable):
```
ossgard doctor

  Config       ~/.ossgard/config.toml found
  API          http://localhost:3400 reachable
  Account      authenticated (account #1)
  GitHub       token configured
  LLM          anthropic / claude-sonnet-4-6
  Embedding    openai / text-embedding-3-small
  Vector Store http://localhost:6333

All checks passed.
```

Output (`--json`):
```json
{
  "config": {"ok": true, "path": "~/.ossgard/config.toml"},
  "api": {"ok": true, "url": "http://localhost:3400"},
  "account": {"ok": true, "id": 1},
  "github": {"ok": true},
  "llm": {"ok": true, "provider": "anthropic", "model": "claude-sonnet-4-6"},
  "embedding": {"ok": true, "provider": "openai", "model": "text-embedding-3-small"},
  "vectorStore": {"ok": true, "url": "http://localhost:6333"}
}
```

Exit code 0 if all pass, 1 if any fail.

Register in `index.ts` between `setup` and `config`.

### 4. Update `index.ts` registration order

Commands should appear in help output in the order a new user would encounter them:

```typescript
// Setup & diagnostics
program.addCommand(setupCommand(...));
program.addCommand(doctorCommand(...));

// Primary workflow
program.addCommand(scanCommand(...));
program.addCommand(duplicatesCommand(...));
program.addCommand(reviewCommand(...));

// Informational
program.addCommand(statusCommand(...));
program.addCommand(configCommand(...));

// Destructive
program.addCommand(cleanCommand(...));
```

### 5. Update documentation

- `README.md`: update all command references and usage examples
- `plans/design/2026-02-15-ossgard-design.md`: update CLI commands table

## Verification

```bash
bun test packages/cli/
bun run build && bun run build:cli
packages/cli/dist/ossgard --help          # verify command list
packages/cli/dist/ossgard duplicates -h   # verify rename
packages/cli/dist/ossgard clean -h        # verify consolidation
packages/cli/dist/ossgard doctor -h       # verify new command
```
