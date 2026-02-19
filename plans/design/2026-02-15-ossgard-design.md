# ossgard — Design Document

**Date:** 2026-02-15
**Status:** Approved
**Version:** MLP (v0.1)

## Problem

Large open-source projects (like OpenClaw with 3000+ open PRs) face an impossible triage burden. Multiple contributors submit duplicate PRs solving the same problem, and maintainers have no automated way to detect duplicates or determine which PR is best. This wastes reviewer time and contributor effort.

## Solution

ossgard is a local-first CLI tool that scans a GitHub repository's open PRs, finds duplicates using a hybrid embedding + LLM pipeline, and ranks the best PR in each duplicate group.

## Scope

### MLP (v0.1) — ships now

- PR deduplication (code-level + intent-level)
- PR quality ranking within duplicate groups (code quality, then completeness)
- Fully local: runs via Docker Compose, no cloud dependencies
- CLI interface with JSON output for tool integration

### v0.2 — fast follow

- Vision document alignment (VISION.md scoring)
- Issue deduplication
- GitHub App / bot mode

### Deferred

- Web dashboard
- Author reputation scoring
- Review activity signals

---

## Architecture

```
                    ┌──────────────────────────────────────────────┐
                    │           Docker Compose                      │
                    │                                              │
┌──────────┐       │  ┌──────────────┐  ┌────────┐  ┌──────────┐ │
│ ossgard  │ HTTP  │  │ ossgard-api  │  │ Qdrant │  │  Ollama  │ │
│   CLI    │◄─────►│  │ (Hono/Node)  │◄►│(vector)│  │  (LLM +  │ │
│          │       │  │  :3400       │  │ :6333  │  │ embeds)  │ │
│          │       │  │              │◄►│        │  │  :11434  │ │
└──────────┘       │  │   The Brain  │◄►│        │  │          │ │
                    │  └──────────────┘  └────────┘  └──────────┘ │
                    │         │                                    │
                    │         ▼                                    │
                    │  ┌──────────────┐                            │
                    │  │   SQLite     │                            │
                    │  │  (mounted    │                            │
                    │  │   volume)    │                            │
                    │  └──────────────┘                            │
                    └──────────────────────────────────────────────┘
                              │
                              │ GitHub REST API (via PAT)
                              ▼
                       ┌──────────────┐
                       │    GitHub    │
                       └──────────────┘
```

### Components

| Component | Technology | Purpose |
|-----------|-----------|---------|
| CLI | TypeScript, Commander.js | Thin client, talks to API over HTTP |
| API | TypeScript, Hono, Node.js | The brain — pipeline orchestration, all business logic |
| Vector DB | Qdrant | PR embeddings, cosine similarity search |
| LLM | Ollama (default) or Claude/OpenAI via BYOK | Verification and ranking |
| Embeddings | Ollama (nomic-embed-text) | Local embedding generation |
| Database | SQLite | Repos, PRs, scans, duplicate groups |

### Why these choices

- **Qdrant:** 50MB Docker image, <1s startup, official TypeScript client, handles 100K+ vectors on a laptop
- **Ollama:** Single service for both embeddings and LLM, runs on CPU, no API keys needed
- **SQLite:** Zero-config, perfect for local, mounted volume for persistence
- **Hono:** Lightweight, fast, TypeScript-native — and when we move to Cloudflare Workers for the hosted version later, Hono runs there natively

### Key design decision: CLI is a thin client

All intelligence lives in the API. The CLI is just HTTP calls + output formatting. This means a future GitHub App becomes another thin client hitting the same API — zero logic duplication.

### Key design decision: Async-first job architecture

Every long-running operation (scan, ingest, detect) is a **background job**, not a synchronous HTTP request. The API returns immediately with a job/scan ID, and the CLI polls for progress.

This is critical for two reasons:
1. Scans take minutes — can't hold HTTP connections open
2. Maps directly to Cloudflare Queues + Workers when we move to a hosted version (Workers have execution time limits)

```
CLI                         API                          Job Processor
 │                           │                              │
 │  POST /repos/:id/scan     │                              │
 │──────────────────────────►│                              │
 │                           │  enqueue(scan_job)           │
 │                           │─────────────────────────────►│
 │  { scan_id: 42,           │                              │
 │    status: "queued" }     │                              │
 │◄──────────────────────────│                              │
 │                           │                              │
 │  GET /scans/42            │         (working...)         │
 │──────────────────────────►│                              │
 │  { status: "embedding",   │                              │
 │    progress: "1847/3102" }│                              │
 │◄──────────────────────────│                              │
 │                           │                              │
 │  GET /scans/42            │                              │
 │──────────────────────────►│                              │
 │  { status: "done",        │                              │
 │    dupe_groups: 63 }      │                              │
 │◄──────────────────────────│                              │
```

**What becomes a job:**

| Operation | Why async | Job type |
|-----------|----------|----------|
| `scan` (full) | Minutes of work across ingest + detect | `scan_job` — orchestrates sub-jobs |
| `scan` (incremental) | Still fetches/embeds new PRs | Same, but lighter |
| `track` (initial) | Registration is instant, but can trigger first scan | `POST /repos` is sync, optionally enqueues `scan_job` |

**What stays synchronous** (instant, no job needed):
- `track` / `untrack` — just INSERT/DELETE in repos table
- `dupes` — reads pre-computed results from SQLite
- `status` — reads from SQLite
- `config` — reads/writes local TOML file

**Pipeline phases as chained jobs:**

```
scan_job (orchestrator)
  └─► ingest_job ──► detect_job
```

The `detect_job` runs the full pairwise-llm strategy internally (intent extraction, embedding, candidate retrieval, pairwise verification, grouping, ranking). Each job:
1. Reads its cursor from the `scans` table
2. Does its work in batches
3. Updates the cursor after each batch
4. If interrupted (rate limit, crash, restart), the next pickup resumes from cursor
5. On completion, enqueues the next phase

**Job queue abstraction:**

```typescript
interface JobQueue {
  enqueue(job: Job): Promise<string>;          // returns job ID
  getStatus(jobId: string): Promise<JobStatus>;
}

// Local: SQLite-backed queue, in-process worker loop
class LocalJobQueue implements JobQueue { ... }

// Future: Cloudflare Queues
class CloudflareJobQueue implements JobQueue { ... }
```

Locally, the job processor runs as a worker loop inside the API process — pulls jobs from a SQLite `jobs` table, processes them, updates status. On Cloudflare, swap to Queues as transport and Workers/Durable Objects for processing. The pipeline code doesn't change.

---

## Dedup Pipeline

The core engine runs on every scan. An `ingest` job fetches PR data from GitHub, then a `detect` job runs the pairwise-llm strategy which handles everything from embedding to final ranking.

```
┌─────────┐    ┌──────────────────────────────────────────────────────────┐
│  Ingest │───►│                        Detect                           │
│         │    │                                                          │
│Fetch PRs│    │ Intent Extract → Embed → Candidate Retrieval →           │
│via GH   │    │ Pairwise Verify (LLM) → Group (cliques) → Rank (LLM)   │
│API      │    │                                                          │
└─────────┘    └──────────────────────────────────────────────────────────┘
   cheap                              targeted
```

### Ingest

Fetch all open PRs via GitHub REST API (paginated, 100/page). Per PR:
- Title, body (description)
- Changed file paths (`/pulls/{n}/files` endpoint)
- Unified diff (from diff URL)
- Author, created_at, comments count, review state

**Incremental scans:** After first full scan, only fetch PRs updated since `last_scan_at`. ETags stored per PR for conditional requests (304s don't count against rate limit).

### Detect (pairwise-llm strategy)

The detect phase runs the full duplicate detection pipeline inside a single job:

**Phase 1: Intent Extraction.** For each PR, prompt the LLM to generate a 2-3 sentence normalized intent summary from the title, body, and truncated diff. Batchable via the `chatBatch` API.

**Phase 2: Embed.** Two embeddings per PR stored in Qdrant:
- **Intent embedding** (`ossgard-intent-v2`): embed the LLM-generated intent summary
- **Code embedding** (`ossgard-code-v2`): embed the normalized diff content

Supports Ollama (768-dim `nomic-embed-text`, 1024-dim `mxbai-embed-large`) and OpenAI (`text-embedding-3-large` 3072-dim, `text-embedding-3-small` 1536-dim). Token-aware truncation prevents context overflow.

**Phase 3: Candidate Retrieval + Pairwise Verification.** For each PR, k-NN search on both intent and code embeddings (top K neighbors above threshold, default 0.65). Deduplicate candidate pairs. For each unique pair, LLM pairwise verification determines if the pair is a true duplicate. No transitivity — each pair is judged independently. Batchable.

**Phase 4: Grouping + Ranking.** Build a graph of confirmed duplicate edges. Find cliques (groups where every pair was confirmed by the LLM) using greedy clique building from highest-confidence edges. Rank PRs within each group by code quality and completeness via LLM. Output final `DupeGroup[]`.

### Cost profile (3000-PR repo, first scan)

| Step | Resources | Estimated time |
|------|-----------|---------------|
| Ingest | ~6000 GitHub API requests | ~10min (rate-limited) |
| Intent extraction | ~3000 LLM calls (batchable) | ~2-5min |
| Embed | ~6000 embeddings | ~2-5min |
| Candidate retrieval | ~3000 Qdrant queries | ~15s |
| Pairwise verification | ~50-200 LLM calls (candidates only, batchable) | ~2-5min |
| Ranking | ~50-100 LLM calls (groups only, batchable) | ~1-3min |

---

## Rate-Limited Service Clients

Every external service is wrapped in a `RateLimitedClient` with consistent behavior.

```
┌──────────────────────────────────────────────────┐
│              RateLimitedClient<T>                 │
│                                                  │
│  ┌────────────┐  ┌───────────┐  ┌────────────┐  │
│  │   Token    │  │  Retry    │  │  Circuit   │  │
│  │   Bucket   │  │  Engine   │  │  Breaker   │  │
│  └────────────┘  └───────────┘  └────────────┘  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │         Concurrency Limiter                │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

### Three clients, same pattern

| Client | Primary limit | Concurrency cap |
|--------|--------------|-----------------|
| GitHubClient | 5000 req/hr (reads `x-ratelimit-remaining` header) | 10 concurrent |
| EmbeddingClient (Ollama) | Local, but respect Ollama queue depth | 5 concurrent |
| LLMClient (Ollama or Claude) | Ollama: local queue. Claude: RPM-based | 5 concurrent |

### GitHub client specifics

**Proactive throttling:** Reads `x-ratelimit-remaining` and `x-ratelimit-reset` from every response. When remaining drops below safety buffer (100), spreads remaining requests evenly across time until reset.

**Reactive retry:** On 429 or 403 (secondary rate limit):
```
Attempt 1 → 429 (retry-after: 60) → wait 60s + jitter(0-5s)
Attempt 2 → 429 (retry-after: 30) → wait 30s + jitter(0-5s)
Attempt 3 → 200 ✓
Max retries: 5, then fail the individual request (not the whole scan)
```

For secondary rate limits (403 + abuse detection), minimum 60s backoff.

**ETags:** Store ETag from every GitHub response. Send `If-None-Match` on subsequent requests. 304 responses are free (don't count against rate limit).

### Resumable scans

Scans are composed of chained jobs (see "Async-first job architecture" above). Each phase is a separate job with its own cursor:

```
INGESTING ──► EMBEDDING ──► VERIFYING ──► RANKING ──► DONE
     │              │             │            │
     └──► PAUSED ◄──┘             └─ PAUSED ◄─┘
```

The `phase_cursor` field in the `scans` table stores JSON state for resumability. When a job is paused (rate limit, crash, restart), it sets `run_after` on the job row and the worker loop picks it up when the cooldown expires. The CLI can be killed at any time — the scan continues in the background. `ossgard status` shows in-flight scans.

**CLI polling behavior:**

```typescript
// cli/src/commands/scan.ts
async function scan(repo: string, opts: { noWait?: boolean }) {
  const { scanId } = await client.post(`/repos/${repo}/scan`);

  if (opts.noWait) {
    console.log(`Scan ${scanId} queued. Check with: ossgard status`);
    return;
  }

  while (true) {
    const status = await client.get(`/scans/${scanId}`);
    renderProgress(status);
    if (status.status === 'done' || status.status === 'failed') break;
    await sleep(1000);
  }
}
```

---

## Data Model (SQLite)

```sql
CREATE TABLE repos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  owner           TEXT NOT NULL,
  name            TEXT NOT NULL,
  last_scan_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(owner, name)
);

CREATE TABLE prs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id         INTEGER NOT NULL REFERENCES repos(id),
  number          INTEGER NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT,
  author          TEXT NOT NULL,
  diff_hash       TEXT,
  file_paths      TEXT,                   -- JSON array
  state           TEXT NOT NULL DEFAULT 'open',
  github_etag     TEXT,
  embed_hash      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE(repo_id, number)
);

CREATE TABLE scans (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id         INTEGER NOT NULL REFERENCES repos(id),
  account_id      INTEGER NOT NULL REFERENCES accounts(id),
  status          TEXT NOT NULL DEFAULT 'queued',
  strategy        TEXT NOT NULL DEFAULT 'pairwise-llm',
  phase_cursor    TEXT,                   -- JSON resumability state
  pr_count        INTEGER DEFAULT 0,
  dupe_group_count INTEGER DEFAULT 0,
  input_tokens    INTEGER DEFAULT 0,
  output_tokens   INTEGER DEFAULT 0,
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT,
  error           TEXT
);

CREATE TABLE dupe_groups (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id         INTEGER NOT NULL REFERENCES scans(id),
  repo_id         INTEGER NOT NULL REFERENCES repos(id),
  label           TEXT,                   -- LLM-generated, e.g. "Add dark mode"
  pr_count        INTEGER NOT NULL
);

CREATE TABLE dupe_group_members (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id        INTEGER NOT NULL REFERENCES dupe_groups(id),
  pr_id           INTEGER NOT NULL REFERENCES prs(id),
  rank            INTEGER NOT NULL,
  score           REAL NOT NULL,
  rationale       TEXT,
  UNIQUE(group_id, pr_id)
);
```

CREATE TABLE jobs (
  id          TEXT PRIMARY KEY,                    -- UUID
  type        TEXT NOT NULL,                       -- "scan", "ingest", "detect"
  payload     TEXT NOT NULL,                       -- JSON (repo_id, scan_id, phase-specific params)
  status      TEXT NOT NULL DEFAULT 'queued',      -- queued/running/done/failed/paused
  result      TEXT,                                -- JSON
  error       TEXT,
  attempts    INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  run_after   TEXT,                                -- ISO timestamp, for delayed/paused jobs
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Vectors live in Qdrant, linked by PR id. Not duplicated in SQLite.

---

## Project Structure

```
ossgard/
├── packages/
│   ├── cli/                    # CLI client (npm: ossgard)
│   │   ├── src/
│   │   │   ├── commands/       # setup, scan, dupes, status, config, clear-scans, clear-repos
│   │   │   ├── output/         # formatters (table, json)
│   │   │   └── client.ts       # HTTP client to ossgard-api
│   │   └── package.json
│   │
│   ├── api/                    # Backend brain (Docker)
│   │   ├── src/
│   │   │   ├── routes/         # Hono route handlers
│   │   │   ├── pipeline/       # ingest, detect, strategies/
│   │   │   ├── services/       # github-client, llm-provider, vector-store
│   │   │   ├── db/             # SQLite schema, migrations, queries
│   │   │   └── queue/          # scan job queue (in-process, SQLite-backed)
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   └── shared/                 # Shared types and constants
│       ├── src/
│       │   ├── types.ts        # PR, DupeGroup, Scan, etc.
│       │   └── schemas.ts      # Zod schemas for API request/response
│       └── package.json
│
├── docker-compose.yml
├── package.json                # pnpm workspace root
└── tsconfig.base.json
```

### Key interfaces

```typescript
// LLM provider abstraction — swap Ollama/Claude/OpenAI
interface LLMProvider {
  embed(texts: string[]): Promise<number[][]>;
  chat(messages: Message[], schema?: JSONSchema): Promise<object>;
}

// Scoring strategy — extensible for future signals
interface ScoringStrategy {
  name: string;
  score(pr: PR, groupContext: PR[]): Promise<{ score: number; rationale: string }>;
}

// Rate-limited client — wraps any HTTP service
interface RateLimitedClientOptions {
  maxConcurrent: number;
  maxRetries: number;
  baseBackoffMs: number;
  onRateLimited?: (retryAfterMs: number) => void;
}

// Job queue — swap local SQLite queue for Cloudflare Queues later
interface JobQueue {
  enqueue(job: Job): Promise<string>;
  getStatus(jobId: string): Promise<JobStatus>;
  dequeue(): Promise<Job | null>;
  complete(jobId: string, result?: object): Promise<void>;
  fail(jobId: string, error: string): Promise<void>;
  pause(jobId: string, runAfter: Date): Promise<void>;
}

// Job processor — each pipeline phase implements this
interface JobProcessor {
  type: string;                                   // "scan", "ingest", "detect"
  process(job: Job, ctx: PipelineContext): Promise<void>;
}
```

---

## CLI Commands

| Command | Description | Key flags |
|---------|------------|-----------|
| `ossgard setup` | Register account + configure services | `--force` (reconfigure) |
| `ossgard scan <owner/repo>` | Enqueue scan job, poll and display progress (auto-tracks repo) | `--full`, `--no-wait`, `--limit <N>` |
| `ossgard dupes <owner/repo>` | Show duplicate groups with rankings | `--json`, `--min-score N` |
| `ossgard status` | Show tracked repos, scan status, dupe counts | `--json` |
| `ossgard config show` | View local CLI configuration | — |
| `ossgard config set <key> <val>` | Set config value | — |
| `ossgard config get <key>` | Read config value | — |
| `ossgard clear-scans` | Delete all scans and analysis (keeps repos/PRs) | — |
| `ossgard clear-repos` | Delete everything (repos, PRs, scans, analysis) | — |

All commands support `--json` for machine-readable output.

---

## Configuration

`~/.ossgard/config.toml`:

```toml
[github]
token = "ghp_xxxxxxxxxxxx"

[llm]
provider = "ollama"           # "ollama" | "anthropic" | "openai"
model = "llama3"              # model for verification/ranking
api_key = ""                  # only needed for cloud providers

[embedding]
model = "nomic-embed-text"    # Ollama embedding model

[scan]
concurrency = 10              # max concurrent GitHub API requests
candidate_threshold = 0.65    # cosine similarity for k-NN candidate retrieval
max_candidates_per_pr = 5     # k in k-NN search
```

---

## Docker Compose

```yaml
services:
  qdrant:
    image: qdrant/qdrant:latest
    ports:
      - "6333:6333"
    volumes:
      - ossgard-vectors:/qdrant/storage

  ollama:
    image: ollama/ollama:latest
    ports:
      - "11434:11434"
    volumes:
      - ossgard-models:/root/.ollama

  api:
    build: ./packages/api
    ports:
      - "3400:3400"
    depends_on:
      - qdrant
      - ollama
    volumes:
      - ossgard-data:/data
    environment:
      QDRANT_URL: http://qdrant:6333
      OLLAMA_URL: http://ollama:11434
      DATABASE_PATH: /data/ossgard.db

volumes:
  ossgard-vectors:
  ossgard-models:
  ossgard-data:
```

---

## Future: GitHub App / Bot Mode

The architecture explicitly supports this. When ready:

1. New package: `packages/bot/` — GitHub App webhook handler
2. Listens for `pull_request.opened` and `pull_request.synchronize` events
3. Calls the same API endpoints the CLI uses
4. Comments on PRs with duplicate warnings and quality scores

No changes needed to the API, pipeline, or data model.

## Future: Cloudflare Hosted Version

The async job architecture makes this a straightforward port:

| Local | Cloudflare |
|-------|-----------|
| SQLite `jobs` table + in-process worker loop | Cloudflare Queues (producer/consumer) |
| SQLite for data | D1 (Cloudflare's SQLite-compatible DB) |
| Qdrant container | Vectorize |
| Ollama container | Workers AI (embeddings) |
| Hono on Node.js | Hono on Workers (same code) |

The pipeline code, rate limiting, LLM providers, and scoring strategies are unchanged. Only the `JobQueue` implementation and infrastructure bindings swap out.

## Future: Vision Document Alignment

1. Maintainer adds `VISION.md` to their repo
2. New pipeline step between Rank and Done: **Align**
3. LLM reads VISION.md + PR description, scores alignment (0-100)
4. New `ScoringStrategy` implementation: `VisionAlignmentStrategy`
5. Results surfaced in `ossgard dupes` output as an additional column
