import { IntentExtractor } from "./intent-extractor.js";
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

function createMockChat(): ChatProvider {
  return {
    maxContextTokens: 200_000,
    countTokens: (t: string) => Math.ceil(t.length / 3.5),
    chat: vi.fn().mockResolvedValue({
      response: { summary: "Default summary." },
      usage: { inputTokens: 100, outputTokens: 20 },
    }),
  };
}

function createMockBatchChat(): BatchChatProvider {
  return {
    batch: true as const,
    maxContextTokens: 200_000,
    countTokens: (t: string) => Math.ceil(t.length / 3.5),
    chat: vi.fn().mockResolvedValue({
      response: { summary: "Default summary." },
      usage: { inputTokens: 100, outputTokens: 20 },
    }),
    chatBatch: vi.fn().mockResolvedValue([]),
  };
}

describe("IntentExtractor", () => {
  it("generates intent summaries for each PR", async () => {
    const mockChat = createMockChat();
    (mockChat.chat as any)
      .mockResolvedValueOnce({
        response: { summary: "This PR fixes the login bug by correcting the session token validation." },
        usage: { inputTokens: 150, outputTokens: 30 },
      })
      .mockResolvedValueOnce({
        response: { summary: "This PR adds dark mode support to the settings page." },
        usage: { inputTokens: 120, outputTokens: 25 },
      });

    const extractor = new IntentExtractor(mockChat);
    const prs = [
      makePR({ number: 1, title: "Fix login bug" }),
      makePR({ number: 2, id: 2, title: "Add dark mode" }),
    ];

    const summaries = await extractor.extract(prs);

    expect(summaries.size).toBe(2);
    expect(summaries.get(1)).toBe("This PR fixes the login bug by correcting the session token validation.");
    expect(summaries.get(2)).toBe("This PR adds dark mode support to the settings page.");
    expect(mockChat.chat).toHaveBeenCalledTimes(2);
  });

  it("handles batch chat provider", async () => {
    const mockBatch = createMockBatchChat();
    (mockBatch.chatBatch as any).mockResolvedValue([
      {
        id: "intent-10",
        response: { summary: "Summary for PR 10." },
        usage: { inputTokens: 100, outputTokens: 20 },
      },
      {
        id: "intent-20",
        response: { summary: "Summary for PR 20." },
        usage: { inputTokens: 110, outputTokens: 25 },
      },
    ]);

    const extractor = new IntentExtractor(mockBatch);
    const prs = [
      makePR({ number: 10, id: 10, title: "PR Ten" }),
      makePR({ number: 20, id: 20, title: "PR Twenty" }),
    ];

    const summaries = await extractor.extract(prs);

    expect(mockBatch.chatBatch).toHaveBeenCalledTimes(1);
    expect(mockBatch.chat).not.toHaveBeenCalled();
    expect(summaries.size).toBe(2);
    expect(summaries.get(10)).toBe("Summary for PR 10.");
    expect(summaries.get(20)).toBe("Summary for PR 20.");

    // Verify batch request IDs
    const batchCall = (mockBatch.chatBatch as any).mock.calls[0][0];
    expect(batchCall).toHaveLength(2);
    expect(batchCall[0].id).toBe("intent-10");
    expect(batchCall[1].id).toBe("intent-20");
  });

  it("falls back to sequential chat for batch provider with single PR", async () => {
    const mockBatch = createMockBatchChat();
    (mockBatch.chat as any).mockResolvedValue({
      response: { summary: "Single PR summary." },
      usage: { inputTokens: 80, outputTokens: 15 },
    });

    const extractor = new IntentExtractor(mockBatch);
    const prs = [makePR({ number: 5 })];

    const summaries = await extractor.extract(prs);

    expect(mockBatch.chat).toHaveBeenCalledTimes(1);
    expect(mockBatch.chatBatch).not.toHaveBeenCalled();
    expect(summaries.get(5)).toBe("Single PR summary.");
  });

  it("truncates long diffs to fit context", async () => {
    const mockChat = createMockChat();
    const extractor = new IntentExtractor(mockChat);

    const longDiff = "x".repeat(20_000); // exceeds MAX_DIFF_CHARS (12_000)
    const pr = makePR({ number: 1, title: "Big change" });
    const diffs = new Map([[1, longDiff]]);

    await extractor.extract([pr], diffs);

    const callMessages = (mockChat.chat as any).mock.calls[0][0];
    const userMessage = callMessages[1].content as string;

    // The diff should be present but truncated
    expect(userMessage).toContain("Code diff (truncated):");
    // The user content should contain at most 12_000 x's (plus other text)
    const xCount = (userMessage.match(/x/g) || []).length;
    expect(xCount).toBe(12_000);
  });

  it("includes diff in prompt when provided", async () => {
    const mockChat = createMockChat();
    const extractor = new IntentExtractor(mockChat);

    const diff = "diff --git a/src/app.ts b/src/app.ts\n+ const x = 1;";
    const pr = makePR({ number: 42, title: "Small fix" });
    const diffs = new Map([[42, diff]]);

    await extractor.extract([pr], diffs);

    const callMessages = (mockChat.chat as any).mock.calls[0][0];
    const userMessage = callMessages[1].content as string;

    expect(userMessage).toContain("Code diff (truncated):");
    expect(userMessage).toContain("diff --git a/src/app.ts b/src/app.ts");
    expect(userMessage).toContain("+ const x = 1;");
  });

  it("falls back to file paths when no diff provided", async () => {
    const mockChat = createMockChat();
    const extractor = new IntentExtractor(mockChat);

    const pr = makePR({
      number: 7,
      title: "Refactor utils",
      filePaths: ["src/utils/format.ts", "src/utils/parse.ts"],
    });

    await extractor.extract([pr]);

    const callMessages = (mockChat.chat as any).mock.calls[0][0];
    const userMessage = callMessages[1].content as string;

    expect(userMessage).toContain("Changed files:");
    expect(userMessage).toContain("src/utils/format.ts");
    expect(userMessage).toContain("src/utils/parse.ts");
    expect(userMessage).not.toContain("Code diff");
  });

  it("shows (none) when PR body is null", async () => {
    const mockChat = createMockChat();
    const extractor = new IntentExtractor(mockChat);

    const pr = makePR({ number: 3, body: null });

    await extractor.extract([pr]);

    const callMessages = (mockChat.chat as any).mock.calls[0][0];
    const userMessage = callMessages[1].content as string;

    expect(userMessage).toContain("Description: (none)");
  });

  it("skips PRs with batch errors", async () => {
    const mockBatch = createMockBatchChat();
    (mockBatch.chatBatch as any).mockResolvedValue([
      {
        id: "intent-1",
        response: { summary: "Good summary." },
        usage: { inputTokens: 100, outputTokens: 20 },
      },
      {
        id: "intent-2",
        response: {},
        usage: { inputTokens: 0, outputTokens: 0 },
        error: "Rate limit exceeded",
      },
    ]);

    const extractor = new IntentExtractor(mockBatch);
    const prs = [
      makePR({ number: 1 }),
      makePR({ number: 2, id: 2 }),
    ];

    const summaries = await extractor.extract(prs);

    expect(summaries.size).toBe(1);
    expect(summaries.has(1)).toBe(true);
    expect(summaries.has(2)).toBe(false);
  });

  it("includes system prompt in messages", async () => {
    const mockChat = createMockChat();
    const extractor = new IntentExtractor(mockChat);

    await extractor.extract([makePR({ number: 1 })]);

    const callMessages = (mockChat.chat as any).mock.calls[0][0];
    expect(callMessages[0].role).toBe("system");
    expect(callMessages[0].content).toContain("code reviewer");
    expect(callMessages[0].content).toContain("2-3 sentences");
    expect(callMessages[1].role).toBe("user");
  });

  it("includes PR number and title in user message", async () => {
    const mockChat = createMockChat();
    const extractor = new IntentExtractor(mockChat);

    await extractor.extract([makePR({ number: 99, title: "Add caching layer" })]);

    const callMessages = (mockChat.chat as any).mock.calls[0][0];
    const userMessage = callMessages[1].content as string;

    expect(userMessage).toContain("PR #99: Add caching layer");
  });
});
