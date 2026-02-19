---
name: cache-test
description: Validate detect-phase incremental caching — runs two back-to-back scans and compares cache hit rates
---

# ossgard — Cache Validation Test

You are running a cache validation test for the detect-phase incremental caching
system. Your job is to build from source, clear all data (keeping accounts), run
two back-to-back scans on the same repo, and compare token usage and cache hit
rates between them. No human approval is needed for fixes — apply them
automatically and retry.

## Communication Style

Print terse status lines throughout:

| Situation | Format |
|---|---|
| Starting a phase | `[Phase N] Starting — <description>` |
| Phase done | `[Phase N] Done — <summary with numbers>` |
| Watching logs | `[Waiting] Watching logs... last activity Xs ago` (every ~60s) |
| Progress | `[Progress] Ingest: 45/87 PRs fetched...` (every ~30s) |
| Stall detected | `[Stall] No new logs for 5 minutes. Investigating...` |
| Error spotted | `[Error] <impact first, then technical detail>` |
| Fix applied | `[Fix] <what was wrong> -> <what was changed>` |
| Scan 1 done | `[Scan 1] Complete — <duration>, <token counts>` |
| Scan 2 done | `[Scan 2] Complete — <duration>, <token counts>` |
| Comparison | `[Cache] Intent: X/Y cached, Embed: X/Y cached, Pairs: X/Y cached` |

Be concise. One or two lines per message. Include concrete numbers when available.

---

## Upfront Questions

Before starting, ask the user three questions:

1. **Which repository to scan?** (e.g. `openclaw/openclaw`, `facebook/react`)
2. **PR cap?** Maximum number of PRs to ingest (e.g. `50`, `200`, `1000`)

---

## Phase 0 — Preflight

Verify all of these. Abort immediately if any fail:

```bash
curl -sf http://localhost:6333/collections      # Qdrant must be running
test -f ~/.ossgard/config.toml                   # Config must exist
grep -q 'key = "' ~/.ossgard/config.toml         # Must have a non-empty API key
bun --version                                    # Bun must be installed
```

---

## Phase 1 — Build & Install

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

**Success criteria:** All exit 0. `$HOME/.local/bin/ossgard --help` prints usage.

---

## Phase 2 — Start API Server

```bash
pkill -f ossgard-api || true
sleep 1
LOG_LEVEL=info $HOME/.local/bin/ossgard-api > /tmp/ossgard-api.log 2>&1 &
echo $!  # capture PID
```

Poll until healthy (15s timeout):

```bash
for i in $(seq 1 30); do
  curl -sf http://localhost:3400/health && break
  sleep 0.5
done
```

If health check fails, show last 20 lines of `/tmp/ossgard-api.log` and abort.

---

## Phase 3 — Clean Slate (keep accounts)

Clear all repos, PRs, scans, and cache — but **keep account configuration**.

```bash
$HOME/.local/bin/ossgard clean --repos --force
```

This deletes repos, PRs (including embed_hash/intent_summary), scans, dupe groups,
jobs, and pairwise_cache via cascading deletes. Account data is preserved.

Verify the clean was successful:

```bash
$HOME/.local/bin/ossgard repos
```

Should show no repositories.

---

## Phase 4 — Scan 1 (Cold Cache)

### 4.1 — Truncate log

```bash
> /tmp/ossgard-api.log
```

### 4.2 — Record start time

```bash
date +%s  # capture SCAN1_START
```

### 4.3 — Dispatch scan

```bash
$HOME/.local/bin/ossgard scan <owner/repo> --limit <N> --no-wait
```

**Success criteria:** Exit 0, output contains `Scan #<N> started`.

### 4.4 — Monitor until complete

> **CRITICAL — Non-blocking monitoring**
>
> Never use blocking `sleep` commands to wait for logs. Instead:
>
> 1. Start a background watcher using the Bash tool with `run_in_background`:
>    ```bash
>    while true; do
>      if grep -q 'Scan complete\|scan_status=done\|status=failed\|ERROR' /tmp/ossgard-api.log 2>/dev/null; then
>        echo "---SCAN-EVENT-DETECTED---"
>        tail -80 /tmp/ossgard-api.log
>        break
>      fi
>      sleep 10
>    done
>    ```
> 2. Check on it periodically using `TaskOutput` with `block=false`.
> 3. Between checks, read the latest logs with a quick non-blocking `tail`:
>    ```bash
>    tail -30 /tmp/ossgard-api.log
>    ```
> 4. Print a progress update, then check `TaskOutput` again.

### 4.5 — Record end time and extract stats

```bash
date +%s  # capture SCAN1_END
```

Extract cache stats from the log. Look for these log lines:

- `prsCached=X prsChanged=Y` — intent/embed cache partition
- `pairsCached=X pairsVerified=Y pairsTotal=Z` — pairwise cache stats
- Token usage lines for intent extraction, verification, ranking

Record these values for comparison:

| Metric | Log pattern |
|--------|------------|
| PRs cached (intent+embed) | `prsCached=` |
| PRs changed (recomputed) | `prsChanged=` |
| Pairs cached | `pairsCached=` |
| Pairs verified via LLM | `pairsVerified=` |
| Duration | `SCAN1_END - SCAN1_START` |

**Expected for Scan 1 (cold cache):**
- `prsCached=0` (no cache exists yet)
- `pairsCached=0` (no cache exists yet)
- All PRs recomputed, all pairs verified via LLM

Print: `[Scan 1] Complete — <duration>s, 0 cached PRs, 0 cached pairs (cold cache as expected)`

---

## Phase 5 — Scan 2 (Warm Cache)

### 5.1 — Clear ONLY scan results (NOT cache)

Do NOT run `clean --scans` — that would wipe the cache. Instead, just truncate
the log and dispatch a new scan. The previous scan's results (dupe groups etc.)
don't interfere with a new scan dispatch.

```bash
> /tmp/ossgard-api.log
```

### 5.2 — Record start time

```bash
date +%s  # capture SCAN2_START
```

### 5.3 — Dispatch second scan

```bash
$HOME/.local/bin/ossgard scan <owner/repo> --limit <N> --no-wait
```

### 5.4 — Monitor until complete

Same non-blocking monitoring approach as Phase 4.4.

### 5.5 — Record end time and extract stats

```bash
date +%s  # capture SCAN2_END
```

Extract the same cache stats as Phase 4.5.

**Expected for Scan 2 (warm cache):**
- `prsCached` should be close to the total PR count (most/all PRs unchanged)
- `pairsCached` should be close to the total pair count
- Near-zero LLM token usage for intent extraction and pairwise verification
- Ranking always re-runs (not cached)

Print: `[Scan 2] Complete — <duration>s, X/Y cached PRs, X/Y cached pairs`

---

## Phase 6 — Compare Results

Print a comparison table:

```
[Cache Validation Results]

                    Scan 1 (Cold)    Scan 2 (Warm)    Savings
                    ─────────────    ─────────────    ───────
Duration            XXs              XXs              XX% faster
PRs cached          0/N              X/N              XX%
Pairs cached        0/N              X/N              XX%
Intent LLM calls    N                X                XX% fewer
Verify LLM calls    N                X                XX% fewer
```

### Success Criteria

The test **passes** if ALL of these are true for Scan 2:
- At least 80% of PRs hit the intent+embed cache
- At least 80% of pairs hit the pairwise cache
- Scan 2 duration is shorter than Scan 1 (or at minimum, fewer LLM calls)
- Both scans produce the same duplicate groups (or equivalent results)

The test **fails** if:
- Scan 2 shows 0% cache hits (cache not working)
- Scan 2 recomputes all intents/embeddings/pairs (cache not persisting)
- Either scan errors out

### Verify results match

```bash
$HOME/.local/bin/ossgard duplicates <owner/repo>
```

Print the duplicate groups and confirm they are consistent with Scan 1.

---

## Phase 7 — Stall Detection

| Mode | Stall timeout |
|------|---------------|
| Sequential (default) | **5 minutes** of no new log lines |
| Batch mode (embed/verify/rank with batch APIs) | **30 minutes** of no new log lines |

When a stall is detected:

1. Print last 50 lines of the log
2. Check if API process is alive: `kill -0 <PID>`
3. Check Qdrant health: `curl http://localhost:6333/collections`
4. If process died, check stderr for crash info
5. Enter self-heal loop (Phase 8)

---

## Phase 8 — Self-Heal Loop (Auto-Fix)

When an error is detected in logs:

### Step 1 — Diagnose

- Read the full error message and 20 lines of surrounding context
- Identify the failing source file and function from the stack trace
- Read the relevant source code to understand the bug

### Step 2 — Fix (no approval gate)

- Apply the code fix using the Edit tool
- Keep a running list of fixed files and one-line descriptions
- Rebuild:
  ```bash
  cd /Users/dhruv/Code/ossgard
  bun run build && bun run build:api && bun run build:cli
  cp packages/api/dist/ossgard-api "$HOME/.local/bin/ossgard-api"
  cp packages/cli/dist/ossgard     "$HOME/.local/bin/ossgard"
  ```
- Restart API server:
  ```bash
  pkill -f ossgard-api || true
  sleep 1
  LOG_LEVEL=info $HOME/.local/bin/ossgard-api > /tmp/ossgard-api.log 2>&1 &
  ```
- Wait for health check
- Print: `[Fix] <what was wrong> -> <what was changed>`

### Step 3 — Retry

Go back to **Phase 3** (clean slate, re-dispatch both scans). The clean ensures
no stale state interferes.

### Step 3.5 — Commit on success

When both scans complete successfully (reaches Phase 6), commit all accumulated
fixes:

```bash
cd /Users/dhruv/Code/ossgard
git add -A -- packages/
git commit -m "fix: <concise summary of all fixes applied>

Applied during cache-test run against <owner/repo> (limit <N>).

Fixes:
- <one-line description of fix 1>
- <one-line description of fix 2>
...

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

### Step 4 — Escalate

- If the **same error** recurs after a fix, **STOP** and escalate to the user
- If a **different error** occurs, repeat from Step 1

---

## Phase 9 — Cleanup

```bash
pkill -f ossgard-api || true
rm -f /tmp/ossgard-api.log
```

Print final summary:

```
[Complete] Cache validation test passed.
  Repo:        <owner/repo>
  PR cap:      <N>
  Scan 1:      <duration>s (cold cache — 0% hit rate)
  Scan 2:      <duration>s (warm cache — XX% hit rate)
  Speedup:     XX% faster / XX% fewer LLM calls
  Groups:      <count> duplicate groups (consistent across both scans)
  Fixes:       <count> auto-applied and committed (<short hash>)
```

---

## Quick Reference

| Action | Command |
|--------|---------|
| Build everything | `bun install && bun run build && bun run build:api && bun run build:cli` |
| Start API server | `LOG_LEVEL=info $HOME/.local/bin/ossgard-api > /tmp/ossgard-api.log 2>&1 &` |
| Health check | `curl -sf http://localhost:3400/health` |
| Clean repos (keep accounts) | `$HOME/.local/bin/ossgard clean --repos --force` |
| Dispatch scan | `$HOME/.local/bin/ossgard scan <repo> --limit <N> --no-wait` |
| View results | `$HOME/.local/bin/ossgard duplicates <repo>` |
| Tail logs | `tail -f /tmp/ossgard-api.log` |
| Kill API server | `pkill -f ossgard-api` |

| Path | What |
|------|------|
| `/Users/dhruv/Code/ossgard` | Project root |
| `packages/api/dist/ossgard-api` | API binary (built) |
| `packages/cli/dist/ossgard` | CLI binary (built) |
| `~/.local/bin/ossgard-api` | API binary (installed) |
| `~/.local/bin/ossgard` | CLI binary (installed) |
| `~/.ossgard/config.toml` | CLI config |
| `~/.ossgard/ossgard.db` | SQLite database |
| `/tmp/ossgard-api.log` | API server log |
