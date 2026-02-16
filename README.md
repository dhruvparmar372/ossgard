# ossgard

A local-first CLI tool that scans GitHub repositories for duplicate pull requests and ranks the best PR in each group. Built for large open-source projects where maintainers face thousands of open PRs and can't manually detect overlap.

ossgard combines code-level similarity (embedding diffs) with intent-level analysis (LLM verification) to surface true duplicates with high precision, then ranks them by code quality so maintainers know which PR to merge.

## Architecture

```
                     ┌───────────┐
┌──────────┐  HTTP   │           │
│   CLI    │────────►│    API    │──────► GitHub API
│ (ossgard)│  :3400  │  (Hono)   │
│          │◄────────│  SQLite   │
└──────────┘         └─────┬─────┘
                           │
                     ┌─────┴──────┐
                     │            │
                ┌────▼────┐ ┌────▼─────┐
                │  Qdrant │ │ LLM/Embed│
                │(vectors)│ │ Provider │
                └─────────┘ └──────────┘
```

The API server connects to a vector store (Qdrant) and LLM/embedding providers (Ollama or cloud). These services run independently — start them however you like (native install, Docker, cloud-hosted, etc.).

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

- [Bun](https://bun.sh) >= 1.0
- A [Qdrant](https://qdrant.tech) instance (local or cloud)
- An LLM/embedding provider: [Ollama](https://ollama.ai) (local) or cloud (Anthropic/OpenAI)
- A GitHub Personal Access Token (PAT)

### Install and run

```bash
# Clone and install dependencies
git clone https://github.com/your-org/ossgard.git
cd ossgard
bun install
bun run build

# Compile standalone CLI binary
bun run build:cli

# Initialize config (creates ~/.ossgard/config.toml, prompts for GitHub PAT)
./packages/cli/dist/ossgard init

# Start services (example using Docker, but any method works)
docker run -d -p 6333:6333 qdrant/qdrant:latest
docker run -d -p 11434:11434 ollama/ollama:latest

# Pull Ollama models (if using Ollama)
ollama pull nomic-embed-text
ollama pull llama3

# Start the API server
bun run dev

# Track a repo and scan it
./packages/cli/dist/ossgard track facebook/react
./packages/cli/dist/ossgard scan facebook/react

# View duplicate groups
./packages/cli/dist/ossgard dupes facebook/react
```

### Configuration

Config lives at `~/.ossgard/config.toml`:

```toml
[github]
token = "ghp_..."

[llm]
provider = "ollama"                    # "ollama" | "anthropic"
url = "http://localhost:11434"         # provider base URL
model = "llama3"
api_key = ""
batch = false

[embedding]
provider = "ollama"                    # "ollama" | "openai"
url = "http://localhost:11434"         # provider base URL
model = "nomic-embed-text"
api_key = ""
batch = false

[vector_store]
url = "http://localhost:6333"          # Qdrant URL
```

The default config uses local Ollama for both chat and embeddings — no API keys needed. To use cloud providers, set the provider, URL, and supply an API key.

#### Batch processing

When using cloud providers, setting `batch = true` enables asynchronous batch APIs:

- **Anthropic** (`llm.batch = true`): Uses the [Message Batches API](https://docs.anthropic.com/en/docs/build-with-claude/message-batches) to process verify and rank jobs. Requests are submitted as a batch and polled until completion. Anthropic offers a 50% cost discount on batch requests.
- **OpenAI** (`embedding.batch = true`): Uses the [Batch API](https://platform.openai.com/docs/guides/batch) to process embedding requests via file upload and polling.

Batch mode is ignored for Ollama (no batch API). When only a single request exists in a pipeline step, the provider falls back to the standard sync path automatically.

**Prompt caching:** Anthropic providers (both sync and batch) automatically use [prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) on system prompts. Since verify and rank use the same system prompt for every group in a scan, all calls after the first get a cache hit, reducing cost and latency.

#### Environment variables

A small set of env vars are supported for deployment flexibility:

| Variable | Purpose |
|----------|---------|
| `GITHUB_TOKEN` | Override config token (useful in CI/CD) |
| `DATABASE_PATH` | SQLite database location (default `./ossgard.db`) |
| `PORT` | API server port (default `3400`) |
| `CONFIG_PATH` | Alternate config file location |

**Note:** Switching embedding providers changes vector dimensions. ossgard automatically detects dimension mismatches in Qdrant and recreates collections as needed (existing vectors will be lost — a re-scan is required).

#### Docker Compose (optional)

A convenience `docker-compose.yml` is provided in `deploy/` for running the full stack in Docker:

```bash
cd deploy
docker compose up -d
```

When using Docker Compose, set the service URLs in your config to use Docker networking:
- `llm.url = "http://ollama:11434"`
- `embedding.url = "http://ollama:11434"`
- `vector_store.url = "http://qdrant:6333"`

### Development

```bash
bun run dev       # Run API with hot reload
bun run test      # Run unit tests across all packages
bun run test:e2e  # Run end-to-end tests (requires Qdrant + Ollama)
bun run build:cli # Compile standalone CLI binary
```

## Project structure

```
packages/
  api/       Hono HTTP server, pipeline processors, services, SQLite DB
  cli/       Commander-based CLI (init, config, track, scan, dupes, status)
  shared/    Types and Zod schemas shared across packages
deploy/
  docker-compose.yml   Optional Docker Compose for full-stack deployment
```
