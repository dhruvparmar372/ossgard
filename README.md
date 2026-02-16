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
| **Embed** | Generates two embedding vectors per PR (code fingerprint from the diff, intent fingerprint from title + body + files). Supports Ollama (768-dim default) and OpenAI `text-embedding-3-large` (3072-dim) |
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
model = "llama3"            # or "claude-haiku-4-5-20251001"
api_key = ""                # required for anthropic
batch = false               # enable batch processing (anthropic only)

[embedding]
provider = "ollama"         # or "openai"
model = "nomic-embed-text"  # or "text-embedding-3-large"
api_key = ""                # required for openai
batch = false               # enable batch processing (openai only)
```

The default stack uses local Ollama for both chat and embeddings — no API keys needed. To use cloud providers, set the provider and supply an API key.

#### Batch processing

When using cloud providers, setting `batch = true` enables asynchronous batch APIs:

- **Anthropic** (`llm.batch = true`): Uses the [Message Batches API](https://docs.anthropic.com/en/docs/build-with-claude/message-batches) to process verify and rank jobs. Requests are submitted as a batch and polled until completion. Anthropic offers a 50% cost discount on batch requests.
- **OpenAI** (`embedding.batch = true`): Uses the [Batch API](https://platform.openai.com/docs/guides/batch) to process embedding requests via file upload and polling.

Batch mode is ignored for Ollama (no batch API). When only a single request exists in a pipeline step, the provider falls back to the standard sync path automatically.

**Prompt caching:** Anthropic providers (both sync and batch) automatically use [prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) on system prompts. Since verify and rank use the same system prompt for every group in a scan, all calls after the first get a cache hit, reducing cost and latency.

Environment variables override TOML values:

| Variable | Purpose |
|----------|---------|
| `GITHUB_TOKEN` | GitHub Personal Access Token |
| `LLM_PROVIDER` | Chat provider (`ollama` or `anthropic`) |
| `LLM_MODEL` | Chat model name |
| `LLM_API_KEY` | API key for chat provider |
| `LLM_BATCH` | Enable LLM batch processing (`true` / `false`) |
| `EMBEDDING_PROVIDER` | Embedding provider (`ollama` or `openai`) |
| `EMBEDDING_MODEL` | Embedding model name |
| `EMBEDDING_API_KEY` | API key for embedding provider |
| `EMBEDDING_BATCH` | Enable embedding batch processing (`true` / `false`) |
| `OLLAMA_URL` | Ollama base URL (default `http://localhost:11434`) |
| `QDRANT_URL` | Qdrant base URL (default `http://localhost:6333`) |

**Note:** Switching embedding providers changes vector dimensions. ossgard automatically detects dimension mismatches in Qdrant and recreates collections as needed (existing vectors will be lost — a re-scan is required).

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
