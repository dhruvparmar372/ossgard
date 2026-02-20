# CLI Command Renaming: `check-*` Convention

## Motivation

Analysis result commands should live under a `check-*` prefix to clearly distinguish them from the orchestrator (`scan`) and operational commands (`setup`, `doctor`, `status`, `config`, `clean`). This makes the CLI self-documenting:

- `ossgard scan` — run all checks (orchestrator)
- `ossgard check-*` — view results of a specific check
- Everything else — operational/config

## Renames

| Current command | New command | File |
|----------------|-------------|------|
| `ossgard duplicates <owner/repo>` | `ossgard check-duplicates <owner/repo>` | `packages/cli/src/commands/duplicates.ts` |
| `ossgard review <owner/repo> <pr>` | `ossgard check-duplicates <owner/repo> --pr <pr>` | `packages/cli/src/commands/review.ts` |

The `review` command becomes a `--pr` flag on `check-duplicates` rather than a separate command — it's the same check scoped to a single PR.

The new `check-vision` command will be created as part of the vision-check feature (see `vision-check-design.md`).

## Changes

### 1. Rename `duplicates` → `check-duplicates`

**File: `packages/cli/src/commands/duplicates.ts`**
- Rename the Command from `"duplicates"` to `"check-duplicates"`
- Update description to "Show duplicate PR groups for a repository"
- Update help text examples to use `ossgard check-duplicates`

### 2. Merge `review` into `check-duplicates --pr <N>`

**File: `packages/cli/src/commands/duplicates.ts`**
- Add `--pr <number>` option
- When `--pr` is provided, call `GET /repos/{owner}/{name}/review/{prNumber}` (existing API)
- When `--pr` is omitted, call `GET /repos/{owner}/{name}/dupes` (existing behavior)

**File: `packages/cli/src/commands/review.ts`**
- Delete this file

### 3. Update CLI entrypoint

**File: `packages/cli/src/index.ts`**
- Remove `reviewCommand` import and `addCommand` call
- Update `duplicatesCommand` reference (function name stays the same or rename to `checkDuplicatesCommand`)

### 4. Update scan command output

**File: `packages/cli/src/commands/scan.ts`**
- Change post-scan message from `ossgard duplicates` to `ossgard check-duplicates`

### 5. Update API route paths (optional, lower priority)

The API routes (`/repos/:owner/:name/dupes`, `/repos/:owner/:name/review/:prNumber`) can stay as-is for now — the rename is CLI-only. API route renaming can be done separately if desired.

### 6. Update demo data references

**File: `demo/`**
- Check for any references to `duplicates` command in demo UI or docs and update

### 7. Update documentation

- Update `README.md` examples
- Update any help text or docs referencing old command names

## Final CLI structure

```
ossgard setup                          — configure account + services
ossgard doctor                         — health check
ossgard scan <owner/repo>              — run all checks (ingest + detect + vision-check)
ossgard check-duplicates <owner/repo>  — view duplicate PR groups
ossgard check-duplicates <owner/repo> --pr <N>  — check duplicates for a specific PR
ossgard check-vision <owner/repo>      — view vision alignment results (new, from vision-check feature)
ossgard status                         — show tracked repos and active scans
ossgard config [show|get|set]          — manage CLI settings
ossgard clean <owner/repo>             — delete data
```
