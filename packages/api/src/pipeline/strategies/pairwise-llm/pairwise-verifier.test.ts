import { PairwiseVerifier } from "./pairwise-verifier.js";
import type { PR } from "@ossgard/shared";
import type { ChatProvider, BatchChatProvider } from "../../../services/llm-provider.js";

function makePR(overrides: Partial<PR> = {}): PR {
  return {
    id: 1,
    repoId: 1,
    number: 1,
    title: "Test PR",
    body: "Test body",
    author: "tester",
    diffHash: "abc123",
    filePaths: [],
    state: "open",
    githubEtag: null,
    embedHash: null,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function createMockChat(responses: Record<string, unknown>[]): ChatProvider {
  let callIndex = 0;
  return {
    maxContextTokens: 200_000,
    countTokens: (t: string) => Math.ceil(t.length / 4),
    chat: vi.fn().mockImplementation(async () => ({
      response: responses[callIndex++] ?? { isDuplicate: false, confidence: 0, relationship: "unknown", rationale: "" },
      usage: { inputTokens: 100, outputTokens: 50 },
    })),
  };
}

function createMockBatchChat(): BatchChatProvider {
  return {
    batch: true as const,
    maxContextTokens: 200_000,
    countTokens: (t: string) => Math.ceil(t.length / 4),
    chat: vi.fn().mockResolvedValue({
      response: { isDuplicate: false, confidence: 0, relationship: "unknown", rationale: "" },
      usage: { inputTokens: 100, outputTokens: 50 },
    }),
    chatBatch: vi.fn().mockResolvedValue([]),
  };
}

describe("PairwiseVerifier", () => {
  it("returns isDuplicate=true for matching PRs", async () => {
    const mockChat = createMockChat([
      { isDuplicate: true, confidence: 0.95, relationship: "near_duplicate", rationale: "Both PRs fix the same login validation bug" },
    ]);
    const verifier = new PairwiseVerifier(mockChat);

    const prA = makePR({ number: 1, title: "Fix login validation" });
    const prB = makePR({ number: 2, id: 2, title: "Correct session token check" });

    const result = await verifier.verify(prA, prB, "Fixes login bug", "Fixes session token validation");

    expect(result.isDuplicate).toBe(true);
    expect(result.confidence).toBe(0.95);
    expect(result.relationship).toBe("near_duplicate");
    expect(result.rationale).toBe("Both PRs fix the same login validation bug");
    expect(mockChat.chat).toHaveBeenCalledTimes(1);
  });

  it("returns isDuplicate=false for unrelated PRs", async () => {
    const mockChat = createMockChat([
      { isDuplicate: false, confidence: 0.1, relationship: "unrelated", rationale: "Different features entirely" },
    ]);
    const verifier = new PairwiseVerifier(mockChat);

    const prA = makePR({ number: 10, title: "Add dark mode" });
    const prB = makePR({ number: 20, id: 2, title: "Fix memory leak" });

    const result = await verifier.verify(prA, prB, "Adds dark mode to UI", "Fixes memory leak in worker");

    expect(result.isDuplicate).toBe(false);
    expect(result.confidence).toBe(0.1);
    expect(result.relationship).toBe("unrelated");
    expect(result.rationale).toBe("Different features entirely");
  });

  it("batches multiple pairs", async () => {
    const mockBatch = createMockBatchChat();
    (mockBatch.chatBatch as any).mockResolvedValue([
      {
        id: "verify-0",
        response: { isDuplicate: true, confidence: 0.9, relationship: "near_duplicate", rationale: "Same bug fix" },
        usage: { inputTokens: 200, outputTokens: 60 },
      },
      {
        id: "verify-1",
        response: { isDuplicate: false, confidence: 0.15, relationship: "unrelated", rationale: "Different goals" },
        usage: { inputTokens: 180, outputTokens: 55 },
      },
      {
        id: "verify-2",
        response: { isDuplicate: true, confidence: 0.85, relationship: "exact_duplicate", rationale: "Identical intent" },
        usage: { inputTokens: 190, outputTokens: 58 },
      },
    ]);

    const verifier = new PairwiseVerifier(mockBatch);
    const pairs = [
      { prA: makePR({ number: 1 }), prB: makePR({ number: 2, id: 2 }), intentA: "A1", intentB: "B1" },
      { prA: makePR({ number: 3, id: 3 }), prB: makePR({ number: 4, id: 4 }), intentA: "A2", intentB: "B2" },
      { prA: makePR({ number: 5, id: 5 }), prB: makePR({ number: 6, id: 6 }), intentA: "A3", intentB: "B3" },
    ];

    const { results, tokenUsage } = await verifier.verifyBatch(pairs);

    expect(mockBatch.chatBatch).toHaveBeenCalledTimes(1);
    expect(mockBatch.chat).not.toHaveBeenCalled();

    // Verify batch request structure
    const batchCall = (mockBatch.chatBatch as any).mock.calls[0][0];
    expect(batchCall).toHaveLength(3);
    expect(batchCall[0].id).toBe("verify-0");
    expect(batchCall[1].id).toBe("verify-1");
    expect(batchCall[2].id).toBe("verify-2");

    expect(results).toHaveLength(3);
    expect(results[0].isDuplicate).toBe(true);
    expect(results[1].isDuplicate).toBe(false);
    expect(results[2].isDuplicate).toBe(true);

    expect(tokenUsage.inputTokens).toBe(200 + 180 + 190);
    expect(tokenUsage.outputTokens).toBe(60 + 55 + 58);
  });

  it("handles batch errors gracefully", async () => {
    const mockBatch = createMockBatchChat();
    (mockBatch.chatBatch as any).mockResolvedValue([
      {
        id: "verify-0",
        response: { isDuplicate: true, confidence: 0.9, relationship: "near_duplicate", rationale: "Same fix" },
        usage: { inputTokens: 200, outputTokens: 60 },
      },
      {
        id: "verify-1",
        response: {},
        usage: { inputTokens: 0, outputTokens: 0 },
        error: "Rate limit exceeded",
      },
    ]);

    const verifier = new PairwiseVerifier(mockBatch);
    const pairs = [
      { prA: makePR({ number: 1 }), prB: makePR({ number: 2, id: 2 }), intentA: "A1", intentB: "B1" },
      { prA: makePR({ number: 3, id: 3 }), prB: makePR({ number: 4, id: 4 }), intentA: "A2", intentB: "B2" },
    ];

    const { results } = await verifier.verifyBatch(pairs);

    expect(results).toHaveLength(2);
    // First pair succeeded
    expect(results[0].isDuplicate).toBe(true);
    expect(results[0].relationship).toBe("near_duplicate");
    // Second pair had error
    expect(results[1].isDuplicate).toBe(false);
    expect(results[1].confidence).toBe(0);
    expect(results[1].relationship).toBe("error");
    expect(results[1].rationale).toBe("Rate limit exceeded");
  });

  it("falls back to sequential for single pair", async () => {
    const mockBatch = createMockBatchChat();
    (mockBatch.chat as any).mockResolvedValue({
      response: { isDuplicate: true, confidence: 0.88, relationship: "near_duplicate", rationale: "Same fix" },
      usage: { inputTokens: 150, outputTokens: 40 },
    });

    const verifier = new PairwiseVerifier(mockBatch);
    const pairs = [
      { prA: makePR({ number: 1 }), prB: makePR({ number: 2, id: 2 }), intentA: "Intent A", intentB: "Intent B" },
    ];

    const { results } = await verifier.verifyBatch(pairs);

    expect(mockBatch.chat).toHaveBeenCalledTimes(1);
    expect(mockBatch.chatBatch).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0].isDuplicate).toBe(true);
    expect(results[0].confidence).toBe(0.88);
  });

  it("parseResult handles malformed response", async () => {
    const mockChat: ChatProvider = {
      maxContextTokens: 200_000,
      countTokens: (t: string) => Math.ceil(t.length / 4),
      chat: vi.fn().mockResolvedValue({
        response: "not valid json {{{",
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    };

    const verifier = new PairwiseVerifier(mockChat);
    const prA = makePR({ number: 1 });
    const prB = makePR({ number: 2, id: 2 });

    const result = await verifier.verify(prA, prB, "intent A", "intent B");

    expect(result.isDuplicate).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.relationship).toBe("parse_error");
    expect(result.rationale).toBe("Failed to parse LLM response");
  });

  it("builds messages with PR details", async () => {
    const mockChat = createMockChat([
      { isDuplicate: false, confidence: 0.5, relationship: "related", rationale: "Related but different" },
    ]);
    const verifier = new PairwiseVerifier(mockChat);

    const prA = makePR({
      number: 42,
      title: "Fix auth bug",
      author: "alice",
      body: "This fixes the authentication issue",
      filePaths: ["src/auth.ts", "src/middleware.ts"],
    });
    const prB = makePR({
      number: 99,
      id: 2,
      title: "Update login flow",
      author: "bob",
      body: "Refactors the login flow",
      filePaths: ["src/login.ts", "src/session.ts"],
    });

    await verifier.verify(prA, prB, "Fixes auth token validation", "Refactors login page UI");

    const callMessages = (mockChat.chat as any).mock.calls[0][0];
    expect(callMessages).toHaveLength(2);

    // System message
    expect(callMessages[0].role).toBe("system");
    expect(callMessages[0].content).toContain("compare two pull requests");

    // User message contains PR details
    const userMessage = callMessages[1].content as string;
    expect(callMessages[1].role).toBe("user");

    // PR A details
    expect(userMessage).toContain("PR #42: Fix auth bug");
    expect(userMessage).toContain("Author: alice");
    expect(userMessage).toContain("Intent: Fixes auth token validation");
    expect(userMessage).toContain("src/auth.ts");
    expect(userMessage).toContain("src/middleware.ts");
    expect(userMessage).toContain("This fixes the authentication issue");

    // PR B details
    expect(userMessage).toContain("PR #99: Update login flow");
    expect(userMessage).toContain("Author: bob");
    expect(userMessage).toContain("Intent: Refactors login page UI");
    expect(userMessage).toContain("src/login.ts");
    expect(userMessage).toContain("src/session.ts");
    expect(userMessage).toContain("Refactors the login flow");
  });

  it("uses sequential chat for non-batch provider with multiple pairs", async () => {
    const mockChat = createMockChat([
      { isDuplicate: true, confidence: 0.9, relationship: "near_duplicate", rationale: "Same" },
      { isDuplicate: false, confidence: 0.1, relationship: "unrelated", rationale: "Different" },
    ]);
    const verifier = new PairwiseVerifier(mockChat);

    const pairs = [
      { prA: makePR({ number: 1 }), prB: makePR({ number: 2, id: 2 }), intentA: "A1", intentB: "B1" },
      { prA: makePR({ number: 3, id: 3 }), prB: makePR({ number: 4, id: 4 }), intentA: "A2", intentB: "B2" },
    ];

    const { results, tokenUsage } = await verifier.verifyBatch(pairs);

    expect(mockChat.chat).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(results[0].isDuplicate).toBe(true);
    expect(results[1].isDuplicate).toBe(false);

    expect(tokenUsage.inputTokens).toBe(200); // 100 * 2
    expect(tokenUsage.outputTokens).toBe(100); // 50 * 2
  });

  it("handles null body in PR", async () => {
    const mockChat = createMockChat([
      { isDuplicate: false, confidence: 0.5, relationship: "related", rationale: "Related" },
    ]);
    const verifier = new PairwiseVerifier(mockChat);

    const prA = makePR({ number: 1, body: null });
    const prB = makePR({ number: 2, id: 2, body: null });

    await verifier.verify(prA, prB, "intent A", "intent B");

    const callMessages = (mockChat.chat as any).mock.calls[0][0];
    const userMessage = callMessages[1].content as string;

    expect(userMessage).toContain("Body: (none)");
  });

  it("truncates file paths to first 20", async () => {
    const manyFiles = Array.from({ length: 30 }, (_, i) => `src/file-${i}.ts`);
    const mockChat = createMockChat([
      { isDuplicate: false, confidence: 0, relationship: "unrelated", rationale: "" },
    ]);
    const verifier = new PairwiseVerifier(mockChat);

    const prA = makePR({ number: 1, filePaths: manyFiles });
    const prB = makePR({ number: 2, id: 2 });

    await verifier.verify(prA, prB, "intent A", "intent B");

    const callMessages = (mockChat.chat as any).mock.calls[0][0];
    const userMessage = callMessages[1].content as string;

    // Should include file-0 through file-19 but not file-20+
    expect(userMessage).toContain("src/file-0.ts");
    expect(userMessage).toContain("src/file-19.ts");
    expect(userMessage).not.toContain("src/file-20.ts");
  });
});
