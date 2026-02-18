# Plan: Claude Commands — `/try` and `/smoke-test`

Create two Claude command files that share a common foundation (build, services,
scan) but serve different audiences with different behaviors.

## Output Files

| File | Purpose |
|------|---------|
| `.claude/commands/try.md` | User-facing guided onboarding demo |
| `.claude/commands/smoke-test.md` | Developer-facing E2E with self-healing loop |

## Files to Delete

| File | Reason |
|------|--------|
| `plans/todo/try.md` | Superseded — content moves to `.claude/commands/try.md` |
| `e2e/local-smoke-test.md` | Superseded — content moves to `.claude/commands/smoke-test.md` |
| `docs/plans/2026-02-18-smoke-test-command-design.md` | Merged into this plan |

---

## Shared Foundation

Both commands share these phases. The details differ per command (see per-command
sections below), but the skeleton is the same.

| Phase | What |
|-------|------|
| Preflight | Verify bun, docker, Qdrant, config |
| Build & Install | `bun install && bun run build && bun run build:api && bun run build:cli`, copy to `~/.local/bin/` |
| Start API | Kill existing, launch `ossgard-api`, poll `/health` |
| Scan | Dispatch `ossgard scan <repo>` |
| Results | Run `ossgard dupes <repo>` |

### Shared: Key Paths

| What | Path |
|------|------|
| Project root | `/Users/dhruv/Code/ossgard` |
| API binary (built) | `packages/api/dist/ossgard-api` |
| CLI binary (built) | `packages/cli/dist/ossgard` |
| API binary (installed) | `~/.local/bin/ossgard-api` |
| CLI binary (installed) | `~/.local/bin/ossgard` |
| CLI config | `~/.ossgard/config.toml` |
| SQLite database | `~/.ossgard/ossgard.db` |
| API server log | `/tmp/ossgard-api.log` |
| Qdrant | `http://localhost:6333` |
| API server | `http://localhost:3400` |

### Shared: Communication Style

Both commands print status lines:

```
[Phase N] Starting — <what is about to happen>
[Phase N] Done — <one-line summary with key numbers>
```

Be concise but informative. Include concrete numbers when available.
If something is taking a while, say so — silence is worse than a "still waiting"
message.

---

## Command 1: `/try` — Guided Onboarding Demo

**Audience:** Open-source maintainers cloning ossgard for the first time.

**Tone:** Friendly, guided, hand-holding. Explain what's happening and why.

**Key differences from `/smoke-test`:**
- Helps set up services from scratch (Qdrant, Ollama, API keys)
- Runs the `ossgard setup` wizard interactively
- Offers LLM provider choice (Ollama vs Cloud APIs)
- On scan failure: diagnose and explain, but do NOT auto-fix code
- Includes interactive results walkthrough and per-PR review
- Ends with a handoff summary of available commands

### `/try` Phases

#### Phase 1 — Preflight
- Check `bun --version` and `docker --version`
- If missing, tell user where to install. Stop if either is missing.

#### Phase 2 — Build
- `bun install && bun run build && bun run build:api && bun run build:cli`
- Copy binaries to `~/.local/bin/`
- Verify with `ossgard --help`

#### Phase 3 — Start Services

**3.1 — Qdrant:** Check if running, start via `docker compose -f local-ai/vector-store.yml up -d` if not. Poll until healthy.

**3.2 — LLM/Embedding provider:** Ask the user to choose:
- **Option A: Fully local (Ollama)** — free, private, slower. Start via docker compose, pull models.
- **Option B: Cloud APIs (Anthropic + OpenAI)** — faster, costs money. Keys collected in setup wizard.

#### Phase 4 — Start API Server
- Kill existing, launch with `LOG_LEVEL=info`, poll `/health`

#### Phase 5 — Setup (Account Registration)
- Check if already configured via `ossgard config show`
- If configured, ask user if they want to reconfigure
- Run `ossgard setup` — let user interact with the wizard directly

#### Phase 6 — Scan a Repository
- Ask user which repo to scan. Suggest their own or `openclaw/openclaw` for a quick demo.
- Run `ossgard scan <repo>` (with wait — use the CLI's built-in polling)
- On failure: diagnose and explain to user. Do NOT auto-fix.

**Timing expectations:**
- Ingest: ~1-2 min for 100 PRs
- Embed with OpenAI: ~1-2 min for 100 PRs
- Embed with Ollama: ~5-15 min for 100 PRs
- Verify + Rank with Anthropic: ~1-2 min
- Verify + Rank with Ollama: ~5-20 min

#### Phase 7 — Show Results

**7.1 — Duplicate groups:** Run `ossgard dupes <repo>`. Let user drive the interactive Y/n prompts.

**7.2 — Per-PR review (optional):** Offer to check a specific PR via `ossgard review <repo> <pr-number>`.

#### Phase 8 — Handoff
Print summary of setup (API server PID, Qdrant, DB path) and available commands.

---

## Command 2: `/smoke-test` — Developer E2E with Self-Healing

**Audience:** The developer working on ossgard (you).

**Tone:** Terse, status-oriented. No hand-holding.

**Key differences from `/try`:**
- Assumes services already configured (Qdrant running, config exists)
- Asks for repo + PR cap upfront, then runs autonomously
- Uses `--no-wait` and tails API logs directly for richer diagnostics
- Auto-fixes errors without asking (diagnose → fix → rebuild → retry)
- Compacts context before each scan attempt to maximize context window
- Includes stall detection with configurable timeouts

### `/smoke-test` Upfront Questions

Claude asks two questions at start:
1. **Which repo?** (e.g. `openclaw/openclaw`)
2. **PR cap?** (e.g. `50`, `200`, `1000`)

### `/smoke-test` Phases

#### Phase 0 — Preflight
Verify all of these, abort if any fail:
1. `curl -sf http://localhost:6333/collections` — Qdrant must be running
2. `test -f ~/.ossgard/config.toml` — config must exist
3. `grep -q 'key = "' ~/.ossgard/config.toml` — must have a non-empty API key
4. `bun --version` — bun must be installed

#### Phase 1 — Build & Install
```bash
cd /Users/dhruv/Code/ossgard
bun install
bun run build
bun run build:api
bun run build:cli
mkdir -p "$HOME/.local/bin"
cp packages/api/dist/ossgard-api "$HOME/.local/bin/ossgard-api"
cp packages/cli/dist/ossgard     "$HOME/.local/bin/ossgard"
```

#### Phase 2 — Start API Server
```bash
pkill -f ossgard-api || true
sleep 1
LOG_LEVEL=info $HOME/.local/bin/ossgard-api > /tmp/ossgard-api.log 2>&1 &
```
Poll `/health` until ready (15s timeout). Start tailing logs in background.

#### Phase 3 — Compact, Clear & Scan

**3.1 — Compact context:** Run `/compact` with a summary hint preserving the
current state (phase, repo, any known errors from prior runs).

**3.2 — Clear previous scans:**
```bash
$HOME/.local/bin/ossgard clear-scans --force
```

**3.3 — Dispatch scan:**
```bash
$HOME/.local/bin/ossgard scan <repo> --limit <N> --no-wait
```

#### Phase 4 — Monitor Pipeline Progress

Tail `/tmp/ossgard-api.log` and watch for phase transitions:

```
Ingest -> Embed -> Cluster -> Verify -> Rank -> Done
```

Log prefixes to watch for:
- `[api:ingest]` — PR fetching progress
- `[api:embed]` — embedding batches
- `[api:cluster]` — candidate group formation
- `[api:verify]` — LLM verification of groups
- `[api:rank]` — final ranking
- `[api:openai-batch]` / `[api:anthropic-batch]` — batch API polling

Report after each phase:
```
[Ingest]  Complete — 87 PRs fetched, 3 skipped
[Embed]   Complete — 87 PRs embedded in 4m 12s
[Cluster] Complete — 12 candidate groups
[Verify]  Complete — 8 confirmed duplicate groups
[Rank]    Complete — 8 groups ranked. Scan finished.
```

#### Phase 5 — Stall Detection

| Mode | Stall timeout |
|------|---------------|
| Sequential (default) | 5 minutes of no new log lines |
| Batch mode (embed/verify/rank) | 30 minutes of no new log lines |

When stall detected:
1. Print last 50 lines of log
2. Check if API process is alive (`kill -0 <PID>`)
3. Check Qdrant health
4. If process died, check stderr for crash info
5. Enter self-heal loop

#### Phase 6 — Self-Heal Loop (Auto-Fix)

When an error is detected in logs (ERROR, stack traces, non-zero exit codes):

**Step 1 — Diagnose:**
- Read error + 20 lines surrounding context
- Identify failing source file and function from stack trace
- Read the relevant source code

**Step 2 — Fix (no approval gate):**
- Apply the code fix using the Edit tool
- Rebuild: `bun run build && bun run build:api && bun run build:cli`
- Copy binaries to `~/.local/bin/`
- Restart API server
- Print: `[Fix] <what was wrong> -> <what was changed>`

**Step 3 — Retry:**
- Go back to Phase 3 (compact, clear scans, re-dispatch)
- ETag caching means GitHub PR diffs won't be re-downloaded

**Step 4 — Escalate:**
- If the same error recurs after a fix, STOP and escalate to the user
- If a different error occurs, repeat from Step 1

#### Phase 7 — Results
```bash
$HOME/.local/bin/ossgard dupes <repo>
```
Print the full output. No interactive walkthrough — just the results.

#### Phase 8 — Cleanup
```bash
pkill -f ossgard-api || true
rm -f /tmp/ossgard-api.log
```

---

## Code Change Required: `--limit` Flag

Add `--limit <N>` option to `ossgard scan` CLI command. This passes the limit
to the API's scan endpoint as a body parameter. The API's ingest phase should
stop after fetching N PRs.

**Files to modify:**
- `packages/cli/src/commands/scan.ts` — add `--limit` option, pass to API
- API scan endpoint handler — accept and respect `limit` param during ingest

This is the only code change needed beyond the command files themselves.

---

## Design Decisions

- **Two separate commands, not one:** Different audiences, different behaviors.
  `/try` is guided onboarding. `/smoke-test` is autonomous dev validation.
- **Auto-fix in smoke-test only:** Speed over safety for dev iteration. The
  developer reviews `git diff` after the run.
- **Ask-before-fixing in try only:** Users shouldn't have their code changed
  silently during a demo. Diagnose and explain instead.
- **PR cap via CLI flag:** The `--limit` on `ossgard scan` is useful beyond just
  the smoke-test command.
- **Always ask for repo in smoke-test:** No default. Flexible for testing against
  different repositories.
- **Self-contained command files:** No shared runbook or includes. Claude commands
  work best as single self-contained prompts.
