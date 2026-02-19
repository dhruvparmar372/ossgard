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

Every scan runs through two chained job phases — Ingest and Detect — where Detect runs the full pairwise-llm duplicate detection strategy internally:

```
Ingest ──► Detect (Intent Extract → Embed → Candidate Retrieval → Pairwise Verify → Group → Rank)
```

| Phase | What it does |
|-------|-------------|
| **Ingest** | Fetches open PRs, diffs, and file lists from GitHub using a 10-worker parallel pool. Supports ETags for diff caching and skips unchanged PRs by comparing `updatedAt` timestamps for fast incremental scans |
| **Detect** | Runs the pairwise-llm strategy end-to-end: (1) LLM extracts a normalized intent summary per PR, (2) embeds intent + code diffs into Qdrant, (3) k-NN candidate retrieval on both signals, (4) pairwise LLM verification of each candidate pair, (5) clique-based grouping (no transitivity), (6) LLM ranking by code quality and completeness. Tracks input/output token usage per scan |

Jobs are queued in SQLite and processed by an in-process worker loop, making scans resumable across restarts. On startup, the server recovers any interrupted jobs by resetting them back to `queued` status.

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

                                 $ ossgard scan facebook/react
                                   → Auto-tracks the repo if not already tracked
                                 $ ossgard duplicates facebook/react
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

# Pull the required models (pick one embedding model)
ollama pull nomic-embed-text    # embeddings (768-dim)
ollama pull mxbai-embed-large   # embeddings (1024-dim, alternative)
ollama pull llama3              # LLM for verify/rank
```

The `ossgard setup` wizard defaults to `localhost:6333` (Qdrant) and `localhost:11434` (Ollama), so no changes are needed when running locally. To use cloud providers instead, provide the appropriate URLs and API keys during setup (or run `ossgard setup --force` to reconfigure).

### Usage

```bash
ossgard setup                      # register account + configure services
ossgard setup --force              # reconfigure an existing account
ossgard doctor                     # check prerequisites and service health
ossgard scan facebook/react        # run a duplicate scan (auto-tracks repo)
ossgard scan facebook/react --full # full re-scan (ignore incremental optimizations)
ossgard scan facebook/react --no-wait  # start scan without waiting for completion
ossgard duplicates facebook/react  # view duplicate groups
ossgard duplicates facebook/react --min-score 70  # filter by minimum score
ossgard review facebook/react 1234 # find duplicates for a specific PR
ossgard status                     # list tracked repos and active scans
ossgard config show                # view local CLI configuration
ossgard config get api.url         # get a specific config value
ossgard config set api.url http://localhost:3400  # set a config value
ossgard clean --scans              # delete scans and analysis (keeps repos/PRs)
ossgard clean --repos              # delete repos, PRs, scans, and analysis
ossgard clean --all                # full reset — delete everything including accounts
```

Most commands support `--json` for machine-readable output.

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

#### Scan settings

The server-side account config supports optional scan settings to tune duplicate detection sensitivity:

| Setting | Default | Purpose |
|---------|---------|---------|
| `candidate_threshold` | 0.65 | Minimum cosine similarity for k-NN candidate retrieval |
| `max_candidates_per_pr` | 5 | Maximum number of nearest neighbors to consider per PR |

#### Batch processing

When using cloud providers, enabling batch mode during setup uses asynchronous batch APIs:

- **Anthropic** (LLM batch): Uses the [Message Batches API](https://docs.anthropic.com/en/docs/build-with-claude/message-batches) to process verify and rank jobs. Requests are submitted as a batch and polled until completion. Anthropic offers a 50% cost discount on batch requests.
- **OpenAI** (embedding batch): Uses the [Batch API](https://platform.openai.com/docs/guides/batch) to process embedding requests via file upload and polling.

Batch mode is ignored for Ollama (no batch API). When only a single request exists in a pipeline step, the provider falls back to the standard sync path automatically.

Both batch providers use progressive poll intervals (starting at 10s, scaling up to a 120s cap) and tolerate up to 3 consecutive 5xx errors before failing, making them resilient to transient API issues. Batches are also resumable — if the server restarts mid-batch, the batch ID is persisted in `phaseCursor` so polling resumes where it left off instead of re-submitting.

**Prompt caching:** Anthropic providers (both sync and batch) automatically use [prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) on system prompts. Since verify and rank use the same system prompt for every group in a scan, all calls after the first get a cache hit, reducing cost and latency.

#### Token counting and usage tracking

ossgard uses provider-level token counting to build embedding and LLM inputs that stay within each provider's context window. A 95% budget utilization factor prevents overflow while maximizing the information sent to each model.

| Provider | Counting method | Max context |
|----------|----------------|-------------|
| OpenAI | Exact BPE tokenization (js-tiktoken) | 8,191 tokens |
| Anthropic | Heuristic (~3.5 chars/token) | 200,000 tokens |
| Ollama | Heuristic (~4 chars/token) | 8,192 tokens |

LLM token usage (input and output) is tracked per scan during the detect phase. Use `ossgard status --json` to see accumulated token counts for completed scans.

#### Environment variables

A small set of env vars are supported for deployment flexibility:

| Variable | Purpose |
|----------|---------|
| `DATABASE_PATH` | SQLite database location (default `~/.ossgard/ossgard.db`) |
| `PORT` | API server port (default `3400`) |
| `LOG_LEVEL` | Logging verbosity: `debug`, `info`, `warn`, `error` (default `info`) |
| `OSSGARD_API_URL` | Override API URL for the CLI (takes precedence over config file) |
| `OSSGARD_API_KEY` | Override API key for the CLI (takes precedence over config file) |

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

E2E testing is handled via the `/ossgard-smoke-test` Claude command.

#### API authentication

All API endpoints (except `/health` and `POST /accounts`) require an API key via the `Authorization: Bearer <key>` header. The CLI handles this automatically using the key stored during setup.

## Project structure

```
packages/
  api/       Hono HTTP server, pipeline processors, services, SQLite DB
               - db/           Database layer (SQLite migrations, queries)
               - middleware/    API key auth
               - routes/       REST endpoints (accounts, repos, scans, duplicates)
               - services/     Service resolver, validators, LLM/embedding/vector providers
               - pipeline/     Job processors (ingest, detect, strategies/)
               - queue/        Job queue and worker loop
  cli/       Commander-based CLI
               - commands/     Command implementations (setup, doctor, scan, duplicates, review, status, config, clean)
  shared/    Types and Zod schemas shared across packages
local-ai/
  vector-store.yml    Local Qdrant via Docker (optional)
  llm-provider.yml    Local Ollama via Docker (optional)
```
