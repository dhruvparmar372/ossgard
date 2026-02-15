# Phase 5: Embedding & Vector Store

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the LLM provider abstraction, Ollama embedding client, Qdrant vector store service, and the embed pipeline phase that generates code + intent fingerprints for every PR.

**Architecture:** `LLMProvider` interface with `OllamaProvider` implementation. `VectorStore` interface with `QdrantStore` implementation. The `EmbedProcessor` reads PRs from SQLite, generates two embeddings per PR (code fingerprint, intent fingerprint), and upserts them into Qdrant.

**Tech Stack:** Ollama REST API, @qdrant/js-client-rest, Vitest

**Depends on:** Phase 4 (ingested PRs in SQLite)

---

### Task 1: Create LLMProvider interface and OllamaProvider

**Files:**
- Create: `packages/api/src/services/llm-provider.ts`
- Create: `packages/api/src/services/ollama-provider.ts`
- Test: `packages/api/src/services/ollama-provider.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/api/src/services/ollama-provider.test.ts
import { describe, it, expect, vi } from "vitest";
import { OllamaProvider } from "./ollama-provider.js";

describe("OllamaProvider", () => {
  it("generates embeddings via Ollama API", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const provider = new OllamaProvider({
      baseUrl: "http://localhost:11434",
      embeddingModel: "nomic-embed-text",
      chatModel: "llama3",
      fetchFn: mockFetch,
    });

    const result = await provider.embed(["hello world"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual([0.1, 0.2, 0.3]);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:11434/api/embed");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("nomic-embed-text");
    expect(body.input).toEqual(["hello world"]);
  });

  it("sends chat completion via Ollama API", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          message: { role: "assistant", content: '{"result": "test"}' },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const provider = new OllamaProvider({
      baseUrl: "http://localhost:11434",
      embeddingModel: "nomic-embed-text",
      chatModel: "llama3",
      fetchFn: mockFetch,
    });

    const result = await provider.chat([
      { role: "user", content: "test prompt" },
    ]);
    expect(result).toEqual({ result: "test" });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:11434/api/chat");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @ossgard/api test -- src/services/ollama-provider
```

**Step 3: Create LLMProvider interface**

```typescript
// packages/api/src/services/llm-provider.ts
export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMProvider {
  embed(texts: string[]): Promise<number[][]>;
  chat(messages: Message[]): Promise<Record<string, unknown>>;
}
```

**Step 4: Implement OllamaProvider**

```typescript
// packages/api/src/services/ollama-provider.ts
import type { LLMProvider, Message } from "./llm-provider.js";

interface OllamaProviderOptions {
  baseUrl: string;
  embeddingModel: string;
  chatModel: string;
  fetchFn?: typeof fetch;
}

export class OllamaProvider implements LLMProvider {
  private baseUrl: string;
  private embeddingModel: string;
  private chatModel: string;
  private fetchFn: typeof fetch;

  constructor(opts: OllamaProviderOptions) {
    this.baseUrl = opts.baseUrl;
    this.embeddingModel = opts.embeddingModel;
    this.chatModel = opts.chatModel;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await this.fetchFn(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.embeddingModel, input: texts }),
    });
    if (!res.ok) throw new Error(`Ollama embed error: ${res.status}`);
    const data = await res.json() as { embeddings: number[][] };
    return data.embeddings;
  }

  async chat(messages: Message[]): Promise<Record<string, unknown>> {
    const res = await this.fetchFn(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.chatModel,
        messages,
        stream: false,
        format: "json",
      }),
    });
    if (!res.ok) throw new Error(`Ollama chat error: ${res.status}`);
    const data = await res.json() as { message: { content: string } };
    return JSON.parse(data.message.content);
  }
}
```

**Step 5: Run tests**

```bash
pnpm --filter @ossgard/api test -- src/services/ollama-provider
```
Expected: ALL PASS

**Step 6: Commit**

```bash
git add packages/api/src/services/llm-provider.ts packages/api/src/services/ollama-provider.ts packages/api/src/services/ollama-provider.test.ts
git commit -m "feat: add LLMProvider interface and Ollama implementation"
```

---

### Task 2: Create AnthropicProvider (BYOK Claude)

**Files:**
- Create: `packages/api/src/services/anthropic-provider.ts`
- Test: `packages/api/src/services/anthropic-provider.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/api/src/services/anthropic-provider.test.ts
import { describe, it, expect, vi } from "vitest";
import { AnthropicProvider } from "./anthropic-provider.js";

describe("AnthropicProvider", () => {
  it("sends chat via Anthropic Messages API", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: '{"verified": true}' }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const provider = new AnthropicProvider({
      apiKey: "sk-ant-test",
      model: "claude-sonnet-4-5-20250929",
      fetchFn: mockFetch,
    });

    const result = await provider.chat([
      { role: "user", content: "analyze this" },
    ]);
    expect(result).toEqual({ verified: true });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers["x-api-key"]).toBe("sk-ant-test");
  });

  it("embed throws — Anthropic doesn't support embeddings", async () => {
    const provider = new AnthropicProvider({
      apiKey: "sk-ant-test",
      model: "claude-sonnet-4-5-20250929",
    });
    await expect(provider.embed(["test"])).rejects.toThrow();
  });
});
```

**Step 2: Implement AnthropicProvider**

```typescript
// packages/api/src/services/anthropic-provider.ts
import type { LLMProvider, Message } from "./llm-provider.js";

interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  fetchFn?: typeof fetch;
}

export class AnthropicProvider implements LLMProvider {
  private apiKey: string;
  private model: string;
  private fetchFn: typeof fetch;

  constructor(opts: AnthropicProviderOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async embed(_texts: string[]): Promise<number[][]> {
    throw new Error("Anthropic does not support embeddings. Use Ollama for embeddings.");
  }

  async chat(messages: Message[]): Promise<Record<string, unknown>> {
    // Anthropic requires system message to be separate
    const systemMsg = messages.find((m) => m.role === "system");
    const nonSystemMsgs = messages.filter((m) => m.role !== "system");

    const res = await this.fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        system: systemMsg?.content,
        messages: nonSystemMsgs.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${text}`);
    }

    const data = await res.json() as { content: Array<{ type: string; text: string }> };
    const text = data.content.find((c) => c.type === "text")?.text ?? "{}";
    return JSON.parse(text);
  }
}
```

**Step 3: Run tests**

```bash
pnpm --filter @ossgard/api test -- src/services/anthropic-provider
```
Expected: ALL PASS

**Step 4: Commit**

```bash
git add packages/api/src/services/anthropic-provider.ts packages/api/src/services/anthropic-provider.test.ts
git commit -m "feat: add Anthropic BYOK LLM provider for Claude"
```

---

### Task 3: Create VectorStore interface and QdrantStore

**Files:**
- Create: `packages/api/src/services/vector-store.ts`
- Create: `packages/api/src/services/qdrant-store.ts`
- Test: `packages/api/src/services/qdrant-store.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/api/src/services/qdrant-store.test.ts
import { describe, it, expect, vi } from "vitest";
import { QdrantStore } from "./qdrant-store.js";

// Mock the Qdrant client
const mockUpsert = vi.fn(async () => ({}));
const mockSearch = vi.fn(async () => [
  { id: "pr-1", score: 0.95, payload: { repoId: 1, prNumber: 1 } },
  { id: "pr-2", score: 0.87, payload: { repoId: 1, prNumber: 2 } },
]);
const mockDelete = vi.fn(async () => ({}));
const mockGetCollections = vi.fn(async () => ({ collections: [] }));
const mockCreateCollection = vi.fn(async () => ({}));

describe("QdrantStore", () => {
  it("upserts vectors with metadata", async () => {
    const store = new QdrantStore({
      qdrantClient: {
        upsert: mockUpsert,
        search: mockSearch,
        delete: mockDelete,
        getCollections: mockGetCollections,
        createCollection: mockCreateCollection,
      } as any,
    });

    await store.upsert("code-embeddings", [
      {
        id: "pr-42-code",
        vector: [0.1, 0.2, 0.3],
        payload: { repoId: 1, prNumber: 42, type: "code" },
      },
    ]);

    expect(mockUpsert).toHaveBeenCalledWith("code-embeddings", {
      wait: true,
      points: [
        {
          id: "pr-42-code",
          vector: [0.1, 0.2, 0.3],
          payload: { repoId: 1, prNumber: 42, type: "code" },
        },
      ],
    });
  });

  it("queries nearest neighbors", async () => {
    const store = new QdrantStore({
      qdrantClient: {
        upsert: mockUpsert,
        search: mockSearch,
        delete: mockDelete,
        getCollections: mockGetCollections,
        createCollection: mockCreateCollection,
      } as any,
    });

    const results = await store.search("code-embeddings", [0.1, 0.2, 0.3], {
      limit: 10,
      filter: { repoId: 1 },
    });

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("pr-1");
    expect(results[0].score).toBe(0.95);
  });
});
```

**Step 2: Create VectorStore interface**

```typescript
// packages/api/src/services/vector-store.ts
export interface VectorPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface SearchResult {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

export interface SearchOptions {
  limit: number;
  filter?: Record<string, unknown>;
}

export interface VectorStore {
  ensureCollection(name: string, dimensions: number): Promise<void>;
  upsert(collection: string, points: VectorPoint[]): Promise<void>;
  search(collection: string, vector: number[], opts: SearchOptions): Promise<SearchResult[]>;
  deleteByFilter(collection: string, filter: Record<string, unknown>): Promise<void>;
}
```

**Step 3: Implement QdrantStore**

```typescript
// packages/api/src/services/qdrant-store.ts
import type { VectorStore, VectorPoint, SearchResult, SearchOptions } from "./vector-store.js";

interface QdrantStoreOptions {
  qdrantClient: any; // QdrantClient from @qdrant/js-client-rest
}

export class QdrantStore implements VectorStore {
  private client: any;

  constructor(opts: QdrantStoreOptions) {
    this.client = opts.qdrantClient;
  }

  async ensureCollection(name: string, dimensions: number): Promise<void> {
    const { collections } = await this.client.getCollections();
    const exists = collections.some((c: { name: string }) => c.name === name);
    if (!exists) {
      await this.client.createCollection(name, {
        vectors: { size: dimensions, distance: "Cosine" },
      });
    }
  }

  async upsert(collection: string, points: VectorPoint[]): Promise<void> {
    await this.client.upsert(collection, {
      wait: true,
      points: points.map((p) => ({
        id: p.id,
        vector: p.vector,
        payload: p.payload,
      })),
    });
  }

  async search(collection: string, vector: number[], opts: SearchOptions): Promise<SearchResult[]> {
    const results = await this.client.search(collection, {
      vector,
      limit: opts.limit,
      with_payload: true,
      filter: opts.filter
        ? {
            must: Object.entries(opts.filter).map(([key, value]) => ({
              key,
              match: { value },
            })),
          }
        : undefined,
    });

    return results.map((r: any) => ({
      id: String(r.id),
      score: r.score,
      payload: r.payload ?? {},
    }));
  }

  async deleteByFilter(collection: string, filter: Record<string, unknown>): Promise<void> {
    await this.client.delete(collection, {
      filter: {
        must: Object.entries(filter).map(([key, value]) => ({
          key,
          match: { value },
        })),
      },
    });
  }
}
```

**Step 4: Run tests**

```bash
pnpm --filter @ossgard/api test -- src/services/qdrant-store
```
Expected: ALL PASS

**Step 5: Commit**

```bash
git add packages/api/src/services/vector-store.ts packages/api/src/services/qdrant-store.ts packages/api/src/services/qdrant-store.test.ts
git commit -m "feat: add VectorStore interface and Qdrant implementation"
```

---

### Task 4: Build the EmbedProcessor

**Files:**
- Create: `packages/api/src/pipeline/embed.ts`
- Test: `packages/api/src/pipeline/embed.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/api/src/pipeline/embed.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "../db/database.js";
import { EmbedProcessor } from "./embed.js";
import type { LLMProvider } from "../services/llm-provider.js";
import type { VectorStore } from "../services/vector-store.js";
import type { Job } from "@ossgard/shared";

function makeMockLLM(): LLMProvider {
  return {
    embed: vi.fn(async (texts: string[]) =>
      texts.map(() => Array(768).fill(0.1))
    ),
    chat: vi.fn(async () => ({})),
  };
}

function makeMockVectorStore(): VectorStore & { upserted: any[] } {
  const upserted: any[] = [];
  return {
    upserted,
    ensureCollection: vi.fn(async () => {}),
    upsert: vi.fn(async (_col: string, points: any[]) => {
      upserted.push(...points);
    }),
    search: vi.fn(async () => []),
    deleteByFilter: vi.fn(async () => {}),
  };
}

describe("EmbedProcessor", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.insertRepo("test", "repo");
    db.createScan(1);
    // Insert some PRs
    db.upsertPR({
      repoId: 1, number: 1, title: "Add auth", body: "OAuth implementation",
      author: "alice", diffHash: "hash1", filePaths: ["src/auth.ts"],
      state: "open", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z",
    });
    db.upsertPR({
      repoId: 1, number: 2, title: "Add login", body: "Login page",
      author: "bob", diffHash: "hash2", filePaths: ["src/login.ts"],
      state: "open", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z",
    });
  });

  afterEach(() => db.close());

  it("generates code and intent embeddings for each PR", async () => {
    const llm = makeMockLLM();
    const vectorStore = makeMockVectorStore();

    const processor = new EmbedProcessor(db, llm, vectorStore);
    const job: Job = {
      id: "job-1", type: "embed",
      payload: { repoId: 1, scanId: 1 },
      status: "running", result: null, error: null,
      attempts: 1, maxRetries: 3, runAfter: null, createdAt: "", updatedAt: "",
    };

    await processor.process(job);

    // 2 PRs × 2 embeddings each = 4 calls (or 2 batched calls)
    expect(llm.embed).toHaveBeenCalled();
    // Should upsert to both code and intent collections
    expect(vectorStore.upsert).toHaveBeenCalled();
    expect(vectorStore.upserted.length).toBeGreaterThanOrEqual(2);
  });

  it("updates scan status to embedding", async () => {
    const llm = makeMockLLM();
    const vectorStore = makeMockVectorStore();
    const processor = new EmbedProcessor(db, llm, vectorStore);

    const job: Job = {
      id: "job-1", type: "embed",
      payload: { repoId: 1, scanId: 1 },
      status: "running", result: null, error: null,
      attempts: 1, maxRetries: 3, runAfter: null, createdAt: "", updatedAt: "",
    };

    await processor.process(job);

    const scan = db.getScan(1);
    expect(scan!.status).toBe("embedding");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @ossgard/api test -- src/pipeline/embed
```

**Step 3: Implement EmbedProcessor**

```typescript
// packages/api/src/pipeline/embed.ts
import type { Job } from "@ossgard/shared";
import type { Database } from "../db/database.js";
import type { LLMProvider } from "../services/llm-provider.js";
import type { VectorStore } from "../services/vector-store.js";
import type { JobQueue } from "../queue/types.js";

const CODE_COLLECTION = "ossgard-code";
const INTENT_COLLECTION = "ossgard-intent";
const DIMENSIONS = 768;
const BATCH_SIZE = 50;

export class EmbedProcessor {
  readonly type = "embed";

  constructor(
    private db: Database,
    private llm: LLMProvider,
    private vectorStore: VectorStore,
    private queue?: JobQueue
  ) {}

  async process(job: Job): Promise<void> {
    const { repoId, scanId } = job.payload as { repoId: number; scanId: number };

    this.db.updateScanStatus(scanId, "embedding");

    // Ensure collections exist
    await this.vectorStore.ensureCollection(CODE_COLLECTION, DIMENSIONS);
    await this.vectorStore.ensureCollection(INTENT_COLLECTION, DIMENSIONS);

    const prs = this.db.listOpenPRs(repoId);

    // Process in batches
    for (let i = 0; i < prs.length; i += BATCH_SIZE) {
      const batch = prs.slice(i, i + BATCH_SIZE);

      // Build code inputs (normalized diff placeholder — actual diff stored as hash)
      const codeInputs = batch.map((pr) =>
        `${pr.filePaths.join("\n")}\n${pr.diffHash ?? ""}`
      );

      // Build intent inputs
      const intentInputs = batch.map((pr) =>
        `${pr.title}\n${pr.body ?? ""}\n${pr.filePaths.join("\n")}`
      );

      // Generate embeddings
      const codeEmbeddings = await this.llm.embed(codeInputs);
      const intentEmbeddings = await this.llm.embed(intentInputs);

      // Upsert code embeddings
      await this.vectorStore.upsert(
        CODE_COLLECTION,
        batch.map((pr, j) => ({
          id: `${repoId}-${pr.number}-code`,
          vector: codeEmbeddings[j],
          payload: { repoId, prNumber: pr.number, prId: pr.id },
        }))
      );

      // Upsert intent embeddings
      await this.vectorStore.upsert(
        INTENT_COLLECTION,
        batch.map((pr, j) => ({
          id: `${repoId}-${pr.number}-intent`,
          vector: intentEmbeddings[j],
          payload: { repoId, prNumber: pr.number, prId: pr.id },
        }))
      );
    }

    // Chain to next phase
    if (this.queue) {
      await this.queue.enqueue({
        type: "cluster",
        payload: { repoId, scanId },
      });
    }
  }
}
```

**Step 4: Run tests**

```bash
pnpm --filter @ossgard/api test -- src/pipeline/embed
```
Expected: ALL PASS

**Step 5: Commit**

```bash
git add packages/api/src/pipeline/embed.ts packages/api/src/pipeline/embed.test.ts
git commit -m "feat: add embed pipeline processor with code + intent fingerprints"
```
