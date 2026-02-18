# Design: `/smoke-test` Claude Command

**Date:** 2026-02-18
**Status:** Approved

## Summary

A developer-focused Claude command (`.claude/commands/smoke-test.md`) that builds
ossgard from source, runs a full scan against a user-specified repo with a PR cap,
monitors via logs, and auto-fixes any errors it encounters in a tight loop.

This replaces `e2e/local-smoke-test.md` and is separate from the user-facing
`/try` command (guided onboarding demo).

## Audience

The developer working on ossgard (not end users). Used during development to
validate that code changes work end-to-end without manual intervention.

## Invocation

```
/smoke-test
```

Claude asks two questions upfront:
1. Which repo to scan (e.g. `openclaw/openclaw`)
2. PR cap limit (e.g. `50`, `200`, `1000`)

## Phases

| Phase | What happens |
|-------|-------------|
| 0 — Preflight | Verify `bun`, `docker`, Qdrant running, config exists. Abort if missing. |
| 1 — Build & Install | `bun install && bun run build && bun run build:api && bun run build:cli`, copy to `~/.local/bin/` |
| 2 — Start API | Kill existing, launch `ossgard-api`, poll `/health` |
| 3 — Clear & Scan | `ossgard clear-scans --force`, then `ossgard scan <repo> --limit <N> --no-wait` |
| 4 — Monitor | Tail `/tmp/ossgard-api.log`, report phase transitions (Ingest -> Embed -> Cluster -> Verify -> Rank) |
| 5 — Self-Heal | On error: diagnose from logs + source code, auto-apply fix, rebuild, restart API, go back to Phase 3 |
| 6 — Results | Run `ossgard dupes <repo>`, print summary |

## Self-Healing Loop

```
Error detected in logs
  -> Read error + 20 lines context
  -> Identify source file from stack trace
  -> Read source, diagnose root cause
  -> Apply fix (Edit tool) — no approval gate
  -> Rebuild binaries (bun run build && build:api && build:cli)
  -> Copy to ~/.local/bin/
  -> Restart API server
  -> /compact with state summary
  -> Go back to Phase 3 (clear-scans + re-scan)
  -> If same error recurs, STOP and escalate to user
```

Fixes are applied automatically. The developer reviews the git diff after the run.

## New CLI Work: `--limit` flag

Add `--limit <N>` to `ossgard scan` which passes the limit to the API's scan
endpoint. The API's ingest phase stops after fetching N PRs. This is the only
code change needed beyond the command file itself.

## Communication Style

Status lines throughout:
- `[Phase N] Starting — <description>`
- `[Phase N] Done — <summary with numbers>`
- `[Progress]` updates every ~30s during long phases
- `[Stall]` detection at 5min (30min for batch phases)
- `[Error]` / `[Fix]` / `[Retry]` for self-heal loop

## File Changes

| File | Action |
|------|--------|
| `.claude/commands/smoke-test.md` | **Create** — the new command |
| `.claude/commands/try.md` | **Create** — move from `plans/todo/try.md` |
| `e2e/local-smoke-test.md` | **Delete** — superseded by `/smoke-test` |
| `plans/todo/try.md` | **Delete** — moved to `.claude/commands/try.md` |

## Design Decisions

- **Auto-fix without approval:** Speed over safety. This is a dev tool, not
  production. The developer reviews git diff after the run completes.
- **Always ask for repo:** No default repo. Flexible for testing against
  different repositories.
- **PR cap via CLI flag:** Clean integration. The `--limit` flag on `ossgard scan`
  is useful beyond just this command.
- **Single self-contained file:** No split into command + runbook. One file is
  simpler and Claude commands work best self-contained.
- **Separate from `/try`:** Different audiences, different behaviors. `/try` is
  guided onboarding with user interaction. `/smoke-test` is autonomous dev
  validation with self-healing.
