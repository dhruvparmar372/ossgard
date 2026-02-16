# Decouple Docker & Simplify Config — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove Docker dependency from the ossgard CLI and consolidate provider URLs into the TOML config file instead of scattered environment variables.

**Architecture:** The `up`/`down` CLI commands and `docker-compose.yml` at the project root are deleted. Provider URLs (`llm.url`, `embedding.url`, `vector_store.url`) move into the TOML config alongside their existing provider/model/api_key fields. The API server reads URLs from the TOML config instead of `OLLAMA_URL`/`QDRANT_URL` env vars. Four env vars are kept for deployment flexibility: `GITHUB_TOKEN`, `DATABASE_PATH`, `PORT`, `CONFIG_PATH`.

**Tech Stack:** TypeScript, Bun, TOML (`@iarna/toml`), Commander CLI, Hono API

**Design Doc:** `docs/plans/2026-02-16-decouple-docker-simplify-config-design.md`

---

### Task 1: Create feature branch

**Step 1: Create and checkout the branch**

Run: `git checkout -b feat/decouple-docker-simplify-config`
Expected: New branch created from main

**Step 2: Commit (empty, to mark branch start)**

No commit needed — the branch itself marks the start.

---

### Task 2: Delete stack commands

**Files:**
- Delete: `packages/cli/src/commands/stack.ts`
- Modify: `packages/cli/src/index.ts`

**Step 1: Remove stack import and registration from CLI entry point**

In `packages/cli/src/index.ts`, remove line 8 (the import) and line 23 (the registration call):

```typescript
// DELETE these two lines:
import { registerStackCommands } from "./commands/stack.js";
registerStackCommands(program);
```

The file should go from:

```typescript
#!/usr/bin/env node
import { Command } from "commander";
import { ApiClient } from "./client.js";
import { trackCommand, untrackCommand } from "./commands/track.js";
import { statusCommand } from "./commands/status.js";
import { registerInitCommand } from "./commands/init.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerStackCommands } from "./commands/stack.js";
import { scanCommand } from "./commands/scan.js";
import { dupesCommand } from "./commands/dupes.js";

const client = new ApiClient(process.env.OSSGARD_API_URL);

const program = new Command();

program
  .name("ossgard")
  .description("Scan GitHub repos for duplicate PRs and rank them")
  .version("0.1.0");

registerInitCommand(program);
registerConfigCommand(program);
registerStackCommands(program);

program.addCommand(trackCommand(client));
program.addCommand(untrackCommand(client));
program.addCommand(statusCommand(client));
program.addCommand(scanCommand(client));
program.addCommand(dupesCommand(client));

program.parse();
```

To:

```typescript
#!/usr/bin/env node
import { Command } from "commander";
import { ApiClient } from "./client.js";
import { trackCommand, untrackCommand } from "./commands/track.js";
import { statusCommand } from "./commands/status.js";
import { registerInitCommand } from "./commands/init.js";
import { registerConfigCommand } from "./commands/config.js";
import { scanCommand } from "./commands/scan.js";
import { dupesCommand } from "./commands/dupes.js";

const client = new ApiClient(process.env.OSSGARD_API_URL);

const program = new Command();

program
  .name("ossgard")
  .description("Scan GitHub repos for duplicate PRs and rank them")
  .version("0.1.0");

registerInitCommand(program);
registerConfigCommand(program);

program.addCommand(trackCommand(client));
program.addCommand(untrackCommand(client));
program.addCommand(statusCommand(client));
program.addCommand(scanCommand(client));
program.addCommand(dupesCommand(client));

program.parse();
```

**Step 2: Delete the stack commands file**

Run: `rm packages/cli/src/commands/stack.ts`

**Step 3: Verify build**

Run: `cd /Users/dhruv/Code/ossgard && bun run build`
Expected: Build succeeds with no errors

**Step 4: Verify CLI no longer has up/down**

Run: `bun packages/cli/src/index.ts --help`
Expected: `up` and `down` do NOT appear in the help output

**Step 5: Run tests**

Run: `bun run test`
Expected: All tests pass (stack.ts had no tests)

**Step 6: Commit**

```bash
git add packages/cli/src/index.ts
git rm packages/cli/src/commands/stack.ts
git commit -m "feat: remove up/down CLI commands (Docker decoupling)"
```

---

### Task 3: Move docker-compose.yml to deploy/

**Files:**
- Move: `docker-compose.yml` → `deploy/docker-compose.yml`

**Step 1: Create deploy directory and move file**

```bash
mkdir -p deploy
git mv docker-compose.yml deploy/docker-compose.yml
```

**Step 2: Commit**

```bash
git commit -m "chore: move docker-compose.yml to deploy/"
```

---

### Task 4: Add url fields to CLI config schema

**Files:**
- Modify: `packages/cli/src/config.ts`

**Step 1: Write the failing test**

Create `packages/cli/src/config.test.ts`:

```typescript
import { Config, type OssgardConfig } from "./config.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Config", () => {
  let tempDir: string;
  let config: Config;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ossgard-config-"));
    config = new Config(tempDir);
  });

  it("init writes url fields to config.toml", () => {
    config.init("ghp_test123");
    const raw = readFileSync(join(tempDir, "config.toml"), "utf-8");

    // Should contain url fields in [llm], [embedding], and [vector_store] sections
    expect(raw).toContain("[llm]");
    expect(raw).toContain('url = "http://localhost:11434"');
    expect(raw).toContain("[embedding]");
    expect(raw).toContain("[vector_store]");
    expect(raw).toContain('url = "http://localhost:6333"');
  });

  it("load returns url defaults when config file doesn't exist", () => {
    const cfg = config.load();

    expect(cfg.llm.url).toBe("http://localhost:11434");
    expect(cfg.embedding.url).toBe("http://localhost:11434");
    expect(cfg.vector_store.url).toBe("http://localhost:6333");
  });

  it("get/set works with new url fields", () => {
    config.init("ghp_test");
    config.set("llm.url", "http://remote:11434");
    expect(config.get("llm.url")).toBe("http://remote:11434");

    config.set("vector_store.url", "https://cloud.qdrant.io:6333");
    expect(config.get("vector_store.url")).toBe("https://cloud.qdrant.io:6333");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/cli/src/config.test.ts`
Expected: FAIL — `url` property doesn't exist on config types

**Step 3: Update the config interface and defaults**

Replace the `OssgardConfig` interface and `DEFAULT_CONFIG` in `packages/cli/src/config.ts`:

```typescript
export interface OssgardConfig {
  github: { token: string };
  llm: {
    provider: string;
    url: string;
    model: string;
    api_key: string;
    batch?: boolean;
  };
  embedding: {
    provider: string;
    url: string;
    model: string;
    api_key: string;
    batch?: boolean;
  };
  vector_store: {
    url: string;
  };
  scan: {
    concurrency: number;
    code_similarity_threshold: number;
    intent_similarity_threshold: number;
  };
}

const DEFAULT_CONFIG: OssgardConfig = {
  github: { token: "" },
  llm: {
    provider: "ollama",
    url: "http://localhost:11434",
    model: "llama3",
    api_key: "",
  },
  embedding: {
    provider: "ollama",
    url: "http://localhost:11434",
    model: "nomic-embed-text",
    api_key: "",
  },
  vector_store: {
    url: "http://localhost:6333",
  },
  scan: {
    concurrency: 10,
    code_similarity_threshold: 0.85,
    intent_similarity_threshold: 0.80,
  },
};
```

**Step 4: Run test to verify it passes**

Run: `bun test packages/cli/src/config.test.ts`
Expected: PASS

**Step 5: Run all tests**

Run: `bun run test`
Expected: All tests pass

**Step 6: Commit**

```bash
git add packages/cli/src/config.ts packages/cli/src/config.test.ts
git commit -m "feat: add url fields to config schema (llm.url, embedding.url, vector_store.url)"
```

---

### Task 5: Update ServiceConfig and factory to accept URLs from config

**Files:**
- Modify: `packages/api/src/services/factory.ts`
- Modify: `packages/api/src/services/factory.test.ts`

**Step 1: Update the failing tests**

In `packages/api/src/services/factory.test.ts`, update `makeConfig` to use the new shape:

```typescript
import { ServiceFactory, type ServiceConfig } from "./factory.js";

function makeConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    github: { token: "gh-test-token" },
    llm: { provider: "ollama", url: "http://localhost:11434", model: "llama3", apiKey: "" },
    embedding: { provider: "ollama", url: "http://localhost:11434", model: "nomic-embed-text", apiKey: "" },
    vectorStoreUrl: "http://localhost:6333",
    ...overrides,
  };
}
```

Update each test that passes `llm:` or `embedding:` overrides to include the `url` field. For example:

```typescript
it("returns AnthropicProvider when provider is anthropic", () => {
  const factory = new ServiceFactory(
    makeConfig({ llm: { provider: "anthropic", url: "http://localhost:11434", model: "claude-sonnet-4-20250514", apiKey: "sk-test" } })
  );
  const llm = factory.createLLMProvider();
  expect(llm.constructor.name).toBe("AnthropicProvider");
});
```

Do this for ALL tests in the file — every `llm:` and `embedding:` override needs a `url` field.

**Step 2: Run tests to verify they fail**

Run: `bun test packages/api/src/services/factory.test.ts`
Expected: FAIL — `ServiceConfig` type mismatch

**Step 3: Update ServiceConfig interface in factory.ts**

Replace the `ServiceConfig` interface in `packages/api/src/services/factory.ts`:

```typescript
export interface ServiceConfig {
  github: { token: string };
  llm: { provider: string; url: string; model: string; apiKey: string; batch?: boolean };
  embedding: { provider: string; url: string; model: string; apiKey: string; batch?: boolean };
  vectorStoreUrl: string;
}
```

**Step 4: Update factory methods to use new URL fields**

In `createLLMProvider()`, change `this.config.ollamaUrl` to `this.config.llm.url`:

```typescript
// Default to Ollama for chat (batch flag ignored — Ollama has no batch API)
return new OllamaProvider({
  baseUrl: this.config.llm.url,
  embeddingModel: this.config.embedding.model,
  chatModel: this.config.llm.model,
});
```

In `createEmbeddingProvider()`, change `this.config.ollamaUrl` to `this.config.embedding.url`:

```typescript
// Default to Ollama for embeddings (batch flag ignored — Ollama has no batch API)
return new OllamaProvider({
  baseUrl: this.config.embedding.url,
  embeddingModel: this.config.embedding.model,
  chatModel: this.config.llm.model,
});
```

In `createVectorStore()`, change `this.config.qdrantUrl` to `this.config.vectorStoreUrl`:

```typescript
const realClient = new RealQdrantClient({ url: this.config.vectorStoreUrl });
```

**Step 5: Run tests to verify they pass**

Run: `bun test packages/api/src/services/factory.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/api/src/services/factory.ts packages/api/src/services/factory.test.ts
git commit -m "feat: update ServiceConfig to use per-provider url fields"
```

---

### Task 6: Update API server to read URLs from TOML config

**Files:**
- Modify: `packages/api/src/index.ts`

**Step 1: Update TomlConfig interface**

Add `url` to the `llm` and `embedding` sections, and add a `vector_store` section:

```typescript
interface TomlConfig {
  github?: { token?: string };
  llm?: { provider?: string; url?: string; model?: string; api_key?: string; batch?: boolean };
  embedding?: { provider?: string; url?: string; model?: string; api_key?: string; batch?: boolean };
  vector_store?: { url?: string };
  scan?: {
    code_similarity_threshold?: number;
    intent_similarity_threshold?: number;
  };
}
```

**Step 2: Update ServiceConfig construction**

Replace the entire `serviceConfig` block (lines 41-62) with:

```typescript
const serviceConfig: ServiceConfig = {
  github: {
    token: process.env.GITHUB_TOKEN || toml.github?.token || "",
  },
  llm: {
    provider: toml.llm?.provider || "ollama",
    url: toml.llm?.url || "http://localhost:11434",
    model: toml.llm?.model || "llama3",
    apiKey: toml.llm?.api_key || "",
    batch: toml.llm?.batch || false,
  },
  embedding: {
    provider: toml.embedding?.provider || "ollama",
    url: toml.embedding?.url || "http://localhost:11434",
    model: toml.embedding?.model || "nomic-embed-text",
    apiKey: toml.embedding?.api_key || "",
    batch: toml.embedding?.batch || false,
  },
  vectorStoreUrl: toml.vector_store?.url || "http://localhost:6333",
};
```

Note: All `process.env.LLM_PROVIDER`, `process.env.OLLAMA_URL`, `process.env.QDRANT_URL`, etc. are gone. Only `GITHUB_TOKEN` env var remains.

**Step 3: Verify build**

Run: `bun run build`
Expected: Build succeeds

**Step 4: Run all tests**

Run: `bun run test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add packages/api/src/index.ts
git commit -m "feat: read provider URLs from TOML config, remove env var overrides"
```

---

### Task 7: Update E2E test to use new ServiceConfig shape

**Files:**
- Modify: `e2e/openclaw.test.ts`

**Step 1: Update ServiceConfig construction in E2E test**

In `e2e/openclaw.test.ts`, find the `factory` construction (around line 137-143) and update it:

```typescript
const factory = new ServiceFactory({
  github: { token: githubToken },
  llm: { provider: "ollama", url: OLLAMA_URL, model: "llama3", apiKey: "" },
  embedding: { provider: "ollama", url: OLLAMA_URL, model: "nomic-embed-text", apiKey: "" },
  vectorStoreUrl: QDRANT_URL,
});
```

**Step 2: Verify build**

Run: `bun run build`
Expected: Build succeeds

**Step 3: Run unit tests**

Run: `bun run test`
Expected: All tests pass

**Step 4: Commit**

```bash
git add e2e/openclaw.test.ts
git commit -m "fix: update E2E test for new ServiceConfig shape"
```

---

### Task 8: Update deploy/docker-compose.yml for new config

**Files:**
- Modify: `deploy/docker-compose.yml`

**Step 1: Remove OLLAMA_URL and QDRANT_URL env vars, keep only DATABASE_PATH and CONFIG_PATH**

Update the api service environment section in `deploy/docker-compose.yml`:

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
    build:
      context: ..
      dockerfile: packages/api/Dockerfile
    ports:
      - "3400:3400"
    depends_on:
      - qdrant
      - ollama
    volumes:
      - ossgard-data:/data
      - ${HOME}/.ossgard:/config:ro
    environment:
      DATABASE_PATH: /data/ossgard.db
      CONFIG_PATH: /config/config.toml

volumes:
  ossgard-vectors:
  ossgard-models:
  ossgard-data:
```

Note: `build.context` changes from `.` to `..` since docker-compose is now in `deploy/`. The user's `~/.ossgard/config.toml` needs to set `llm.url = "http://ollama:11434"`, `embedding.url = "http://ollama:11434"`, and `vector_store.url = "http://qdrant:6333"` when running via Docker.

**Step 2: Commit**

```bash
git add deploy/docker-compose.yml
git commit -m "chore: update docker-compose env vars for new config structure"
```

---

### Task 9: Update README

**Files:**
- Modify: `README.md`

**Step 1: Update the README**

Key changes:
1. Remove Docker from prerequisites
2. Remove "Docker Compose" from architecture diagram — show services as independent
3. Replace `ossgard up --detach` in the quickstart with instructions to start services independently
4. Replace the "Docker Compose services" table with a "Services" table explaining each is independent
5. Update the config TOML example to include `url` fields and `[vector_store]` section
6. Remove the env var override table (remove `LLM_PROVIDER`, `LLM_MODEL`, etc.)
7. Add a small note about remaining env vars: `GITHUB_TOKEN`, `DATABASE_PATH`, `PORT`, `CONFIG_PATH`
8. Update project structure to remove `up/down` from CLI description

Replace the full README content with:

```markdown
# ossgard

A local-first CLI tool that scans GitHub repositories for duplicate pull requests and ranks the best PR in each group. Built for large open-source projects where maintainers face thousands of open PRs and can't manually detect overlap.

ossgard combines code-level similarity (embedding diffs) with intent-level analysis (LLM verification) to surface true duplicates with high precision, then ranks them by code quality so maintainers know which PR to merge.

## Architecture

```
┌──────────┐         ┌───────────┐
│          │  HTTP   │           │
│   CLI    │────────►│    API    │──────► GitHub API
│ (ossgard)│  :3400  │  (Hono)   │
│          │◄────────│  SQLite   │
└──────────┘         │  (jobs+   │
                     │   data)   │
                     └─────┬─────┘
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
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: update README for Docker decoupling and new config structure"
```

---

### Task 10: Final verification

**Step 1: Run full test suite**

Run: `bun run test`
Expected: All tests pass

**Step 2: Verify build**

Run: `bun run build`
Expected: Build succeeds

**Step 3: Verify CLI binary compiles**

Run: `bun run build:cli`
Expected: Binary compiles at `packages/cli/dist/ossgard`

**Step 4: Verify CLI help**

Run: `./packages/cli/dist/ossgard --help`
Expected: No `up` or `down` commands listed

**Step 5: Verify config init creates new fields**

```bash
rm -rf /tmp/ossgard-test-config
mkdir -p /tmp/ossgard-test-config
```

Then in a quick bun script or REPL:
```bash
bun -e "
const { Config } = require('./packages/cli/src/config.js');
const c = new Config('/tmp/ossgard-test-config');
c.init('ghp_test');
console.log(require('fs').readFileSync('/tmp/ossgard-test-config/config.toml', 'utf-8'));
"
```

Expected: TOML output includes `url` fields under `[llm]`, `[embedding]`, and a `[vector_store]` section.

**Step 6: Verify no stale references to removed env vars**

Run: `grep -r 'OLLAMA_URL\|QDRANT_URL\|LLM_PROVIDER\|LLM_MODEL\|LLM_API_KEY\|EMBEDDING_PROVIDER\|EMBEDDING_MODEL\|EMBEDDING_API_KEY\|LLM_BATCH\|EMBEDDING_BATCH' packages/ e2e/ --include='*.ts' -l`
Expected: No files found (only docs/plans may still reference them historically)
