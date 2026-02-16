# ossgard

A local-first CLI tool that scans GitHub repositories for duplicate pull requests and ranks the best PR in each group. Built for large open-source projects where maintainers face thousands of open PRs and can't manually detect overlap.

ossgard combines code-level similarity (embedding diffs) with intent-level analysis (LLM verification) to surface true duplicates with high precision, then ranks them by code quality so maintainers know which PR to merge.

## Architecture

```
┌──────────┐         ┌─────────────────────────────────────────────────┐
│          │  HTTP   │              Docker Compose                     │
│   CLI    │────────►│                                                 │
│ (ossgard)│  :3400  │  ┌───────────┐  ┌─────────┐  ┌─────────────┐  │
│          │◄────────│  │    API    │  │  Qdrant  │  │   Ollama    │  │
└──────────┘         │  │  (Hono)   │  │ (vectors)│  │(LLM+embeds) │  │
                     │  │           │──►│  :6333   │  │   :11434    │  │
                     │  │  SQLite   │  └─────────┘  └─────────────┘  │
                     │  │  (jobs+   │───────────────────────┘         │
                     │  │   data)   │                                 │
                     │  └─────┬─────┘                                 │
                     └────────┼───────────────────────────────────────┘
                              │
                              ▼
                     ┌─────────────┐
                     │  GitHub API │
                     └─────────────┘
```

### Pipeline

Every scan runs through five chained job phases:

```
Ingest ──► Embed ──► Cluster ──► Verify ──► Rank
```

| Phase | What it does |
|-------|-------------|
| **Ingest** | Fetches open PRs, diffs, and file lists from GitHub (supports ETags for incremental scans) |
| **Embed** | Generates two 768-dim vectors per PR via Ollama — a code fingerprint (from the diff) and an intent fingerprint (from title + body + files) |
| **Cluster** | Groups PRs by identical diff hashes (fast path) then by embedding similarity using union-find (code > 0.85, intent > 0.80) |
| **Verify** | Sends candidate groups to the LLM to filter false positives and classify relationships |
| **Rank** | Asks the LLM to score and rank PRs within each verified group by code quality and completeness |

Jobs are queued in SQLite and processed by an in-process worker loop, making scans resumable across restarts.

## Setup

### Prerequisites

- Node.js >= 22
- pnpm
- Docker & Docker Compose
- A GitHub Personal Access Token (PAT)

### Install and run

```bash
# Clone and install dependencies
git clone https://github.com/your-org/ossgard.git
cd ossgard
pnpm install
pnpm build

# Initialize config (creates ~/.ossgard/config.toml, prompts for GitHub PAT)
pnpm --filter cli exec ossgard init

# Start the stack (API + Qdrant + Ollama)
pnpm --filter cli exec ossgard up --detach

# Track a repo and scan it
pnpm --filter cli exec ossgard track facebook/react
pnpm --filter cli exec ossgard scan facebook/react

# View duplicate groups
pnpm --filter cli exec ossgard dupes facebook/react
```

### Docker Compose services

| Service | Port | Purpose |
|---------|------|---------|
| **api** | 3400 | Hono HTTP server + job worker |
| **qdrant** | 6333 | Vector database for PR embeddings |
| **ollama** | 11434 | Local LLM and embedding model |

### Configuration

Config lives at `~/.ossgard/config.toml`:

```toml
[github]
token = "ghp_..."

[llm]
provider = "ollama"         # or "anthropic"
model = "llama3"

[embedding]
model = "nomic-embed-text"
```

Environment variables (`GITHUB_TOKEN`, `LLM_PROVIDER`, `LLM_MODEL`, `QDRANT_URL`, `OLLAMA_URL`) override TOML values.

### Development

```bash
pnpm dev          # Run API with hot reload (tsx watch)
pnpm test         # Run unit tests across all packages
pnpm test:e2e     # Run end-to-end tests (requires running stack)
```

## Project structure

```
packages/
  api/       Hono HTTP server, pipeline processors, services, SQLite DB
  cli/       Commander-based CLI (track, scan, dupes, status, up/down)
  shared/    Types and Zod schemas shared across packages
```
