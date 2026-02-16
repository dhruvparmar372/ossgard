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

$ ossgard-api                    $ ossgard setup
  API listening on :3400           → Collects GitHub token, LLM/embedding/vector store config
                                   → Registers account server-side, stores API key locally

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

The `ossgard setup` wizard defaults to `localhost:6333` (Qdrant) and `localhost:11434` (Ollama), so no changes are needed when running locally. To use cloud providers instead, provide the appropriate URLs and API keys during setup (or run `ossgard setup --force` to reconfigure).

### Usage

```bash
ossgard setup                      # register account + configure services
ossgard setup --force              # reconfigure an existing account
ossgard track facebook/react       # start tracking a repo
ossgard scan facebook/react        # run a duplicate scan
ossgard dupes facebook/react       # view duplicate groups
ossgard status                     # list tracked repos
ossgard config show                # view local CLI configuration
```

### Configuration

ossgard uses a split configuration model:

- **Local CLI config** (`~/.ossgard/config.toml`) — stores only the API server connection:

```toml
[api]
url = "http://localhost:3400"
key = "your-api-key"
```

- **Server-side account config** — stores all service credentials (GitHub token, LLM/embedding providers, vector store). This is set during `ossgard setup` and stored in the API server's database per account.

The setup wizard collects everything in one step: GitHub PAT, LLM provider (Ollama or Anthropic), embedding provider (Ollama or OpenAI), and vector store (Qdrant). To reconfigure, run `ossgard setup --force`.

Repositories and PRs are global — multiple accounts tracking the same repo share fetched data. Only the analysis (scans, duplicate groups, rankings) is account-scoped, since different LLM/embedding configurations produce different results.

#### Batch processing

When using cloud providers, enabling batch mode during setup uses asynchronous batch APIs:

- **Anthropic** (LLM batch): Uses the [Message Batches API](https://docs.anthropic.com/en/docs/build-with-claude/message-batches) to process verify and rank jobs. Requests are submitted as a batch and polled until completion. Anthropic offers a 50% cost discount on batch requests.
- **OpenAI** (embedding batch): Uses the [Batch API](https://platform.openai.com/docs/guides/batch) to process embedding requests via file upload and polling.

Batch mode is ignored for Ollama (no batch API). When only a single request exists in a pipeline step, the provider falls back to the standard sync path automatically.

**Prompt caching:** Anthropic providers (both sync and batch) automatically use [prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) on system prompts. Since verify and rank use the same system prompt for every group in a scan, all calls after the first get a cache hit, reducing cost and latency.

#### Environment variables

A small set of env vars are supported for deployment flexibility:

| Variable | Purpose |
|----------|---------|
| `DATABASE_PATH` | SQLite database location (default `~/.ossgard/ossgard.db`) |
| `PORT` | API server port (default `3400`) |

All user configuration (GitHub token, LLM/embedding providers, vector store) is stored server-side per account. Run `ossgard setup` to register an account and configure services.

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

#### API authentication

All API endpoints (except `/health` and `POST /accounts`) require an API key via the `Authorization: Bearer <key>` header. The CLI handles this automatically using the key stored during setup.

## Project structure

```
packages/
  api/       Hono HTTP server, pipeline processors, services, SQLite DB
               - middleware/    API key auth
               - routes/       REST endpoints (accounts, repos, scans, dupes)
               - services/     Service resolver, validators, LLM/embedding/vector providers
               - pipeline/     Job processors (ingest, embed, cluster, verify, rank)
  cli/       Commander-based CLI (setup, config, track, scan, dupes, status)
  shared/    Types and Zod schemas shared across packages
local-ai/
  vector-store.yml    Local Qdrant via Docker (optional)
  llm-provider.yml    Local Ollama via Docker (optional)
```
