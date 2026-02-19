---
name: try
description: Guided demo — build ossgard, start services, scan a repo, and review duplicate PRs
---

# ossgard — Guided Demo

You are walking an open-source maintainer through their first ossgard experience.
Your job is to get everything running, scan a repo of their choice, and show them
the duplicate-detection results. Be friendly, concise, and keep them informed at
every step.

## Communication style

Print a status line before and after every phase:

```
[Phase N] Starting — <what is about to happen>
[Phase N] Done — <one-line summary with key numbers>
```

Be concise but informative. Include concrete numbers when available.
If something is taking a while, say so — silence is worse than a "still waiting" message.

---

## Phase 1 — Preflight

Check that the host machine has the minimum requirements. Run these checks
and report results:

```bash
bun --version        # required — runtime for building ossgard
docker --version     # required — for Qdrant (and optionally Ollama)
```

If `bun` is missing, tell them to install it: https://bun.sh
If `docker` is missing, tell them to install Docker Desktop: https://docker.com

Stop here if either is missing — everything else depends on these two.

---

## Phase 2 — Build

Build ossgard from source and install the binaries locally.

```bash
cd <project-root>
bun install
bun run build
bun run build:api
bun run build:cli
```

Install to `$HOME/.local/bin/`:

```bash
mkdir -p "$HOME/.local/bin"
cp packages/api/dist/ossgard-api "$HOME/.local/bin/ossgard-api"
cp packages/cli/dist/ossgard     "$HOME/.local/bin/ossgard"
```

Verify: `$HOME/.local/bin/ossgard --help` should print usage.

---

## Phase 3 — Start Services

### 3.1 — Qdrant (vector store)

Check if Qdrant is already running:

```bash
curl -sf http://localhost:6333/collections
```

If NOT running, start it:

```bash
docker compose -f local-ai/vector-store.yml up -d
```

Then poll until healthy (timeout 30s):

```bash
for i in $(seq 1 60); do
  curl -sf http://localhost:6333/collections && break
  sleep 0.5
done
```

### 3.2 — LLM and Embedding providers

Ask the maintainer which stack they'd like to use:

**Option A: Fully local (Ollama)** — free, private, slower
- Check if Ollama is already running: `curl -sf http://localhost:11434/api/tags`
- If not running, start it: `docker compose -f local-ai/llm-provider.yml up -d`
- Pull the required models:
  ```bash
  docker exec ossgard-llm-provider-ollama-1 ollama pull llama3
  docker exec ossgard-llm-provider-ollama-1 ollama pull nomic-embed-text
  ```
- Note: model pulls can take a few minutes on first run. Keep the user informed.

**Option B: Cloud APIs (Anthropic + OpenAI)** — faster, costs money
- They will need an Anthropic API key (for LLM) and an OpenAI API key (for embeddings)
- No Docker containers needed for this option
- Note: the setup wizard in Phase 5 will collect the actual keys

Tell the maintainer what each option entails and let them choose.

---

## Phase 4 — Start the API Server

```bash
# Kill any existing instance
pkill -f ossgard-api || true
sleep 1

# Start in background
LOG_LEVEL=info $HOME/.local/bin/ossgard-api > /tmp/ossgard-api.log 2>&1 &
```

Wait for the health check:

```bash
for i in $(seq 1 30); do
  curl -sf http://localhost:3400/health && break
  sleep 0.5
done
```

If the health check fails after 15s, show the last 20 lines of `/tmp/ossgard-api.log`
and stop.

---

## Phase 5 — Setup (Account Registration)

Check if ossgard is already configured:

```bash
$HOME/.local/bin/ossgard config show
```

If already configured, ask the maintainer if they want to keep the existing config
or reconfigure. If they want to reconfigure, add `--force`.

Run the interactive setup wizard:

```bash
$HOME/.local/bin/ossgard setup
```

This wizard will prompt the maintainer for:
- GitHub Personal Access Token (needs `repo` scope for private repos, or just public access for public repos)
- LLM provider choice and credentials (based on Phase 3 choice)
- Embedding provider choice and credentials
- Qdrant URL (defaults to localhost:6333)

**Important:** Let the maintainer interact with the wizard directly. Do not
pre-fill answers — the wizard handles its own prompts. Just run the command
and wait for it to complete.

---

## Phase 6 — Scan a Repository

Ask the maintainer which repository they'd like to scan. Suggest:
- Their own repo if you know it from context
- A medium-sized repo like `openclaw/openclaw` (~80 PRs) for a quick demo
- Warn that very large repos (1000+ PRs) will take longer, especially with Ollama

Also ask if they'd like to cap the number of PRs to ingest. This is optional —
the default is uncapped (all open PRs). A cap like 50-100 is useful for a quick
first demo, especially with Ollama.

### 6.1 — Dispatch the scan

> **CRITICAL — Non-blocking scan monitoring**
>
> The scan can take minutes to hours. Never run the scan CLI in a blocking
> way that locks the conversation. Instead use `--no-wait` and monitor logs
> in the background so the maintainer can still chat with you.

Dispatch the scan in fire-and-forget mode:

```bash
# Without cap:
$HOME/.local/bin/ossgard scan <owner/repo> --no-wait

# With cap:
$HOME/.local/bin/ossgard scan <owner/repo> --limit <N> --no-wait
```

Then start a background watcher using the Bash tool with `run_in_background`:

```bash
# Watches for scan completion or errors, exits when found
while true; do
  if grep -q 'Scan complete\|scan_status=done\|status=failed\|ERROR' /tmp/ossgard-api.log 2>/dev/null; then
    echo "---SCAN-EVENT-DETECTED---"
    tail -80 /tmp/ossgard-api.log
    break
  fi
  sleep 10
done
```

Monitor progress by periodically checking `TaskOutput` with `block=false` and
running quick `tail -30 /tmp/ossgard-api.log` reads. Report phase transitions
to the maintainer as they happen:

```
[Ingest]  Complete — 87 PRs fetched, 3 skipped
[Embed]   Complete — 87 PRs embedded
[Cluster] Complete — 12 candidate groups
[Verify]  Complete — 8 confirmed duplicate groups
[Rank]    Complete — 8 groups ranked. Scan finished.
```

**If the scan fails:**
1. Print the error message from the log output
2. Show the last 30 lines of the API log: `tail -30 /tmp/ossgard-api.log`
3. Diagnose the issue and explain it to the maintainer
4. Do NOT attempt to auto-fix code — this is a demo, not a dev workflow

**Timing expectations:**
- Ingest: ~1-2 min for 100 PRs (GitHub API rate limited)
- Embed with OpenAI: ~1-2 min for 100 PRs
- Embed with Ollama: ~5-15 min for 100 PRs (depends on hardware)
- Verify + Rank with Anthropic: ~1-2 min
- Verify + Rank with Ollama: ~5-20 min

---

## Phase 7 — Show Results

### 7.1 — Duplicate groups overview

Run the interactive dupes viewer:

```bash
$HOME/.local/bin/ossgard dupes <owner/repo>
```

This shows a stats summary and walks through each group interactively.
Let the maintainer drive the Y/n prompts.

If no duplicates were found, explain that this is a valid result — it means
the repo's open PRs are well-differentiated.

### 7.2 — Per-PR review (optional)

After showing the groups, offer to review a specific PR:

```
Would you like to check a specific PR for duplicates?
You can provide a PR number or GitHub URL.
```

If yes, run:

```bash
$HOME/.local/bin/ossgard review <owner/repo> <pr-number>
```

This shows any existing dupe groups containing that PR, plus similar PRs
found via vector similarity.

---

## Phase 8 — Handoff

Print a summary and hand control to the maintainer:

```
--- ossgard is ready ---

Your setup:
  API server:  http://localhost:3400 (PID: <pid>, logs: /tmp/ossgard-api.log)
  Vector store: http://localhost:6333 (Qdrant via Docker)
  Database:    ~/.ossgard/ossgard.db

Commands you can try:
  ossgard scan <owner/repo>          Scan another repository
  ossgard dupes <owner/repo>         View duplicate groups
  ossgard review <owner/repo> <pr>   Check a specific PR for duplicates
  ossgard status                     List tracked repos and scans
  ossgard dupes <owner/repo> --json  Machine-readable output

To stop services when done:
  pkill -f ossgard-api
  docker compose -f local-ai/vector-store.yml down
```

After printing this, you're done. The maintainer can continue using ossgard
commands in this session or open a separate terminal. Answer any follow-up
questions they have.
