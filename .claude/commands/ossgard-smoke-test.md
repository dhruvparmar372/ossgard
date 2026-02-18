---
name: smoke-test
description: Developer E2E smoke test — build, scan, monitor logs, auto-fix errors
---

# ossgard — Developer Smoke Test

You are running a full end-to-end smoke test of the ossgard stack. Your job is to
build from source, scan a repo, monitor the pipeline via API logs, and auto-fix
any errors you encounter. No human approval is needed for fixes — apply them
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
| Fixes committed | `[Commit] <N> fix(es) committed — <short hash>` |
| Rebuilding | `[Rebuilding] Applying fix, rebuilding binaries...` |
| Retrying | `[Retry] Restarting from Phase 3 with clean slate...` |
| Pipeline done | `[Complete] Scan finished successfully. Fetching results...` |

Be concise. One or two lines per message. Include concrete numbers when available.

---

## Upfront Questions

Before starting, ask the user three questions:

1. **Which repository to scan?** (e.g. `openclaw/openclaw`, `facebook/react`)
2. **PR cap?** Maximum number of PRs to ingest (e.g. `50`, `200`, `1000`)
3. **Deduplication strategy?** Which duplicate detection strategy to use:
   - **pairwise-llm (Recommended)** — Summarizes each PR's intent with an LLM,
     embeds actual code diffs, then verifies every candidate pair with a dedicated
     LLM call. Groups are formed via complete-linkage (cliques), so every member
     is confirmed as a duplicate of every other member — no false-positive
     mega-groups.
   - **legacy** — Embeds PR titles and file paths, clusters via Union-Find, then
     does a single group-level LLM pass. Faster but assumes transitivity, which
     can produce large false-positive groups.

   Default to **pairwise-llm** if the user has no preference.

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

## Phase 3 — Compact, Clear & Scan

### 3.1 — Compact context

Run `/compact` with a summary hint:

```
/compact Running smoke-test. Phase 3 — about to scan <repo> with limit <N>.
API server running on localhost:3400, logs at /tmp/ossgard-api.log.
<include any known errors from prior runs if this is a retry>
```

### 3.2 — Clear previous scans

```bash
$HOME/.local/bin/ossgard clear-scans --force
```

### 3.3 — Dispatch scan

```bash
$HOME/.local/bin/ossgard scan <owner/repo> --limit <N> --strategy <strategy> --no-wait
```

`--no-wait` returns immediately. Monitor progress through API logs instead of
the CLI polling loop — this gives richer diagnostics.

**Success criteria:** Exit 0, output contains `Scan #<N> started`.

---

## Phase 4 — Monitor Pipeline Progress

> **CRITICAL — Non-blocking monitoring**
>
> Never use blocking `sleep` commands to wait for logs. This locks the
> conversation and prevents the user from chatting. Instead:
>
> 1. Start a background watcher using the Bash tool with `run_in_background`:
>    ```bash
>    # Watches for scan completion or errors, exits when found
>    while true; do
>      if grep -q 'Scan complete\|scan_status=done\|status=failed\|ERROR' /tmp/ossgard-api.log 2>/dev/null; then
>        echo "---SCAN-EVENT-DETECTED---"
>        tail -80 /tmp/ossgard-api.log
>        break
>      fi
>      sleep 10
>    done
>    ```
> 2. Check on it periodically using `TaskOutput` with `block=false` — this
>    returns immediately without blocking.
> 3. Between checks, read the latest logs with a quick non-blocking `tail`:
>    ```bash
>    tail -30 /tmp/ossgard-api.log
>    ```
> 4. Print a progress update, then **check `TaskOutput` again** (not sleep).
>    If the watcher hasn't fired yet, do another `tail` check after a short
>    moment. The user remains free to type between checks.

The API processes the scan through five sequential phases:

```
Ingest -> Embed -> Cluster -> Verify -> Rank -> Done
```

Watch `/tmp/ossgard-api.log` for these log prefixes:

| Prefix | Phase |
|--------|-------|
| `[api:ingest]` | PR fetching — look for `Ingest started`, `PR ingested ... progress=X/N`, `Ingest complete` |
| `[api:embed]` | Embedding — look for `Embed started`, `Embedding batch ... progress=X/N`, `Embed complete` |
| `[api:cluster]` | Clustering — look for `Cluster started`, `Candidate groups ... count=N` |
| `[api:verify]` | LLM verify — look for `Verify started`, `Group verified ... group=X/N`, `Verified groups` |
| `[api:rank]` | Ranking — look for `Rank started`, `Group ranked ... group=X/N`, `Scan complete` |
| `[api:openai-batch]` | Batch API polling (embed phase) — includes `elapsedMs`, `nextPollMs` |
| `[api:anthropic-batch]` | Batch API polling (verify/rank) — includes `elapsedMs`, `nextPollMs` |

Report after each phase completes:

```
[Ingest]  Complete — 87 PRs fetched, 3 skipped
[Embed]   Complete — 87 PRs embedded in 4m 12s
[Cluster] Complete — 12 candidate groups
[Verify]  Complete — 8 confirmed duplicate groups
[Rank]    Complete — 8 groups ranked. Scan finished.
```

---

## Phase 5 — Stall Detection

| Mode | Stall timeout |
|------|---------------|
| Sequential (default) | **5 minutes** of no new log lines |
| Batch mode (embed/verify/rank with batch APIs) | **30 minutes** of no new log lines |

To detect stalls without blocking, compare the log file's modification time or
line count between consecutive `tail` checks. If the line count hasn't changed
across several checks spanning the timeout window, it's a stall.

When a stall is detected:

1. Print last 50 lines of the log
2. Check if API process is alive: `kill -0 <PID>`
3. Check Qdrant health: `curl http://localhost:6333/collections`
4. If process died, check stderr for crash info
5. Enter self-heal loop (Phase 6)

---

## Phase 6 — Self-Heal Loop (Auto-Fix)

When an error is detected in logs (lines containing `ERROR`, `error`, `failed`,
stack traces, or non-zero exit codes):

### Step 1 — Diagnose

- Read the full error message and 20 lines of surrounding context
- Identify the failing source file and function from the stack trace
- Read the relevant source code to understand the bug

### Step 2 — Fix (no approval gate)

- Apply the code fix using the Edit tool
- Keep a running list of fixed files and one-line descriptions for each fix
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

Go back to **Phase 3** (compact, clear scans, re-dispatch). The clear ensures
no stale scan state interferes. ETag caching still applies at the GitHub layer,
so previously fetched PR diffs won't be re-downloaded.

### Step 3.5 — Commit on success

When a retry scan completes **successfully** (reaches Phase 7), commit all
accumulated fixes before moving to results. This preserves every fix so they
are not lost between sessions.

```bash
cd /Users/dhruv/Code/ossgard
git add -A -- packages/   # only source code, not logs/dist
git commit -m "fix: <concise summary of all fixes applied>

Applied during smoke-test run against <owner/repo> (limit <N>).

Fixes:
- <one-line description of fix 1>
- <one-line description of fix 2>
...

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

Print: `[Commit] <N> fix(es) committed — <short commit hash>`

If there are no uncommitted changes (e.g. all fixes were already committed in
a prior cycle), skip this step silently.

### Step 4 — Escalate

- If the **same error** recurs after a fix, **STOP** and escalate to the user
  with full context (error, attempted fix, why it didn't work)
- If a **different error** occurs, repeat from Step 1

---

## Phase 7 — Results

```bash
$HOME/.local/bin/ossgard dupes <owner/repo>
```

Print the full output. No interactive walkthrough — just the raw results.

**Success criteria:** Exit 0. Output shows duplicate groups (or "No duplicate
groups found", which is valid).

---

## Phase 8 — Cleanup

```bash
pkill -f ossgard-api || true
rm -f /tmp/ossgard-api.log
```

Print final summary:

```
[Complete] Smoke test passed.
  Repo:    <owner/repo>
  PR cap:  <N>
  Groups:  <count> duplicate groups found
  Fixes:   <count> auto-applied and committed (<short hash>)
```

---

## Quick Reference

| Action | Command |
|--------|---------|
| Build everything | `bun install && bun run build && bun run build:api && bun run build:cli` |
| Start API server | `LOG_LEVEL=info $HOME/.local/bin/ossgard-api > /tmp/ossgard-api.log 2>&1 &` |
| Health check | `curl -sf http://localhost:3400/health` |
| Clear old scans | `$HOME/.local/bin/ossgard clear-scans --force` |
| Dispatch scan | `$HOME/.local/bin/ossgard scan <repo> --limit <N> --strategy <strategy> --no-wait` |
| View results | `$HOME/.local/bin/ossgard dupes <repo>` |
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
