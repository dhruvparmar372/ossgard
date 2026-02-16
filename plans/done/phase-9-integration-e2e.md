# Phase 9: Integration, Wiring & End-to-End

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire all pipeline processors with real service instances, create the service factory based on config, build the API Dockerfile, add Ollama model pulling to `ossgard up`, and run an end-to-end test of the full pipeline.

**Architecture:** A `ServiceFactory` reads config and creates the appropriate LLMProvider (Ollama or Anthropic), GitHubClient, and QdrantStore. All processors are instantiated with real services and registered in the worker loop. The E2E test uses Docker Compose to stand up the full stack and runs a scan against a small test repo.

**Tech Stack:** Docker, Docker Compose, Vitest, all prior packages

**Depends on:** All prior phases (1-8)

---

### Task 1: Create ServiceFactory

**Files:**
- Create: `packages/api/src/services/factory.ts`
- Test: `packages/api/src/services/factory.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/api/src/services/factory.test.ts
import { describe, it, expect } from "vitest";
import { ServiceFactory } from "./factory.js";

describe("ServiceFactory", () => {
  it("creates Ollama provider by default", () => {
    const factory = new ServiceFactory({
      github: { token: "ghp_test" },
      llm: { provider: "ollama", model: "llama3", apiKey: "" },
      embedding: { model: "nomic-embed-text" },
      ollamaUrl: "http://localhost:11434",
      qdrantUrl: "http://localhost:6333",
    });

    const llm = factory.createLLMProvider();
    expect(llm).toBeDefined();
    // OllamaProvider instance
    expect(llm.constructor.name).toBe("OllamaProvider");
  });

  it("creates Anthropic provider when configured", () => {
    const factory = new ServiceFactory({
      github: { token: "ghp_test" },
      llm: { provider: "anthropic", model: "claude-sonnet-4-5-20250929", apiKey: "sk-ant-test" },
      embedding: { model: "nomic-embed-text" },
      ollamaUrl: "http://localhost:11434",
      qdrantUrl: "http://localhost:6333",
    });

    const llm = factory.createLLMProvider();
    expect(llm.constructor.name).toBe("AnthropicProvider");
  });

  it("creates GitHub client with token", () => {
    const factory = new ServiceFactory({
      github: { token: "ghp_test" },
      llm: { provider: "ollama", model: "llama3", apiKey: "" },
      embedding: { model: "nomic-embed-text" },
      ollamaUrl: "http://localhost:11434",
      qdrantUrl: "http://localhost:6333",
    });

    const gh = factory.createGitHubClient();
    expect(gh).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @ossgard/api test -- src/services/factory
```

**Step 3: Implement ServiceFactory**

```typescript
// packages/api/src/services/factory.ts
import { OllamaProvider } from "./ollama-provider.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { GitHubClient } from "./github-client.js";
import { QdrantStore } from "./qdrant-store.js";
import type { LLMProvider } from "./llm-provider.js";
import type { VectorStore } from "./vector-store.js";

export interface ServiceConfig {
  github: { token: string };
  llm: { provider: string; model: string; apiKey: string };
  embedding: { model: string };
  ollamaUrl: string;
  qdrantUrl: string;
}

export class ServiceFactory {
  constructor(private config: ServiceConfig) {}

  createLLMProvider(): LLMProvider {
    switch (this.config.llm.provider) {
      case "anthropic":
        return new AnthropicProvider({
          apiKey: this.config.llm.apiKey,
          model: this.config.llm.model,
        });
      case "ollama":
      default:
        return new OllamaProvider({
          baseUrl: this.config.ollamaUrl,
          embeddingModel: this.config.embedding.model,
          chatModel: this.config.llm.model,
        });
    }
  }

  createEmbeddingProvider(): LLMProvider {
    // Embeddings always go through Ollama (local, fast, free)
    return new OllamaProvider({
      baseUrl: this.config.ollamaUrl,
      embeddingModel: this.config.embedding.model,
      chatModel: this.config.llm.model,
    });
  }

  createGitHubClient(): GitHubClient {
    return new GitHubClient(this.config.github.token);
  }

  createVectorStore(): VectorStore {
    // Dynamic import to avoid requiring qdrant client at test time
    // In production, QdrantClient is instantiated here
    const { QdrantClient } = require("@qdrant/js-client-rest");
    const client = new QdrantClient({ url: this.config.qdrantUrl });
    return new QdrantStore({ qdrantClient: client });
  }
}
```

**Step 4: Run tests**

```bash
pnpm --filter @ossgard/api test -- src/services/factory
```
Expected: ALL PASS

**Step 5: Commit**

```bash
git add packages/api/src/services/factory.ts packages/api/src/services/factory.test.ts
git commit -m "feat: add ServiceFactory for creating providers based on config"
```

---

### Task 2: Wire all processors with real services in app.ts

**Files:**
- Modify: `packages/api/src/app.ts`

**Step 1: Update createApp to accept config and wire all processors**

```typescript
// packages/api/src/app.ts
import { Hono } from "hono";
import { Database } from "./db/database.js";
import { LocalJobQueue } from "./queue/local-job-queue.js";
import { WorkerLoop } from "./queue/worker.js";
import { ServiceFactory, type ServiceConfig } from "./services/factory.js";
import { healthRoutes } from "./routes/health.js";
import { createRepoRoutes } from "./routes/repos.js";
import { createScanRoutes } from "./routes/scans.js";
import { createDupesRoutes } from "./routes/dupes.js";
import { ScanOrchestrator } from "./pipeline/scan-orchestrator.js";
import { IngestProcessor } from "./pipeline/ingest.js";
import { EmbedProcessor } from "./pipeline/embed.js";
import { ClusterProcessor } from "./pipeline/cluster.js";
import { VerifyProcessor } from "./pipeline/verify.js";
import { RankProcessor } from "./pipeline/rank.js";

export interface AppConfig {
  dbPath: string;
  services?: ServiceConfig;
}

export function createApp(config: AppConfig | string) {
  // Support simple string path for tests
  const dbPath = typeof config === "string" ? config : config.dbPath;
  const db = new Database(dbPath);
  const queue = new LocalJobQueue(db);

  // Build processors
  const processors: any[] = [new ScanOrchestrator(db, queue)];

  if (typeof config !== "string" && config.services) {
    const factory = new ServiceFactory(config.services);
    const github = factory.createGitHubClient();
    const embeddingLLM = factory.createEmbeddingProvider();
    const chatLLM = factory.createLLMProvider();
    const vectorStore = factory.createVectorStore();

    processors.push(
      new IngestProcessor(db, github, queue),
      new EmbedProcessor(db, embeddingLLM, vectorStore, queue),
      new ClusterProcessor(db, vectorStore, {
        codeSimilarityThreshold: 0.85,
        intentSimilarityThreshold: 0.80,
      }, queue),
      new VerifyProcessor(db, chatLLM, queue),
      new RankProcessor(db, chatLLM),
    );
  }

  const worker = new WorkerLoop(queue, processors);

  const app = new Hono();
  app.route("/", healthRoutes);
  app.route("/", createRepoRoutes(db));
  app.route("/", createScanRoutes(db, queue));
  app.route("/", createDupesRoutes(db));

  return { app, ctx: { db, queue, worker } };
}
```

**Step 2: Update index.ts to load config from environment**

```typescript
// packages/api/src/index.ts
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const dbPath = process.env.DATABASE_PATH || "./ossgard.db";
const { app, ctx } = createApp({
  dbPath,
  services: {
    github: { token: process.env.GITHUB_TOKEN || "" },
    llm: {
      provider: process.env.LLM_PROVIDER || "ollama",
      model: process.env.LLM_MODEL || "llama3",
      apiKey: process.env.LLM_API_KEY || "",
    },
    embedding: { model: process.env.EMBEDDING_MODEL || "nomic-embed-text" },
    ollamaUrl: process.env.OLLAMA_URL || "http://localhost:11434",
    qdrantUrl: process.env.QDRANT_URL || "http://localhost:6333",
  },
});

export { app };

const port = parseInt(process.env.PORT || "3400");
serve({ fetch: app.fetch, port }, () => {
  console.log(`ossgard-api running on http://localhost:${port}`);
  ctx.worker.start();
  console.log("Worker loop started");
});
```

**Step 3: Update existing tests that use createApp(":memory:")**

Tests still work because createApp accepts a string for the simple case.

**Step 4: Run all tests**

```bash
pnpm --filter @ossgard/api test
```
Expected: ALL PASS

**Step 5: Commit**

```bash
git add packages/api/src
git commit -m "feat: wire all pipeline processors with real services via config"
```

---

### Task 3: Update Docker Compose with config passthrough

**Files:**
- Modify: `docker-compose.yml`
- Modify: `packages/api/Dockerfile`

**Step 1: Update docker-compose.yml to pass config as env vars**

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
      context: .
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
      QDRANT_URL: http://qdrant:6333
      OLLAMA_URL: http://ollama:11434
      DATABASE_PATH: /data/ossgard.db
      CONFIG_PATH: /config/config.toml

volumes:
  ossgard-vectors:
  ossgard-models:
  ossgard-data:
```

**Step 2: Update API to read config.toml from CONFIG_PATH**

Add config file reading to `packages/api/src/index.ts`:

```typescript
import { readFileSync, existsSync } from "fs";
import TOML from "@iarna/toml";

// Read config from mounted volume if available
let fileConfig: any = {};
const configPath = process.env.CONFIG_PATH;
if (configPath && existsSync(configPath)) {
  const content = readFileSync(configPath, "utf-8");
  fileConfig = TOML.parse(content);
}

const { app, ctx } = createApp({
  dbPath,
  services: {
    github: { token: fileConfig.github?.token || process.env.GITHUB_TOKEN || "" },
    llm: {
      provider: fileConfig.llm?.provider || process.env.LLM_PROVIDER || "ollama",
      model: fileConfig.llm?.model || process.env.LLM_MODEL || "llama3",
      apiKey: fileConfig.llm?.api_key || process.env.LLM_API_KEY || "",
    },
    embedding: {
      model: fileConfig.embedding?.model || process.env.EMBEDDING_MODEL || "nomic-embed-text",
    },
    ollamaUrl: process.env.OLLAMA_URL || "http://localhost:11434",
    qdrantUrl: process.env.QDRANT_URL || "http://localhost:6333",
  },
});
```

**Step 3: Commit**

```bash
git add docker-compose.yml packages/api
git commit -m "feat: pass config from host to API container via volume mount"
```

---

### Task 4: Add Ollama model pulling to `ossgard up`

**Files:**
- Modify: `packages/cli/src/commands/stack.ts`

**Step 1: After docker compose up, pull required Ollama models**

Add a post-start step to the `up` command:

```typescript
// After docker compose up -d succeeds:
console.log("Pulling Ollama models...");

const config = new Config();
const loaded = config.load();
const embeddingModel = loaded.embedding.model;
const chatModel = loaded.llm.model;

// Only pull if using Ollama
if (loaded.llm.provider === "ollama") {
  for (const model of [embeddingModel, chatModel]) {
    console.log(`  Pulling ${model}...`);
    execSync(`docker compose -f ${composePath} exec ollama ollama pull ${model}`, {
      stdio: "inherit",
    });
  }
}

console.log("ossgard is ready!");
```

**Step 2: Commit**

```bash
git add packages/cli/src/commands/stack.ts
git commit -m "feat: auto-pull Ollama models on ossgard up"
```

---

### Task 5: End-to-end smoke test

**Files:**
- Create: `e2e/smoke.test.ts`

**Step 1: Create E2E test**

This test requires Docker to be running and uses a small public repo.

```typescript
// e2e/smoke.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";

const API_URL = "http://localhost:3400";

// This test requires: docker compose up -d
// Run with: pnpm test:e2e
describe("E2E: Full pipeline smoke test", () => {
  it("health check passes", async () => {
    const res = await fetch(`${API_URL}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("can track a repo", async () => {
    const res = await fetch(`${API_URL}/repos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner: "octocat", name: "hello-world" }),
    });
    expect(res.status).toBe(201);
  });

  it("can list tracked repos", async () => {
    const res = await fetch(`${API_URL}/repos`);
    expect(res.status).toBe(200);
    const repos = await res.json();
    expect(repos.length).toBeGreaterThanOrEqual(1);
  });

  it("can trigger a scan", async () => {
    const res = await fetch(`${API_URL}/repos/octocat/hello-world/scan`, {
      method: "POST",
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.scanId).toBeDefined();
  });

  it("can untrack a repo", async () => {
    const res = await fetch(`${API_URL}/repos/octocat/hello-world`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
  });
});
```

**Step 2: Add e2e test script to root package.json**

```json
{
  "scripts": {
    "test:e2e": "vitest run --config e2e/vitest.config.ts"
  }
}
```

**Step 3: Create e2e vitest config**

```typescript
// e2e/vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts"],
    testTimeout: 30000,
  },
});
```

**Step 4: Commit**

```bash
git add e2e package.json
git commit -m "feat: add end-to-end smoke test for full pipeline"
```

---

### Task 6: Install @qdrant/js-client-rest and @iarna/toml

**Files:**
- Modify: `packages/api/package.json`

**Step 1: Install Qdrant client in API package**

```bash
cd /Users/dhruv/Code/ossgard && pnpm --filter @ossgard/api add @qdrant/js-client-rest
```

**Step 2: Install TOML parser in API package (for config reading)**

```bash
pnpm --filter @ossgard/api add @iarna/toml
```

**Step 3: Run all tests to verify nothing broke**

```bash
pnpm test
```

**Step 4: Commit**

```bash
git add pnpm-lock.yaml packages/api/package.json
git commit -m "chore: add qdrant client and toml parser dependencies"
```
