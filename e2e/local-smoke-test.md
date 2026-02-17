# Local Smoke Test — Claude-Operated E2E Workflow

This document is a step-by-step runbook for Claude to execute the full ossgard
stack locally, monitor it via logs, and self-heal on errors. No human
intervention is required unless Claude encounters an error it wants reviewed
before applying a fix.

---

## Claude's Communication Style

Throughout this workflow, Claude must keep the user informed by printing
status messages directly into the conversation. The user is watching the
session and needs to know what is happening at all times.

### When to emit messages

| Situation | What to print |
|---|---|
| Starting a phase | `[Phase N] Starting — <what is about to happen>` |
| Phase completed successfully | `[Phase N] Done — <summary with key numbers>` |
| Waiting for logs | `[Waiting] Watching logs... last activity Xs ago` (every ~60s) |
| Progress during long phases | `[Progress] Ingest: 45/87 PRs fetched...` (every ~30s or on notable milestones) |
| Stall detected | `[Stall] No new logs for 5 minutes. Investigating...` |
| Error spotted in logs | `[Error] Spotted an error in API logs. Diagnosing...` |
| Diagnosis complete | `[Diagnosis] <concise summary of what broke and why>` |
| Proposing a fix | `[Fix Proposal] <description + diff>` — then wait for approval |
| Rebuilding after fix | `[Rebuilding] Applying fix, rebuilding binaries...` |
| Re-running after fix | `[Retry] Restarting from Phase 3 with clean slate...` |
| Pipeline finished | `[Complete] Scan finished successfully. Fetching results...` |

### Tone

- Be concise but informative. One or two lines per message is ideal.
- Include concrete numbers when available (PR counts, durations, group counts).
- If something is taking a while, say so — silence is worse than a "still waiting" message.
- When reporting errors, lead with the impact ("Embed phase crashed") before the technical detail.

---

## Assumptions

These must already be true on the host machine. If any check fails, abort
immediately and tell the user what is missing.

| Requirement | How to verify |
|---|---|
| Qdrant running on `localhost:6333` | `curl -sf http://localhost:6333/collections` returns `{"status":"ok",...}` |
| Valid CLI config at `~/.ossgard/config.toml` | File exists and contains non-empty `key` under `[api]` |
| Bun installed | `bun --version` succeeds |

> Ollama, OpenAI keys, Anthropic keys, etc. are stored server-side in the
> ossgard DB and are configured during `ossgard setup`. This workflow does not
> re-run setup — it trusts whatever account config already exists.

---

## Phase 0 — Preflight Checks

Run these checks before doing anything else. If any fail, stop and report.

```
1. curl -sf http://localhost:6333/collections      → must return 200
2. test -f ~/.ossgard/config.toml                 → must exist
3. grep -q 'key = "' ~/.ossgard/config.toml       → must have a non-empty API key
4. bun --version                                  → must succeed
```

---

## Phase 1 — Clean Build & Install

Goal: produce fresh `ossgard-api` and `ossgard` binaries and copy them to
`/usr/local/bin` so they are available system-wide.

```bash
cd /Users/dhruv/Code/ossgard
INSTALL_DIR="${HOME}/.local/bin"

# 1. Install dependencies
bun install

# 2. Compile TypeScript → JS for all packages
bun run build

# 3. Compile standalone binaries
bun run build:api      # → packages/api/dist/ossgard-api
bun run build:cli      # → packages/cli/dist/ossgard

# 4. Install to user-local bin (no sudo needed)
mkdir -p "$INSTALL_DIR"
cp packages/api/dist/ossgard-api "$INSTALL_DIR/ossgard-api"
cp packages/cli/dist/ossgard     "$INSTALL_DIR/ossgard"
```

> All subsequent commands in this workflow use full paths
> (`$HOME/.local/bin/ossgard`, `$HOME/.local/bin/ossgard-api`) so PATH
> configuration is not required.

**Success criteria:**
- All commands exit 0.
- `$HOME/.local/bin/ossgard --help` prints usage.
- `$HOME/.local/bin/ossgard-api` launches (verified via health check in next phase).

---

## Phase 2 — Start the API Server

Goal: launch `ossgard-api` in the background and continuously tail its stdout
so Claude can monitor pipeline progress and catch errors.

```bash
# Kill any existing ossgard-api process to avoid port conflicts
pkill -f ossgard-api || true

# Start the server, logging to a known file
LOG_LEVEL=info $HOME/.local/bin/ossgard-api > /tmp/ossgard-api.log 2>&1 &
echo $!  # capture PID for cleanup later
```

**Wait for readiness:**

```bash
# Poll until /health returns 200 (timeout: 15 seconds)
for i in $(seq 1 30); do
  curl -sf http://localhost:3400/health && break
  sleep 0.5
done
```

**Success criteria:**
- `curl http://localhost:3400/health` returns `{"status":"ok"}`.

**How Claude should tail logs:**

Use a background shell to run:
```bash
tail -f /tmp/ossgard-api.log
```

Read from this periodically (every 10–15 seconds during active phases, every
30 seconds during idle waits) to observe progress and detect errors.

---

## Phase 3 — Compact Context, Clear Scans & Dispatch

Goal: free up context window space, wipe any existing scan data so we start
from a clean slate, then kick off a fresh scan of `openclaw/openclaw`.

### 3.1 — Compact context window

Before starting (or restarting) a scan, Claude must run the `/compact` command
to compress the conversation history. This ensures maximum context room is
available for observing logs and debugging during the run.

When compacting, Claude should include a summary hint so the compacted context
preserves the essential state:

```
/compact Running e2e/local-smoke-test.md workflow. Currently at Phase 3 —
about to dispatch a scan of openclaw/openclaw. API server is running on
localhost:3400, logs at /tmp/ossgard-api.log. <include any known errors from
prior runs if this is a retry>
```

### 3.2 — Clear previous scans

```bash
# Clear all previous scan data (keeps tracked repos, deletes scans + analysis)
$HOME/.local/bin/ossgard clear-scans --force
```

### 3.3 — Dispatch the scan

```bash
$HOME/.local/bin/ossgard scan openclaw/openclaw --no-wait
```

> `--no-wait` returns immediately after dispatching. Claude will monitor
> progress through the API server logs instead of the CLI's polling loop. This
> gives Claude richer diagnostics.

**Success criteria:**
- Exit code 0.
- Output contains `Scan #<N> started` (or similar confirmation).

---

## Phase 4 — Monitor Pipeline Progress

Once the scan is dispatched, the API server processes it through five
sequential phases:

```
Ingest → Embed → Cluster → Verify → Rank → Done
```

Claude should tail `/tmp/ossgard-api.log` and watch for the following
milestones:

### 4.1 — Ingest Phase
Look for:
```
[api:ingest] Ingest started ...
[api:ingest] Fetched PR list ... total=<N>
[api:ingest] PR ingested ... progress=<X>/<N>
[api:ingest] Ingest complete ...
```

### 4.2 — Embed Phase
Look for:
```
[api:embed] Embed started ... prCount=<N>
[api:embed] Embedding batch ... progress=<X>/<N>
[api:embed] Embed complete ...
```

### 4.3 — Cluster Phase
Look for:
```
[api:cluster] Cluster started ...
[api:cluster] Candidate groups ... count=<N>
```

### 4.4 — Verify Phase
Look for:
```
[api:verify] Verify started ... candidates=<N>
[api:verify] Group verified ... group=<X>/<N>
[api:verify] Verified groups ... count=<N>
```

### 4.5 — Rank Phase
Look for:
```
[api:rank] Rank started ... groups=<N>
[api:rank] Group ranked ... group=<X>/<N>
[api:rank] Scan complete ...
```

### How to report progress

After each phase completes, Claude should print a short summary to the user:

```
[Ingest] Complete — 87 PRs fetched, 3 skipped (diff too large)
[Embed]  Complete — 87 PRs embedded in 4m 12s
[Cluster] Complete — 12 candidate groups from 87 PRs
[Verify] Complete — 8 confirmed duplicate groups
[Rank]   Complete — 8 groups ranked. Scan finished.
```

---

## Phase 5 — Stall Detection

**Rule:** Use the appropriate timeout based on the current mode:

| Mode | Stall timeout |
|------|---------------|
| Sequential (default) | **5 minutes** of no new log lines |
| Batch mode (embed/verify/rank phases) | **30 minutes** of no new log lines |

> **Note:** Batch phases (embed, verify, rank) can take hours when using
> OpenAI batch embeddings or Anthropic batch LLM. During these phases, look
> for `[api:openai-batch]` or `[api:anthropic-batch]` prefixed log lines to
> track polling progress. These lines include `elapsedMs` and `nextPollMs`
> fields. Claude should check logs every 5 minutes during batch phases.

When a stall is detected:

1. Print the last 50 lines of the log to understand context.
2. Check if the API process is still alive (`kill -0 <PID>`).
3. Check Qdrant health (`curl http://localhost:6333/collections`).
4. If the process died, check stderr for crash info.
5. Report findings to the user before attempting a fix.

---

## Phase 6 — Error Handling & Self-Heal Loop

When Claude spots an error in the logs (lines containing `ERROR`, `error`,
`failed`, stack traces, or non-zero exit codes):

### Step 1: Diagnose
- Read the full error message and surrounding context (20 lines before/after).
- Identify the failing source file and function from the stack trace.
- Read the relevant source code to understand the bug.

### Step 2: Propose Fix
- **Do NOT apply the fix silently.** Present the diagnosis and proposed change
  to the user and wait for approval.
- Show: (a) what broke, (b) the root cause, (c) the proposed code change as a
  diff.

### Step 3: Apply & Rebuild (after user approval)
```bash
# 1. Apply the code fix (Edit tool)
# 2. Rebuild
cd /Users/dhruv/Code/ossgard
bun run build && bun run build:api && bun run build:cli
cp packages/api/dist/ossgard-api "$HOME/.local/bin/ossgard-api"
cp packages/cli/dist/ossgard     "$HOME/.local/bin/ossgard"

# 3. Restart API server
pkill -f ossgard-api || true
sleep 1
LOG_LEVEL=info $HOME/.local/bin/ossgard-api > /tmp/ossgard-api.log 2>&1 &
# Wait for health check...
```

### Step 4: Re-run
Go back to **Phase 3** — clear scans and dispatch again. The clear ensures no
stale scan state interferes. ETag caching still applies at the GitHub layer,
so previously fetched PR diffs won't be re-downloaded.

### Step 5: Repeat
If the new run hits a different error, repeat from Step 1. If it hits the
same error, escalate to the user with more context.

---

## Phase 7 — Verify Results

Once the scan reaches `done` status:

```bash
$HOME/.local/bin/ossgard dupes openclaw/openclaw
```

**Success criteria:**
- Exit code 0.
- Output shows duplicate groups (or "No duplicate groups found", which is also
  a valid result for small repos).

Print the full output for the user to review.

---

## Phase 8 — Cleanup

```bash
# Stop the API server
pkill -f ossgard-api || true

# Optionally remove the log file
rm -f /tmp/ossgard-api.log
```

---

## Quick Reference: Key Paths

| What | Path |
|---|---|
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

## Quick Reference: Commands

| Action | Command |
|---|---|
| Build everything | `bun install && bun run build && bun run build:api && bun run build:cli` |
| Start API server | `LOG_LEVEL=info $HOME/.local/bin/ossgard-api > /tmp/ossgard-api.log 2>&1 &` |
| Health check | `curl -sf http://localhost:3400/health` |
| Clear old scans | `$HOME/.local/bin/ossgard clear-scans --force` |
| Dispatch scan | `$HOME/.local/bin/ossgard scan openclaw/openclaw --no-wait` |
| View results | `$HOME/.local/bin/ossgard dupes openclaw/openclaw` |
| Tail logs | `tail -f /tmp/ossgard-api.log` |
| Kill API server | `pkill -f ossgard-api` |
