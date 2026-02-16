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

- [Bun](https://bun.sh) >= 1.0 (to build from source)
- A [Qdrant](https://qdrant.tech) instance (local or cloud)
- An LLM/embedding provider: [Ollama](https://ollama.ai) (local) or cloud (Anthropic/OpenAI)
- A GitHub Personal Access Token (PAT)

### Build

```bash
git clone https://github.com/your-org/ossgard.git
cd ossgard
bun install
bun run build
bun run build:api    # standalone API server binary
bun run build:cli    # standalone CLI binary
```

This produces two standalone binaries — no runtime dependencies needed:

```
packages/api/dist/ossgard-api    # API server
packages/cli/dist/ossgard        # CLI
```

Optionally, add them to your PATH:

```bash
sudo cp ./packages/cli/dist/ossgard /usr/local/bin/ossgard
sudo cp ./packages/api/dist/ossgard-api /usr/local/bin/ossgard-api
```

### Run

Start the API server in one terminal, use the CLI in another:

```
Terminal 1                       Terminal 2

$ ossgard-api                    $ ossgard init
  API listening on :3400           Config created at ~/.ossgard/config.toml

                                 $ ossgard track facebook/react
                                 $ ossgard scan facebook/react
                                 $ ossgard dupes facebook/react
```

### Local AI stack (optional)

ossgard needs a vector store (Qdrant) and an LLM/embedding provider. You can use cloud-hosted services, native installs, or the provided Docker Compose files for a fully local setup.

**Vector store (Qdrant):**

```bash
docker compose -f local-ai/vector-store.yml up -d     # start
docker compose -f local-ai/vector-store.yml down       # stop
docker compose -f local-ai/vector-store.yml down -v    # stop and remove data
```

**LLM and embedding provider (Ollama):**

```bash
docker compose -f local-ai/llm-provider.yml up -d     # start
docker compose -f local-ai/llm-provider.yml down       # stop
docker compose -f local-ai/llm-provider.yml down -v    # stop and remove data

# Pull the required models
ollama pull nomic-embed-text    # embeddings
ollama pull llama3              # LLM for verify/rank
```

The default config points to `localhost:6333` (Qdrant) and `localhost:11434` (Ollama), so no config changes are needed when running locally.

If you prefer cloud providers instead, update your config:

```bash
ossgard config set vector_store.url "https://your-qdrant-cloud-url"
ossgard config set vector_store.api_key "your-api-key"
ossgard config set llm.provider "anthropic"
ossgard config set llm.api_key "your-api-key"
ossgard config set embedding.provider "openai"
ossgard config set embedding.api_key "your-api-key"
```

### Usage

```bash
ossgard track facebook/react       # start tracking a repo
ossgard scan facebook/react        # run a duplicate scan
ossgard dupes facebook/react       # view duplicate groups
ossgard status                     # list tracked repos
ossgard config show                # view current configuration
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
api_key = ""                           # required for Qdrant Cloud
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
| `DATABASE_PATH` | SQLite database location (default `~/.ossgard/ossgard.db`) |
| `PORT` | API server port (default `3400`) |
| `CONFIG_PATH` | Alternate config file location |

**Note:** Switching embedding providers changes vector dimensions. ossgard automatically detects dimension mismatches in Qdrant and recreates collections as needed (existing vectors will be lost — a re-scan is required).

### Development

```bash
bun run dev       # Run API with hot reload
bun run test      # Run unit tests across all packages
bun run build:api # Compile standalone API binary
bun run build:cli # Compile standalone CLI binary
```

#### End-to-end tests

E2E tests exercise the full stack using the standalone binaries. They start the `ossgard-api` binary as a subprocess and shell out to the `ossgard` CLI for all commands.

**Setup:**

```bash
# 1. Start the local AI stack
docker compose -f local-ai/vector-store.yml up -d
docker compose -f local-ai/llm-provider.yml up -d
ollama pull nomic-embed-text
ollama pull llama3

# 2. Build standalone binaries
bun run build && bun run build:api && bun run build:cli

# 3. Run the tests
bun run test:e2e
```

The smoke tests (`e2e/smoke.test.ts`) only need the binaries built — they don't require the local AI stack. The full pipeline test (`e2e/openclaw.test.ts`) requires everything and will skip gracefully if services aren't available.

## Project structure

```
packages/
  api/       Hono HTTP server, pipeline processors, services, SQLite DB
  cli/       Commander-based CLI (init, config show/get/set, track, scan, dupes, status)
  shared/    Types and Zod schemas shared across packages
local-ai/
  vector-store.yml    Local Qdrant via Docker (optional)
  llm-provider.yml    Local Ollama via Docker (optional)
```
