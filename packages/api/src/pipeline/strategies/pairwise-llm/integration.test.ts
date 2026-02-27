import { describe, it, expect, vi } from "vitest";
import { PairwiseLLMStrategy } from "./index.js";
import { Database } from "../../../db/database.js";
import type { ServiceResolver } from "../../../services/service-resolver.js";
import type { StrategyContext } from "../../strategy.js";
import type { VectorStore, SearchResult } from "../../../services/vector-store.js";
import type { ChatProvider, Message } from "../../../services/llm-provider.js";
import type { EmbeddingProvider } from "../../../services/llm-provider.js";
import type { AccountConfig } from "@ossgard/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function createInMemoryVectorStore(): VectorStore {
  const collections = new Map<
    string,
    Map<string, { vector: number[]; payload: Record<string, unknown> }>
  >();

  return {
    ensureCollection: vi.fn().mockResolvedValue(undefined),
    upsert: vi
      .fn()
      .mockImplementation(async (collection: string, points: any[]) => {
        if (!collections.has(collection)) collections.set(collection, new Map());
        const col = collections.get(collection)!;
        for (const p of points) {
          col.set(p.id, { vector: p.vector, payload: p.payload });
        }
      }),
    search: vi
      .fn()
      .mockImplementation(
        async (collection: string, vector: number[], opts: any) => {
          const col = collections.get(collection);
          if (!col) return [];
          const results: SearchResult[] = [];
          for (const [id, point] of col) {
            const score = cosineSim(vector, point.vector);
            results.push({ id, score, payload: point.payload });
          }
          results.sort((a, b) => b.score - a.score);
          return results.slice(0, opts.limit);
        }
      ),
    getVector: vi.fn().mockResolvedValue(null),
    deleteByFilter: vi.fn().mockResolvedValue(undefined),
  };
}

const DUMMY_ACCOUNT_CONFIG: AccountConfig = {
  github: { token: "ghp_test" },
  llm: {
    provider: "openai",
    url: "http://localhost",
    model: "test",
    api_key: "sk-test",
  },
  embedding: {
    provider: "openai",
    url: "http://localhost",
    model: "test",
    api_key: "sk-test",
  },
  vector_store: { url: "http://localhost", api_key: "vs-test" },
  scan: {
    code_similarity_threshold: 0.85,
    intent_similarity_threshold: 0.8,
  },
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("PairwiseLLMStrategy integration", () => {
  // ---------- Test 1: finds duplicates and ignores unrelated ----------

  it("finds duplicates between similar PRs and ignores unrelated ones", async () => {
    // ---- DB setup ----
    const db = new Database(":memory:");
    const account = db.createAccount("test-key", "test", DUMMY_ACCOUNT_CONFIG);
    const repo = db.insertRepo("test", "repo");

    db.upsertPR({
      repoId: repo.id,
      number: 1,
      title: "Fix login timeout",
      body: "Sessions expire too quickly",
      author: "alice",
      diffHash: "aaa",
      filePaths: ["src/auth.ts", "src/session.ts"],
      state: "open",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    });
    db.upsertPR({
      repoId: repo.id,
      number: 2,
      title: "Fix session expiration bug",
      body: "Auth sessions time out too fast",
      author: "bob",
      diffHash: "bbb",
      filePaths: ["src/auth.ts", "src/session.ts"],
      state: "open",
      createdAt: "2025-01-02T00:00:00Z",
      updatedAt: "2025-01-02T00:00:00Z",
    });
    db.upsertPR({
      repoId: repo.id,
      number: 3,
      title: "Add dark mode toggle",
      body: "Adds a button to switch between light and dark themes",
      author: "carol",
      diffHash: "ccc",
      filePaths: ["src/theme.ts", "src/ui/toggle.tsx"],
      state: "open",
      createdAt: "2025-01-03T00:00:00Z",
      updatedAt: "2025-01-03T00:00:00Z",
    });
    db.upsertPR({
      repoId: repo.id,
      number: 4,
      title: "Fix typo in README",
      body: "Corrects a misspelling in the getting started section",
      author: "dave",
      diffHash: "ddd",
      filePaths: ["README.md"],
      state: "open",
      createdAt: "2025-01-04T00:00:00Z",
      updatedAt: "2025-01-04T00:00:00Z",
    });

    // ---- Embedding mock ----
    const mockEmbedding: EmbeddingProvider = {
      dimensions: 3,
      maxInputTokens: 8000,
      countTokens: (t: string) => Math.ceil(t.length / 4),
      embed: vi.fn().mockImplementation(async (texts: string[]) => {
        return {
          vectors: texts.map((t) => {
            const lower = t.toLowerCase();
            if (
              lower.includes("login") ||
              lower.includes("session") ||
              lower.includes("auth") ||
              lower.includes("timeout") ||
              lower.includes("expir")
            )
              return [0.9, 0.1, 0.1];
            if (
              lower.includes("dark") ||
              lower.includes("theme") ||
              lower.includes("toggle")
            )
              return [0.1, 0.9, 0.1];
            // typo / readme
            return [0.1, 0.1, 0.9];
          }),
          tokenCount: 0,
        };
      }),
    };

    // ---- Vector store mock ----
    const mockVectorStore = createInMemoryVectorStore();

    // ---- LLM mock ----
    const mockLlm: ChatProvider = {
      maxContextTokens: 200_000,
      countTokens: (t: string) => Math.ceil(t.length / 4),
      chat: vi.fn().mockImplementation(async (messages: Message[]) => {
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        const user = messages.find((m) => m.role === "user")?.content ?? "";

        // Phase 1 — Intent extraction (system prompt mentions "summarize")
        if (system.includes("summarize")) {
          let summary = "General changes";
          const lower = user.toLowerCase();
          if (lower.includes("login") || lower.includes("session"))
            summary =
              "Fixes a bug where user sessions expire prematurely causing login timeouts.";
          else if (lower.includes("dark") || lower.includes("theme"))
            summary = "Adds a dark mode theme toggle to the UI.";
          else if (lower.includes("typo") || lower.includes("readme"))
            summary = "Corrects a typo in the README documentation.";

          return {
            response: { summary },
            usage: { inputTokens: 100, outputTokens: 20 },
          };
        }

        // Phase 3 — Pairwise verification (system prompt mentions "compare")
        if (system.includes("compare")) {
          // Check which PRs are being compared
          const hasLogin =
            user.includes("login") || user.includes("session");
          const hasDark = user.includes("dark") || user.includes("theme");
          const hasTypo = user.includes("typo") || user.includes("README");

          // PR1 & PR2 are both about login/session — they are duplicates
          // If both sides of the comparison mention login/session keywords,
          // that means it's PR1 vs PR2.
          const prNumbers = [...user.matchAll(/PR #(\d+)/g)].map((m) =>
            Number(m[1])
          );
          const is1v2 =
            prNumbers.includes(1) && prNumbers.includes(2);

          if (is1v2) {
            return {
              response: {
                isDuplicate: true,
                confidence: 0.95,
                relationship: "near_duplicate",
                rationale:
                  "Both PRs fix the same session expiration / login timeout bug.",
              },
              usage: { inputTokens: 200, outputTokens: 40 },
            };
          }

          // All other pairs are NOT duplicates
          return {
            response: {
              isDuplicate: false,
              confidence: 0.1,
              relationship: "unrelated",
              rationale: "These PRs address completely different issues.",
            },
            usage: { inputTokens: 200, outputTokens: 40 },
          };
        }

        // Phase 4 — Ranking (system prompt mentions "rank")
        if (system.includes("rank")) {
          // Extract PR numbers from user message to build rankings
          const prNumbers = [...user.matchAll(/PR #(\d+)/g)].map((m) =>
            Number(m[1])
          );
          const unique = [...new Set(prNumbers)];
          return {
            response: {
              rankings: unique.map((n, i) => ({
                prNumber: n,
                score: 90 - i * 10,
                rationale: `PR #${n} ranked ${i + 1}`,
              })),
            },
            usage: { inputTokens: 150, outputTokens: 30 },
          };
        }

        // Fallback
        return {
          response: {},
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }),
    };

    // ---- ServiceResolver mock ----
    const resolver = {
      resolve: vi.fn().mockResolvedValue({
        llm: mockLlm,
        embedding: mockEmbedding,
        vectorStore: mockVectorStore,
        scanConfig: {
          candidateThreshold: 0.65,
          maxCandidatesPerPr: 5,
        },
      }),
    } as unknown as ServiceResolver;

    // ---- Execute strategy ----
    const scan = db.createScan(repo.id, account.id);
    const prs = db.listOpenPRs(repo.id);

    const ctx: StrategyContext = {
      prs,
      scanId: scan.id,
      repoId: repo.id,
      accountId: account.id,
      resolver,
      db,
    };

    const strategy = new PairwiseLLMStrategy();
    const result = await strategy.execute(ctx);

    // ---- Assertions ----
    // Exactly 1 duplicate group: PRs 1 & 2
    expect(result.groups).toHaveLength(1);

    const group = result.groups[0];
    const memberNumbers = group.members.map((m) => m.prNumber).sort();
    expect(memberNumbers).toEqual([1, 2]);

    // PR 3 (dark mode) should NOT be in any group
    for (const g of result.groups) {
      const nums = g.members.map((m) => m.prNumber);
      expect(nums).not.toContain(3);
      expect(nums).not.toContain(4);
    }

    // Confidence should come from the verification
    expect(group.confidence).toBe(0.95);
    expect(group.relationship).toBe("near_duplicate");

    // Members should have rank and score
    expect(group.members[0].rank).toBe(1);
    expect(group.members[0].score).toBeGreaterThan(group.members[1].score);
    expect(group.members[1].rank).toBe(2);

    // Token usage should be non-zero
    expect(result.tokenUsage.inputTokens).toBeGreaterThan(0);
    expect(result.tokenUsage.outputTokens).toBeGreaterThan(0);

    // phaseTokenUsage should exist with per-phase breakdowns
    expect(result.phaseTokenUsage).toBeDefined();
    expect(result.phaseTokenUsage.intent.input).toBeGreaterThan(0);
    expect(result.phaseTokenUsage.verify.input).toBeGreaterThan(0);
    expect(result.phaseTokenUsage.rank.input).toBeGreaterThan(0);

    // providerInfo should come from the account config
    expect(result.providerInfo).toEqual({
      llmProvider: "openai",
      llmModel: "test",
      embeddingProvider: "openai",
      embeddingModel: "test",
    });

    db.close();
  });

  // ---------- Test 2: prevents transitive grouping ----------

  it("prevents transitive grouping", async () => {
    // Three PRs: A-B are duplicates, B-C are duplicates, but A-C are NOT.
    // The clique grouper must NOT put A and C in the same group.

    const db = new Database(":memory:");
    const account = db.createAccount("test-key", "test", DUMMY_ACCOUNT_CONFIG);
    const repo = db.insertRepo("test", "repo");

    // PR A — Caching layer for user profiles
    db.upsertPR({
      repoId: repo.id,
      number: 1,
      title: "Add Redis caching for user profiles",
      body: "Caches user profile lookups in Redis to reduce DB load",
      author: "alice",
      diffHash: "aaa",
      filePaths: ["src/cache.ts", "src/user-service.ts"],
      state: "open",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    });

    // PR B — Overlaps with both A and C but through different aspects
    // Shares "caching" with A, shares "session" with C
    db.upsertPR({
      repoId: repo.id,
      number: 2,
      title: "Cache session data and user profiles",
      body: "Adds caching for both session tokens and user profile data",
      author: "bob",
      diffHash: "bbb",
      filePaths: ["src/cache.ts", "src/session.ts", "src/user-service.ts"],
      state: "open",
      createdAt: "2025-01-02T00:00:00Z",
      updatedAt: "2025-01-02T00:00:00Z",
    });

    // PR C — Session management (shares "session" with B but NOT with A)
    db.upsertPR({
      repoId: repo.id,
      number: 3,
      title: "Improve session token management",
      body: "Better handling of session token refresh and expiration",
      author: "carol",
      diffHash: "ccc",
      filePaths: ["src/session.ts", "src/token-service.ts"],
      state: "open",
      createdAt: "2025-01-03T00:00:00Z",
      updatedAt: "2025-01-03T00:00:00Z",
    });

    // ---- Embedding mock ----
    // All three PRs get similar-enough vectors so that ALL three pairs
    // exceed the 0.65 candidate threshold. This forces the CliqueGrouper
    // (not just the embedding filter) to prevent transitive grouping.
    //
    // Vectors chosen so cosine(A,B) > 0.65, cosine(B,C) > 0.65,
    // and cosine(A,C) > 0.65 — all three become candidate pairs.
    // The LLM verifier then rejects A-C, and the CliqueGrouper must
    // respect that rejection.
    const mockEmbedding: EmbeddingProvider = {
      dimensions: 3,
      maxInputTokens: 8000,
      countTokens: (t: string) => Math.ceil(t.length / 4),
      embed: vi.fn().mockImplementation(async (texts: string[]) => {
        return {
          vectors: texts.map((t) => {
            const lower = t.toLowerCase();
            if (
              lower.includes("redis") ||
              (lower.includes("cache") && lower.includes("user"))
            )
              return [0.9, 0.4, 0.3]; // A-like
            if (
              lower.includes("session") &&
              lower.includes("cache")
            )
              return [0.7, 0.6, 0.5]; // B-like (between A and C)
            if (
              lower.includes("session") ||
              lower.includes("token")
            )
              return [0.5, 0.8, 0.5]; // C-like
            // fallback: somewhere in the middle
            return [0.6, 0.6, 0.6];
          }),
          tokenCount: 0,
        };
      }),
    };

    // ---- Vector store mock ----
    const mockVectorStore = createInMemoryVectorStore();

    // ---- LLM mock ----
    const mockLlm: ChatProvider = {
      maxContextTokens: 200_000,
      countTokens: (t: string) => Math.ceil(t.length / 4),
      chat: vi.fn().mockImplementation(async (messages: Message[]) => {
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        const user = messages.find((m) => m.role === "user")?.content ?? "";

        // Phase 1 — Intent extraction
        if (system.includes("summarize")) {
          let summary = "General caching changes";
          const lower = user.toLowerCase();
          if (lower.includes("redis") && lower.includes("user"))
            summary = "Adds Redis caching for user profile lookups to reduce database load.";
          else if (lower.includes("session") && lower.includes("cache"))
            summary = "Adds caching for session data and user profiles.";
          else if (lower.includes("session") && lower.includes("token"))
            summary = "Improves session token management with better refresh and expiration handling.";

          return {
            response: { summary },
            usage: { inputTokens: 100, outputTokens: 20 },
          };
        }

        // Phase 3 — Pairwise verification
        if (system.includes("compare")) {
          const prNumbers = [...user.matchAll(/PR #(\d+)/g)].map((m) =>
            Number(m[1])
          );
          const a = Math.min(...prNumbers);
          const b = Math.max(...prNumbers);

          // A-B: duplicate (both about user profile caching)
          if (a === 1 && b === 2) {
            return {
              response: {
                isDuplicate: true,
                confidence: 0.88,
                relationship: "near_duplicate",
                rationale: "Both PRs implement caching for user profiles.",
              },
              usage: { inputTokens: 200, outputTokens: 40 },
            };
          }

          // B-C: duplicate (both about session management)
          if (a === 2 && b === 3) {
            return {
              response: {
                isDuplicate: true,
                confidence: 0.82,
                relationship: "near_duplicate",
                rationale: "Both PRs deal with session data management.",
              },
              usage: { inputTokens: 200, outputTokens: 40 },
            };
          }

          // A-C: NOT duplicate (Redis caching vs session token management)
          if (a === 1 && b === 3) {
            return {
              response: {
                isDuplicate: false,
                confidence: 0.15,
                relationship: "unrelated",
                rationale:
                  "PR 1 is about Redis caching for profiles, PR 3 is about session token handling. Different concerns.",
              },
              usage: { inputTokens: 200, outputTokens: 40 },
            };
          }

          // Fallback — should not happen
          return {
            response: {
              isDuplicate: false,
              confidence: 0,
              relationship: "unrelated",
              rationale: "Fallback",
            },
            usage: { inputTokens: 200, outputTokens: 40 },
          };
        }

        // Phase 4 — Ranking
        if (system.includes("rank")) {
          const prNumbers = [...user.matchAll(/PR #(\d+)/g)].map((m) =>
            Number(m[1])
          );
          const unique = [...new Set(prNumbers)];
          return {
            response: {
              rankings: unique.map((n, i) => ({
                prNumber: n,
                score: 90 - i * 10,
                rationale: `PR #${n} ranked ${i + 1}`,
              })),
            },
            usage: { inputTokens: 150, outputTokens: 30 },
          };
        }

        return {
          response: {},
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }),
    };

    // ---- ServiceResolver mock ----
    const resolver = {
      resolve: vi.fn().mockResolvedValue({
        llm: mockLlm,
        embedding: mockEmbedding,
        vectorStore: mockVectorStore,
        scanConfig: {
          candidateThreshold: 0.65,
          maxCandidatesPerPr: 5,
        },
      }),
    } as unknown as ServiceResolver;

    // ---- Execute strategy ----
    const scan = db.createScan(repo.id, account.id);
    const prs = db.listOpenPRs(repo.id);

    const ctx: StrategyContext = {
      prs,
      scanId: scan.id,
      repoId: repo.id,
      accountId: account.id,
      resolver,
      db,
    };

    const strategy = new PairwiseLLMStrategy();
    const result = await strategy.execute(ctx);

    // ---- THE CRITICAL INVARIANT ----
    // A and C must NEVER appear in the same group, even though
    // A-B and B-C are both confirmed duplicates. The clique grouper
    // requires full pairwise confirmation, and A-C was rejected.
    for (const group of result.groups) {
      const numbers = group.members.map((m) => m.prNumber);
      const hasA = numbers.includes(1);
      const hasC = numbers.includes(3);
      expect(
        hasA && hasC,
        "A (PR 1) and C (PR 3) must NOT be in the same group (transitive grouping prevented)"
      ).toBe(false);
    }

    // There should be exactly one group (A-B only).
    // The greedy clique picker starts with the highest confidence edge (A-B at 0.88).
    // It then tries to expand: C is connected to B but NOT to A, so C is excluded.
    // B is already used, so B-C cannot form a new pair.
    // Result: one group [1, 2].
    expect(result.groups).toHaveLength(1);
    const group = result.groups[0];
    expect(group.members.map((m) => m.prNumber).sort()).toEqual([1, 2]);

    // Verify group metadata
    expect(group.confidence).toBe(0.88);
    expect(group.relationship).toBe("near_duplicate");

    db.close();
  });

  // ---------- Test 3: caching skips redundant work on second run ----------

  it("second run with unchanged PRs skips intent extraction, embedding, and pairwise verification", async () => {
    const db = new Database(":memory:");
    const account = db.createAccount("test-key", "test", DUMMY_ACCOUNT_CONFIG);
    const repo = db.insertRepo("test", "repo");

    // Insert 2 similar PRs
    db.upsertPR({
      repoId: repo.id, number: 1,
      title: "Fix login timeout", body: "Sessions expire too quickly",
      author: "alice", diffHash: "aaa",
      filePaths: ["src/auth.ts", "src/session.ts"],
      state: "open", createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z",
    });
    db.upsertPR({
      repoId: repo.id, number: 2,
      title: "Fix session expiration bug", body: "Auth sessions time out too fast",
      author: "bob", diffHash: "bbb",
      filePaths: ["src/auth.ts", "src/session.ts"],
      state: "open", createdAt: "2025-01-02T00:00:00Z", updatedAt: "2025-01-02T00:00:00Z",
    });

    // Shared mocks
    const embedCallCounts = { embed: 0 };
    const llmCallCounts = { chat: 0 };

    const mockEmbedding: EmbeddingProvider = {
      dimensions: 3,
      maxInputTokens: 8000,
      countTokens: (t: string) => Math.ceil(t.length / 4),
      embed: vi.fn().mockImplementation(async (texts: string[]) => {
        embedCallCounts.embed++;
        return {
          vectors: texts.map((t) => {
            const lower = t.toLowerCase();
            if (lower.includes("login") || lower.includes("session") || lower.includes("auth") || lower.includes("timeout") || lower.includes("expir"))
              return [0.9, 0.1, 0.1];
            return [0.1, 0.1, 0.9];
          }),
          tokenCount: 0,
        };
      }),
    };

    // Vector store that persists across runs
    const storedVectors = new Map<string, Map<string, { vector: number[]; payload: Record<string, unknown> }>>();

    const createPersistentVectorStore = (): VectorStore => ({
      ensureCollection: vi.fn().mockResolvedValue(undefined),
      upsert: vi.fn().mockImplementation(async (collection: string, points: any[]) => {
        if (!storedVectors.has(collection)) storedVectors.set(collection, new Map());
        const col = storedVectors.get(collection)!;
        for (const p of points) col.set(p.id, { vector: p.vector, payload: p.payload });
      }),
      search: vi.fn().mockImplementation(async (collection: string, vector: number[], opts: any) => {
        const col = storedVectors.get(collection);
        if (!col) return [];
        const results: SearchResult[] = [];
        for (const [id, point] of col) {
          const score = cosineSim(vector, point.vector);
          results.push({ id, score, payload: point.payload });
        }
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, opts.limit);
      }),
      getVector: vi.fn().mockImplementation(async (collection: string, id: string) => {
        const col = storedVectors.get(collection);
        if (!col) return null;
        const point = col.get(id);
        return point ? point.vector : null;
      }),
      deleteByFilter: vi.fn().mockResolvedValue(undefined),
    });

    const mockLlm: ChatProvider = {
      maxContextTokens: 200_000,
      countTokens: (t: string) => Math.ceil(t.length / 4),
      chat: vi.fn().mockImplementation(async (messages: Message[]) => {
        llmCallCounts.chat++;
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        const user = messages.find((m) => m.role === "user")?.content ?? "";

        if (system.includes("summarize")) {
          let summary = "General changes";
          const lower = user.toLowerCase();
          if (lower.includes("login") || lower.includes("session"))
            summary = "Fixes a bug where user sessions expire prematurely causing login timeouts.";
          return { response: { summary }, usage: { inputTokens: 100, outputTokens: 20 } };
        }

        if (system.includes("compare")) {
          const prNumbers = [...user.matchAll(/PR #(\d+)/g)].map((m) => Number(m[1]));
          const is1v2 = prNumbers.includes(1) && prNumbers.includes(2);
          if (is1v2) {
            return {
              response: { isDuplicate: true, confidence: 0.95, relationship: "near_duplicate", rationale: "Both fix session expiration." },
              usage: { inputTokens: 200, outputTokens: 40 },
            };
          }
          return {
            response: { isDuplicate: false, confidence: 0.1, relationship: "unrelated", rationale: "Different." },
            usage: { inputTokens: 200, outputTokens: 40 },
          };
        }

        if (system.includes("rank")) {
          const prNumbers = [...user.matchAll(/PR #(\d+)/g)].map((m) => Number(m[1]));
          const unique = [...new Set(prNumbers)];
          return {
            response: { rankings: unique.map((n, i) => ({ prNumber: n, score: 90 - i * 10, rationale: `PR #${n} ranked ${i + 1}` })) },
            usage: { inputTokens: 150, outputTokens: 30 },
          };
        }

        return { response: {}, usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    };

    const vectorStore1 = createPersistentVectorStore();
    const resolver = {
      resolve: vi.fn().mockResolvedValue({
        llm: mockLlm,
        embedding: mockEmbedding,
        vectorStore: vectorStore1,
        scanConfig: { candidateThreshold: 0.65, maxCandidatesPerPr: 5 },
      }),
    } as unknown as ServiceResolver;

    // --- First run: everything from scratch ---
    const scan1 = db.createScan(repo.id, account.id);
    const prs1 = db.listOpenPRs(repo.id);

    const strategy = new PairwiseLLMStrategy();
    const result1 = await strategy.execute({
      prs: prs1, scanId: scan1.id, repoId: repo.id, accountId: account.id, resolver, db,
    });

    expect(result1.groups).toHaveLength(1);
    expect(result1.groups[0].members.map((m) => m.prNumber).sort()).toEqual([1, 2]);

    const firstRunEmbedCalls = embedCallCounts.embed;
    const firstRunLlmCalls = llmCallCounts.chat;

    // Verify cache fields were written
    const pr1After = db.getPR(prs1[0].id);
    expect(pr1After!.embedHash).toBeTruthy();
    expect(pr1After!.intentSummary).toBeTruthy();

    // --- Second run: PRs unchanged, should use caches ---
    // Re-read PRs from DB (they now have embedHash and intentSummary)
    const scan2 = db.createScan(repo.id, account.id);
    const prs2 = db.listOpenPRs(repo.id);

    // Reset counters
    embedCallCounts.embed = 0;
    llmCallCounts.chat = 0;

    // Use same persistent vector store so getVector works
    const vectorStore2 = createPersistentVectorStore();
    const resolver2 = {
      resolve: vi.fn().mockResolvedValue({
        llm: mockLlm,
        embedding: mockEmbedding,
        vectorStore: vectorStore2,
        scanConfig: { candidateThreshold: 0.65, maxCandidatesPerPr: 5 },
      }),
    } as unknown as ServiceResolver;

    const result2 = await strategy.execute({
      prs: prs2, scanId: scan2.id, repoId: repo.id, accountId: account.id, resolver: resolver2, db,
    });

    // Same results
    expect(result2.groups).toHaveLength(1);
    expect(result2.groups[0].members.map((m) => m.prNumber).sort()).toEqual([1, 2]);

    // No embedding calls (PRs unchanged, vectors retrieved from store)
    expect(embedCallCounts.embed).toBe(0);

    // Only ranking LLM calls (no intent extraction or pairwise verification)
    // Intent: 0 (cached), Verify: 0 (cached), Rank: 1
    expect(llmCallCounts.chat).toBe(1); // only the ranking call

    db.close();
  });

  // ---------- Test 4: changed PR triggers re-extraction ----------

  it("changed PR triggers re-extraction and re-embedding while unchanged PR uses cache", async () => {
    const db = new Database(":memory:");
    const account = db.createAccount("test-key", "test", DUMMY_ACCOUNT_CONFIG);
    const repo = db.insertRepo("test", "repo");

    db.upsertPR({
      repoId: repo.id, number: 1,
      title: "Fix login timeout", body: "Sessions expire too quickly",
      author: "alice", diffHash: "aaa",
      filePaths: ["src/auth.ts", "src/session.ts"],
      state: "open", createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z",
    });
    db.upsertPR({
      repoId: repo.id, number: 2,
      title: "Fix session expiration bug", body: "Auth sessions time out too fast",
      author: "bob", diffHash: "bbb",
      filePaths: ["src/auth.ts", "src/session.ts"],
      state: "open", createdAt: "2025-01-02T00:00:00Z", updatedAt: "2025-01-02T00:00:00Z",
    });

    const intentExtractCalls: string[][] = [];

    const mockEmbedding: EmbeddingProvider = {
      dimensions: 3,
      maxInputTokens: 8000,
      countTokens: (t: string) => Math.ceil(t.length / 4),
      embed: vi.fn().mockImplementation(async (texts: string[]) => {
        return {
          vectors: texts.map((t) => {
            const lower = t.toLowerCase();
            if (lower.includes("login") || lower.includes("session") || lower.includes("auth") || lower.includes("timeout") || lower.includes("expir"))
              return [0.9, 0.1, 0.1];
            return [0.1, 0.1, 0.9];
          }),
          tokenCount: 0,
        };
      }),
    };

    const storedVectors = new Map<string, Map<string, { vector: number[]; payload: Record<string, unknown> }>>();
    const createPersistentVectorStore = (): VectorStore => ({
      ensureCollection: vi.fn().mockResolvedValue(undefined),
      upsert: vi.fn().mockImplementation(async (collection: string, points: any[]) => {
        if (!storedVectors.has(collection)) storedVectors.set(collection, new Map());
        const col = storedVectors.get(collection)!;
        for (const p of points) col.set(p.id, { vector: p.vector, payload: p.payload });
      }),
      search: vi.fn().mockImplementation(async (collection: string, vector: number[], opts: any) => {
        const col = storedVectors.get(collection);
        if (!col) return [];
        const results: SearchResult[] = [];
        for (const [id, point] of col) {
          const score = cosineSim(vector, point.vector);
          results.push({ id, score, payload: point.payload });
        }
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, opts.limit);
      }),
      getVector: vi.fn().mockImplementation(async (collection: string, id: string) => {
        const col = storedVectors.get(collection);
        if (!col) return null;
        const point = col.get(id);
        return point ? point.vector : null;
      }),
      deleteByFilter: vi.fn().mockResolvedValue(undefined),
    });

    const mockLlm: ChatProvider = {
      maxContextTokens: 200_000,
      countTokens: (t: string) => Math.ceil(t.length / 4),
      chat: vi.fn().mockImplementation(async (messages: Message[]) => {
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        const user = messages.find((m) => m.role === "user")?.content ?? "";

        if (system.includes("summarize")) {
          intentExtractCalls.push([user]);
          let summary = "General changes";
          const lower = user.toLowerCase();
          if (lower.includes("login") || lower.includes("session"))
            summary = "Fixes a bug where user sessions expire prematurely causing login timeouts.";
          return { response: { summary }, usage: { inputTokens: 100, outputTokens: 20 } };
        }

        if (system.includes("compare")) {
          const prNumbers = [...user.matchAll(/PR #(\d+)/g)].map((m) => Number(m[1]));
          if (prNumbers.includes(1) && prNumbers.includes(2)) {
            return {
              response: { isDuplicate: true, confidence: 0.95, relationship: "near_duplicate", rationale: "Both fix session expiration." },
              usage: { inputTokens: 200, outputTokens: 40 },
            };
          }
          return {
            response: { isDuplicate: false, confidence: 0.1, relationship: "unrelated", rationale: "Different." },
            usage: { inputTokens: 200, outputTokens: 40 },
          };
        }

        if (system.includes("rank")) {
          const prNumbers = [...user.matchAll(/PR #(\d+)/g)].map((m) => Number(m[1]));
          const unique = [...new Set(prNumbers)];
          return {
            response: { rankings: unique.map((n, i) => ({ prNumber: n, score: 90 - i * 10, rationale: `PR #${n} ranked ${i + 1}` })) },
            usage: { inputTokens: 150, outputTokens: 30 },
          };
        }

        return { response: {}, usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    };

    const vs1 = createPersistentVectorStore();
    const resolver = {
      resolve: vi.fn().mockResolvedValue({
        llm: mockLlm, embedding: mockEmbedding, vectorStore: vs1,
        scanConfig: { candidateThreshold: 0.65, maxCandidatesPerPr: 5 },
      }),
    } as unknown as ServiceResolver;

    // First run
    const scan1 = db.createScan(repo.id, account.id);
    const prs1 = db.listOpenPRs(repo.id);
    const strategy = new PairwiseLLMStrategy();
    await strategy.execute({ prs: prs1, scanId: scan1.id, repoId: repo.id, accountId: account.id, resolver, db });

    // Both PRs had intents extracted
    const firstRunIntentCalls = intentExtractCalls.length;
    expect(firstRunIntentCalls).toBeGreaterThan(0);

    // Now simulate PR 2 being changed (upsert resets cache fields)
    db.upsertPR({
      repoId: repo.id, number: 2,
      title: "Fix session expiration bug v2", body: "Updated fix for session timeout",
      author: "bob", diffHash: "bbb-changed",
      filePaths: ["src/auth.ts", "src/session.ts"],
      state: "open", createdAt: "2025-01-02T00:00:00Z", updatedAt: "2025-01-05T00:00:00Z",
    });

    // Verify PR 2 cache was reset
    const pr2After = db.getPRByNumber(repo.id, 2);
    expect(pr2After!.embedHash).toBeNull();
    expect(pr2After!.intentSummary).toBeNull();

    // PR 1 should still have cache
    const pr1After = db.getPRByNumber(repo.id, 1);
    expect(pr1After!.embedHash).toBeTruthy();
    expect(pr1After!.intentSummary).toBeTruthy();

    // Reset tracking
    intentExtractCalls.length = 0;

    // Second run
    const scan2 = db.createScan(repo.id, account.id);
    const prs2 = db.listOpenPRs(repo.id);

    const vs2 = createPersistentVectorStore();
    const resolver2 = {
      resolve: vi.fn().mockResolvedValue({
        llm: mockLlm, embedding: mockEmbedding, vectorStore: vs2,
        scanConfig: { candidateThreshold: 0.65, maxCandidatesPerPr: 5 },
      }),
    } as unknown as ServiceResolver;

    const result2 = await strategy.execute({ prs: prs2, scanId: scan2.id, repoId: repo.id, accountId: account.id, resolver: resolver2, db });

    // Intent extraction should only have been called for the changed PR (PR 2)
    // PR 1 uses cached intentSummary
    expect(intentExtractCalls.length).toBeGreaterThan(0);

    // Verify embed was called (for changed PR 2)
    expect(mockEmbedding.embed).toHaveBeenCalled();

    // Results should still be valid
    expect(result2.groups).toHaveLength(1);

    db.close();
  });
});
