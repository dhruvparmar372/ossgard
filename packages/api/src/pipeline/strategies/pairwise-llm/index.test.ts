import { PairwiseLLMStrategy } from "./index.js";
import type { StrategyContext } from "../../strategy.js";
import type { PR } from "@ossgard/shared";
import type { ChatProvider } from "../../../services/llm-provider.js";
import type { EmbeddingProvider } from "../../../services/llm-provider.js";
import type { VectorStore, SearchResult } from "../../../services/vector-store.js";
import type { ServiceResolver, ResolvedServices } from "../../../services/service-resolver.js";
import type { Database } from "../../../db/database.js";

function makePR(overrides: Partial<PR> = {}): PR {
  return {
    id: 1,
    repoId: 1,
    number: 1,
    title: "Test PR",
    body: "Test body",
    author: "tester",
    diffHash: "abc123",
    filePaths: ["src/index.ts"],
    state: "open",
    githubEtag: null,
    embedHash: null,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function createMockLLM(chatResponses?: Array<{ response: Record<string, unknown>; usage: { inputTokens: number; outputTokens: number } }>): ChatProvider {
  const responses = chatResponses ?? [];
  let callIndex = 0;

  return {
    maxContextTokens: 200_000,
    countTokens: (t: string) => Math.ceil(t.length / 3.5),
    chat: vi.fn().mockImplementation(async () => {
      if (callIndex < responses.length) {
        return responses[callIndex++];
      }
      return { response: {}, usage: { inputTokens: 10, outputTokens: 5 } };
    }),
  };
}

function createMockEmbedding(dimensions = 3): EmbeddingProvider {
  return {
    dimensions,
    maxInputTokens: 8192,
    countTokens: (t: string) => Math.ceil(t.length / 3.5),
    embed: vi.fn().mockImplementation(async (texts: string[]) => {
      // Return distinct vectors for each text
      return texts.map((_, i) => [i * 0.1, i * 0.2, i * 0.3]);
    }),
  };
}

function createMockVectorStore(searchBehavior?: (collection: string, vector: number[], opts: any) => SearchResult[]): VectorStore {
  return {
    ensureCollection: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockImplementation(async (collection: string, vector: number[], opts: any) => {
      if (searchBehavior) return searchBehavior(collection, vector, opts);
      return [];
    }),
    deleteByFilter: vi.fn().mockResolvedValue(undefined),
    getVector: vi.fn().mockResolvedValue(null),
  };
}

function createMockDb(): Database {
  return {
    updateScanStatus: vi.fn(),
  } as unknown as Database;
}

function createMockResolver(services: Partial<ResolvedServices>): ServiceResolver {
  return {
    resolve: vi.fn().mockResolvedValue({
      github: {},
      llm: services.llm,
      embedding: services.embedding,
      vectorStore: services.vectorStore,
      scanConfig: services.scanConfig ?? {
        codeSimilarityThreshold: 0.85,
        intentSimilarityThreshold: 0.80,
      },
    }),
  } as unknown as ServiceResolver;
}

function makeContext(overrides: Partial<StrategyContext> = {}): StrategyContext {
  return {
    prs: [],
    scanId: 1,
    repoId: 1,
    accountId: 1,
    resolver: createMockResolver({}),
    db: createMockDb(),
    ...overrides,
  };
}

describe("PairwiseLLMStrategy", () => {
  it("has name 'pairwise-llm'", () => {
    const strategy = new PairwiseLLMStrategy();
    expect(strategy.name).toBe("pairwise-llm");
  });

  it("produces groups for duplicate PRs", async () => {
    const pr1 = makePR({ id: 1, number: 1, title: "Fix auth bug", filePaths: ["src/auth.ts"], body: "Fixes the login issue" });
    const pr2 = makePR({ id: 2, number: 2, title: "Fix login bug", filePaths: ["src/auth.ts"], body: "Fixes authentication" });

    // LLM responses: intent extraction (2 calls) + pairwise verification (1 call) + ranking (1 call)
    const llm = createMockLLM([
      // Intent extraction PR1
      { response: { summary: "Fixes authentication bug in login flow" }, usage: { inputTokens: 100, outputTokens: 20 } },
      // Intent extraction PR2
      { response: { summary: "Fixes authentication bug in login flow" }, usage: { inputTokens: 100, outputTokens: 20 } },
      // Pairwise verification
      { response: { isDuplicate: true, confidence: 0.9, relationship: "near_duplicate", rationale: "Both fix auth" }, usage: { inputTokens: 200, outputTokens: 40 } },
      // Ranking
      { response: { rankings: [{ prNumber: 1, score: 85, rationale: "More complete fix" }, { prNumber: 2, score: 70, rationale: "Simpler approach" }] }, usage: { inputTokens: 150, outputTokens: 30 } },
    ]);

    const embedding = createMockEmbedding();
    const vectorStore = createMockVectorStore((_collection, _vector, _opts) => {
      // Each PR's search returns the other PR as a neighbor above threshold
      // We need to figure out which PR is searching based on the vector
      // Since embed returns [i*0.1, i*0.2, i*0.3], PR1 (index 0) gets [0,0,0] and PR2 (index 1) gets [0.1,0.2,0.3]
      if (_vector[0] === 0 && _vector[1] === 0) {
        // PR1 searching - return PR2 as neighbor
        return [{ id: "1-2-intent-v2", score: 0.85, payload: { repoId: 1, prNumber: 2, prId: 2 } }];
      }
      // PR2 searching - return PR1 as neighbor
      return [{ id: "1-1-intent-v2", score: 0.85, payload: { repoId: 1, prNumber: 1, prId: 1 } }];
    });

    const db = createMockDb();
    const resolver = createMockResolver({ llm, embedding, vectorStore });

    const strategy = new PairwiseLLMStrategy();
    const result = await strategy.execute(makeContext({ prs: [pr1, pr2], resolver, db }));

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].members).toHaveLength(2);
    expect(result.groups[0].confidence).toBe(0.9);
    expect(result.groups[0].relationship).toBe("near_duplicate");
    expect(result.groups[0].label).toContain("Fixes authentication bug");

    // Members should be ranked
    expect(result.groups[0].members[0].prNumber).toBe(1);
    expect(result.groups[0].members[0].rank).toBe(1);
    expect(result.groups[0].members[0].score).toBe(85);
    expect(result.groups[0].members[1].prNumber).toBe(2);
    expect(result.groups[0].members[1].rank).toBe(2);
    expect(result.groups[0].members[1].score).toBe(70);

    // Verify status updates were called
    expect(db.updateScanStatus).toHaveBeenCalledWith(1, "embedding");
    expect(db.updateScanStatus).toHaveBeenCalledWith(1, "verifying");
    expect(db.updateScanStatus).toHaveBeenCalledWith(1, "ranking");
  });

  it("produces no groups for unrelated PRs", async () => {
    const pr1 = makePR({ id: 1, number: 1, title: "Fix auth bug", filePaths: ["src/auth.ts"] });
    const pr2 = makePR({ id: 2, number: 2, title: "Add dark mode", filePaths: ["src/theme.ts"] });

    const llm = createMockLLM([
      // Intent extraction PR1
      { response: { summary: "Fixes authentication bug" }, usage: { inputTokens: 100, outputTokens: 20 } },
      // Intent extraction PR2
      { response: { summary: "Adds dark mode theme" }, usage: { inputTokens: 100, outputTokens: 20 } },
      // Pairwise verification - NOT duplicate
      { response: { isDuplicate: false, confidence: 0.1, relationship: "unrelated", rationale: "Completely different features" }, usage: { inputTokens: 200, outputTokens: 40 } },
    ]);

    const embedding = createMockEmbedding();
    const vectorStore = createMockVectorStore((_collection, _vector, _opts) => {
      // Return neighbors above threshold so pairs are formed (but verifier rejects)
      if (_vector[0] === 0 && _vector[1] === 0) {
        return [{ id: "1-2-intent-v2", score: 0.8, payload: { repoId: 1, prNumber: 2, prId: 2 } }];
      }
      return [{ id: "1-1-intent-v2", score: 0.8, payload: { repoId: 1, prNumber: 1, prId: 1 } }];
    });

    const db = createMockDb();
    const resolver = createMockResolver({ llm, embedding, vectorStore });

    const strategy = new PairwiseLLMStrategy();
    const result = await strategy.execute(makeContext({ prs: [pr1, pr2], resolver, db }));

    // No groups because the verifier said they're not duplicates
    expect(result.groups).toHaveLength(0);
  });

  it("does not transitively group unconfirmed pairs", async () => {
    // 3 PRs: A-B duplicate, B-C duplicate, A-C NOT duplicate
    // Should NOT group A and C together
    const prA = makePR({ id: 1, number: 1, title: "Fix auth A", filePaths: ["src/auth.ts"] });
    const prB = makePR({ id: 2, number: 2, title: "Fix auth B", filePaths: ["src/auth.ts"] });
    const prC = makePR({ id: 3, number: 3, title: "Fix auth C", filePaths: ["src/auth.ts"] });

    let verifyCallIndex = 0;
    const verifyResponses = [
      // A-B: duplicate
      { isDuplicate: true, confidence: 0.9, relationship: "near_duplicate", rationale: "Same fix" },
      // A-C: NOT duplicate
      { isDuplicate: false, confidence: 0.2, relationship: "unrelated", rationale: "Different purpose" },
      // B-C: duplicate
      { isDuplicate: true, confidence: 0.85, relationship: "near_duplicate", rationale: "Same fix" },
    ];

    let chatCallIndex = 0;
    const llm: ChatProvider = {
      maxContextTokens: 200_000,
      countTokens: (t: string) => Math.ceil(t.length / 3.5),
      chat: vi.fn().mockImplementation(async () => {
        chatCallIndex++;
        // First 3 calls are intent extraction
        if (chatCallIndex <= 3) {
          return { response: { summary: `Intent for PR ${chatCallIndex}` }, usage: { inputTokens: 100, outputTokens: 20 } };
        }
        // Next 3 calls are pairwise verification
        if (chatCallIndex <= 6) {
          const resp = verifyResponses[verifyCallIndex++];
          return { response: resp, usage: { inputTokens: 200, outputTokens: 40 } };
        }
        // Ranking call
        return {
          response: {
            rankings: [
              { prNumber: 1, score: 80, rationale: "Good" },
              { prNumber: 2, score: 70, rationale: "OK" },
            ],
          },
          usage: { inputTokens: 150, outputTokens: 30 },
        };
      }),
    };

    const embedding = createMockEmbedding();

    // The search must return all other PRs as neighbors for each PR, so all 3 pairs are formed
    const vectorStore = createMockVectorStore((_collection, _vector, _opts) => {
      // For each PR, return the other two as neighbors
      const results: SearchResult[] = [];
      if (_vector[0] !== 0 || _vector[1] !== 0) {
        results.push({ id: "1-1-x", score: 0.8, payload: { repoId: 1, prNumber: 1, prId: 1 } });
      }
      if (Math.abs(_vector[0] - 0.1) > 0.001 || Math.abs(_vector[1] - 0.2) > 0.001) {
        results.push({ id: "1-2-x", score: 0.8, payload: { repoId: 1, prNumber: 2, prId: 2 } });
      }
      if (Math.abs(_vector[0] - 0.2) > 0.001 || Math.abs(_vector[1] - 0.4) > 0.001) {
        results.push({ id: "1-3-x", score: 0.8, payload: { repoId: 1, prNumber: 3, prId: 3 } });
      }
      return results;
    });

    const db = createMockDb();
    const resolver = createMockResolver({ llm, embedding, vectorStore });

    const strategy = new PairwiseLLMStrategy();
    const result = await strategy.execute(makeContext({ prs: [prA, prB, prC], resolver, db }));

    // CliqueGrouper requires all members to be pairwise confirmed.
    // A-B and B-C are confirmed, but A-C is not, so no group of 3.
    // The greedy clique picks the highest confidence edge first (A-B at 0.9),
    // then tries to expand. C is not connected to A, so C is excluded.
    // B-C edge: B is already used, so B-C can't form a new group.
    // Result: only one group of [A, B]
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].members.map((m) => m.prNumber).sort()).toEqual([1, 2]);
    // C should NOT be in any group with A
    for (const group of result.groups) {
      const numbers = group.members.map((m) => m.prNumber);
      const hasA = numbers.includes(1);
      const hasC = numbers.includes(3);
      expect(hasA && hasC).toBe(false);
    }
  });

  it("tracks token usage across all phases", async () => {
    const pr1 = makePR({ id: 1, number: 1, title: "Fix A", filePaths: ["src/a.ts"] });
    const pr2 = makePR({ id: 2, number: 2, title: "Fix B", filePaths: ["src/a.ts"] });

    const llm = createMockLLM([
      // Intent extraction PR1
      { response: { summary: "Fix A" }, usage: { inputTokens: 100, outputTokens: 20 } },
      // Intent extraction PR2
      { response: { summary: "Fix B" }, usage: { inputTokens: 110, outputTokens: 25 } },
      // Pairwise verification
      { response: { isDuplicate: true, confidence: 0.9, relationship: "near_duplicate", rationale: "Same fix" }, usage: { inputTokens: 200, outputTokens: 40 } },
      // Ranking
      { response: { rankings: [{ prNumber: 1, score: 85, rationale: "Better" }, { prNumber: 2, score: 70, rationale: "OK" }] }, usage: { inputTokens: 150, outputTokens: 30 } },
    ]);

    const embedding = createMockEmbedding();
    const vectorStore = createMockVectorStore((_collection, _vector, _opts) => {
      if (_vector[0] === 0 && _vector[1] === 0) {
        return [{ id: "1-2-x", score: 0.85, payload: { repoId: 1, prNumber: 2, prId: 2 } }];
      }
      return [{ id: "1-1-x", score: 0.85, payload: { repoId: 1, prNumber: 1, prId: 1 } }];
    });

    const db = createMockDb();
    const resolver = createMockResolver({ llm, embedding, vectorStore });

    const strategy = new PairwiseLLMStrategy();
    const result = await strategy.execute(makeContext({ prs: [pr1, pr2], resolver, db }));

    // Token usage should sum verification (200 input, 40 output) + ranking (150 input, 30 output)
    // Intent extraction tokens are NOT tracked in totalInput/totalOutput (they're internal to IntentExtractor)
    expect(result.tokenUsage.inputTokens).toBe(200 + 150); // verify + rank
    expect(result.tokenUsage.outputTokens).toBe(40 + 30); // verify + rank
  });

  it("handles empty PR list", async () => {
    const llm = createMockLLM([]);
    const embedding = createMockEmbedding();
    const vectorStore = createMockVectorStore();
    const db = createMockDb();
    const resolver = createMockResolver({ llm, embedding, vectorStore });

    const strategy = new PairwiseLLMStrategy();
    const result = await strategy.execute(makeContext({ prs: [], resolver, db }));

    expect(result.groups).toHaveLength(0);
    expect(result.tokenUsage.inputTokens).toBe(0);
    expect(result.tokenUsage.outputTokens).toBe(0);
  });

  it("embeds into both intent and code collections", async () => {
    const pr1 = makePR({ id: 1, number: 1, title: "Fix A", filePaths: ["src/a.ts"] });

    const llm = createMockLLM([
      { response: { summary: "Fix A" }, usage: { inputTokens: 100, outputTokens: 20 } },
    ]);
    const embedding = createMockEmbedding();
    const vectorStore = createMockVectorStore();
    const db = createMockDb();
    const resolver = createMockResolver({ llm, embedding, vectorStore });

    const strategy = new PairwiseLLMStrategy();
    await strategy.execute(makeContext({ prs: [pr1], resolver, db }));

    // Should ensure both collections
    expect(vectorStore.ensureCollection).toHaveBeenCalledWith("ossgard-intent-v2", 3);
    expect(vectorStore.ensureCollection).toHaveBeenCalledWith("ossgard-code-v2", 3);

    // Should upsert into both collections
    expect(vectorStore.upsert).toHaveBeenCalledTimes(2);
    const upsertCalls = (vectorStore.upsert as any).mock.calls;
    expect(upsertCalls[0][0]).toBe("ossgard-intent-v2");
    expect(upsertCalls[1][0]).toBe("ossgard-code-v2");

    // Embedding should be called twice (intent texts + code texts)
    expect(embedding.embed).toHaveBeenCalledTimes(2);
  });

  it("skips neighbors below threshold", async () => {
    const pr1 = makePR({ id: 1, number: 1, title: "Fix A", filePaths: ["src/a.ts"] });
    const pr2 = makePR({ id: 2, number: 2, title: "Unrelated B", filePaths: ["src/b.ts"] });

    const llm = createMockLLM([
      { response: { summary: "Fix A" }, usage: { inputTokens: 100, outputTokens: 20 } },
      { response: { summary: "Unrelated B" }, usage: { inputTokens: 100, outputTokens: 20 } },
    ]);
    const embedding = createMockEmbedding();
    // Return neighbors BELOW the 0.65 threshold
    const vectorStore = createMockVectorStore(() => {
      return [{ id: "1-2-x", score: 0.3, payload: { repoId: 1, prNumber: 2, prId: 2 } }];
    });
    const db = createMockDb();
    const resolver = createMockResolver({ llm, embedding, vectorStore });

    const strategy = new PairwiseLLMStrategy();
    const result = await strategy.execute(makeContext({ prs: [pr1, pr2], resolver, db }));

    // No candidate pairs formed, so no groups
    expect(result.groups).toHaveLength(0);
    // The verifier should not have been called (no pairs to verify)
    // Verify by checking that only intent extraction calls happened (2 calls)
    expect(llm.chat).toHaveBeenCalledTimes(2);
  });
});
