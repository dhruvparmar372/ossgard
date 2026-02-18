# OpenAI LLM Provider Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add OpenAI as a chat/LLM provider with sync and batch support, plus a health check for all providers.

**Architecture:** Two new provider classes (`OpenAIChatProvider`, `OpenAIBatchChatProvider`) that mirror the existing Anthropic pattern, a `provider-health.ts` module for connectivity checks, and a factory update to wire it all together. Uses OpenAI's native JSON mode and tiktoken for token counting.

**Tech Stack:** TypeScript, OpenAI REST API, js-tiktoken, bun test (vitest-compatible)

---

### Task 1: OpenAI Chat Provider — Tests

**Files:**
- Create: `packages/api/src/services/openai-chat-provider.test.ts`

**Step 1: Write the failing tests**

Create test file mirroring the pattern in `anthropic-provider.test.ts`. Tests:

```typescript
import { OpenAIChatProvider } from "./openai-chat-provider.js";

function mockFetch(responseBody: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(responseBody),
  }) as unknown as typeof fetch;
}

function mockFetchError(status: number, statusText: string): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText,
    text: () => Promise.resolve("error body"),
  }) as unknown as typeof fetch;
}

describe("OpenAIChatProvider", () => {
  describe("maxContextTokens", () => {
    it("is 128_000", () => {
      const provider = new OpenAIChatProvider({
        apiKey: "sk-test",
        model: "gpt-4o-mini",
      });
      expect(provider.maxContextTokens).toBe(128_000);
    });
  });

  describe("countTokens", () => {
    it("uses tiktoken encoder", () => {
      const provider = new OpenAIChatProvider({
        apiKey: "sk-test",
        model: "gpt-4o-mini",
      });
      // "hello world" is 2 tokens with tiktoken
      const tokens = provider.countTokens("hello world");
      expect(tokens).toBeGreaterThan(0);
      expect(typeof tokens).toBe("number");
    });
  });

  describe("chat", () => {
    it("returns ChatResult with parsed JSON and token usage", async () => {
      const chatResponse = {
        groups: [{ prIds: [1, 2], label: "duplicate" }],
      };
      const fetchFn = mockFetch({
        choices: [
          { message: { content: JSON.stringify(chatResponse) } },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      });
      const provider = new OpenAIChatProvider({
        apiKey: "sk-test-key",
        model: "gpt-4o-mini",
        fetchFn,
      });

      const result = await provider.chat([
        { role: "user", content: "analyze this" },
      ]);

      expect(result.response).toEqual(chatResponse);
      expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    });

    it("sends correct headers with Bearer auth", async () => {
      const fetchFn = mockFetch({
        choices: [{ message: { content: '{"ok": true}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
      const provider = new OpenAIChatProvider({
        apiKey: "sk-my-secret-key",
        model: "gpt-4o-mini",
        fetchFn,
      });

      await provider.chat([{ role: "user", content: "hello" }]);

      expect(fetchFn).toHaveBeenCalledWith(
        "https://api.openai.com/v1/chat/completions",
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer sk-my-secret-key",
          },
        })
      );
    });

    it("passes system message as a normal message with role system", async () => {
      const fetchFn = mockFetch({
        choices: [{ message: { content: '{"result": "ok"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
      const provider = new OpenAIChatProvider({
        apiKey: "sk-test-key",
        model: "gpt-4o-mini",
        fetchFn,
      });

      await provider.chat([
        { role: "system", content: "You are a code reviewer." },
        { role: "user", content: "Review this PR." },
      ]);

      const callArgs = (fetchFn as any).mock.calls[0];
      const body = JSON.parse(callArgs[1]!.body as string);

      expect(body.messages).toEqual([
        { role: "system", content: "You are a code reviewer." },
        { role: "user", content: "Review this PR." },
      ]);
    });

    it("sends response_format for JSON mode", async () => {
      const fetchFn = mockFetch({
        choices: [{ message: { content: '{"ok": true}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
      const provider = new OpenAIChatProvider({
        apiKey: "sk-test-key",
        model: "gpt-4o-mini",
        fetchFn,
      });

      await provider.chat([{ role: "user", content: "test" }]);

      const callArgs = (fetchFn as any).mock.calls[0];
      const body = JSON.parse(callArgs[1]!.body as string);

      expect(body.response_format).toEqual({ type: "json_object" });
    });

    it("sends the correct model in the body", async () => {
      const fetchFn = mockFetch({
        choices: [{ message: { content: '{"ok": true}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
      const provider = new OpenAIChatProvider({
        apiKey: "sk-test-key",
        model: "gpt-4o",
        fetchFn,
      });

      await provider.chat([{ role: "user", content: "test" }]);

      const callArgs = (fetchFn as any).mock.calls[0];
      const body = JSON.parse(callArgs[1]!.body as string);

      expect(body.model).toBe("gpt-4o");
    });

    it("throws on non-OK response", async () => {
      const fetchFn = mockFetchError(401, "Unauthorized");
      const provider = new OpenAIChatProvider({
        apiKey: "bad-key",
        model: "gpt-4o-mini",
        fetchFn,
      });

      await expect(
        provider.chat([{ role: "user", content: "test" }])
      ).rejects.toThrow("OpenAI chat error: 401 Unauthorized");
    });

    it("throws descriptive error when LLM returns invalid JSON", async () => {
      const fetchFn = mockFetch({
        choices: [{ message: { content: "not json" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
      const provider = new OpenAIChatProvider({
        apiKey: "sk-test-key",
        model: "gpt-4o-mini",
        fetchFn,
      });

      await expect(
        provider.chat([{ role: "user", content: "test" }])
      ).rejects.toThrow("LLM returned invalid JSON");
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/api && bun test src/services/openai-chat-provider.test.ts`
Expected: FAIL — module `./openai-chat-provider.js` not found

**Step 3: Commit**

```bash
git add packages/api/src/services/openai-chat-provider.test.ts
git commit -m "test: add OpenAI chat provider tests"
```

---

### Task 2: OpenAI Chat Provider — Implementation

**Files:**
- Create: `packages/api/src/services/openai-chat-provider.ts`

**Step 1: Write the implementation**

```typescript
import type { ChatProvider, ChatResult, Message } from "./llm-provider.js";
import { createTiktokenEncoder, countTokensTiktoken, type Tiktoken } from "./token-counting.js";

export interface OpenAIChatProviderOptions {
  apiKey: string;
  model: string;
  fetchFn?: typeof fetch;
}

export class OpenAIChatProvider implements ChatProvider {
  readonly maxContextTokens = 128_000;
  private apiKey: string;
  private model: string;
  private fetchFn: typeof fetch;
  private encoder: Tiktoken;

  constructor(options: OpenAIChatProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchFn = options.fetchFn ?? fetch;
    this.encoder = createTiktokenEncoder(options.model);
  }

  countTokens(text: string): number {
    return countTokensTiktoken(this.encoder, text);
  }

  async chat(messages: Message[]): Promise<ChatResult> {
    const response = await this.fetchFn(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 8192,
          response_format: { type: "json_object" },
          messages: messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      }
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `OpenAI chat error: ${response.status} ${response.statusText} — ${body}`
      );
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    const raw = data.choices[0].message.content;
    try {
      return {
        response: JSON.parse(raw) as Record<string, unknown>,
        usage: {
          inputTokens: data.usage.prompt_tokens,
          outputTokens: data.usage.completion_tokens,
        },
      };
    } catch {
      throw new Error(`LLM returned invalid JSON: ${raw.slice(0, 200)}`);
    }
  }
}
```

**Step 2: Run tests to verify they pass**

Run: `cd packages/api && bun test src/services/openai-chat-provider.test.ts`
Expected: All 7 tests PASS

**Step 3: Commit**

```bash
git add packages/api/src/services/openai-chat-provider.ts
git commit -m "feat: add OpenAI chat provider"
```

---

### Task 3: OpenAI Batch Chat Provider — Tests

**Files:**
- Create: `packages/api/src/services/openai-batch-chat-provider.test.ts`

**Step 1: Write the failing tests**

Mirror the pattern from `anthropic-batch-provider.test.ts`, adapted for OpenAI's batch API (file upload + `/v1/batches` endpoint):

```typescript
import { OpenAIBatchChatProvider } from "./openai-batch-chat-provider.js";

function mockFetch(responseBody: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(responseBody),
    text: () => Promise.resolve(JSON.stringify(responseBody)),
  }) as unknown as typeof fetch;
}

describe("OpenAIBatchChatProvider", () => {
  it("has maxContextTokens of 128_000", () => {
    const provider = new OpenAIBatchChatProvider({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
    });
    expect(provider.maxContextTokens).toBe(128_000);
  });

  it("counts tokens via tiktoken", () => {
    const provider = new OpenAIBatchChatProvider({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
    });
    const tokens = provider.countTokens("hello world");
    expect(tokens).toBeGreaterThan(0);
  });

  it("has batch property set to true", () => {
    const provider = new OpenAIBatchChatProvider({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
    });
    expect(provider.batch).toBe(true);
  });

  describe("chat (sync fallback)", () => {
    it("returns ChatResult with parsed JSON and token usage", async () => {
      const chatResponse = { groups: [{ prIds: [1, 2] }] };
      const fetchFn = mockFetch({
        choices: [
          { message: { content: JSON.stringify(chatResponse) } },
        ],
        usage: { prompt_tokens: 200, completion_tokens: 80 },
      });
      const provider = new OpenAIBatchChatProvider({
        apiKey: "sk-test",
        model: "gpt-4o-mini",
        fetchFn,
      });

      const result = await provider.chat([
        { role: "user", content: "analyze" },
      ]);

      expect(result.response).toEqual(chatResponse);
      expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 80 });
    });

    it("throws on non-OK response", async () => {
      const fetchFn = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: () => Promise.resolve("bad key"),
      }) as unknown as typeof fetch;

      const provider = new OpenAIBatchChatProvider({
        apiKey: "bad-key",
        model: "gpt-4o-mini",
        fetchFn,
      });

      await expect(
        provider.chat([{ role: "user", content: "test" }])
      ).rejects.toThrow("OpenAI chat error: 401 Unauthorized");
    });
  });

  describe("chatBatch", () => {
    it("returns empty array for empty input", async () => {
      const provider = new OpenAIBatchChatProvider({
        apiKey: "sk-test",
        model: "gpt-4o-mini",
      });

      const results = await provider.chatBatch([]);
      expect(results).toEqual([]);
    });

    it("uses sync path for single request", async () => {
      const chatResponse = { result: "ok" };
      const fetchFn = mockFetch({
        choices: [
          { message: { content: JSON.stringify(chatResponse) } },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 20 },
      });
      const provider = new OpenAIBatchChatProvider({
        apiKey: "sk-test",
        model: "gpt-4o-mini",
        fetchFn,
      });

      const results = await provider.chatBatch([
        {
          id: "req-1",
          messages: [{ role: "user", content: "hello" }],
        },
      ]);

      expect(results).toEqual([
        { id: "req-1", response: chatResponse, usage: { inputTokens: 50, outputTokens: 20 } },
      ]);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(fetchFn).toHaveBeenCalledWith(
        "https://api.openai.com/v1/chat/completions",
        expect.anything()
      );
    });

    it("uploads file, creates batch, polls, and retrieves results", async () => {
      const fetchFn = vi
        .fn()
        // 1. Upload file
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "file-abc123" }),
        })
        // 2. Create batch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "batch-xyz" }),
        })
        // 3. Poll -> completed
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              status: "completed",
              output_file_id: "file-out-456",
            }),
        })
        // 4. Download results
        .mockResolvedValueOnce({
          ok: true,
          text: () =>
            Promise.resolve(
              [
                JSON.stringify({
                  custom_id: "req-2",
                  response: {
                    status_code: 200,
                    body: {
                      choices: [{ message: { content: '{"score": 70}' } }],
                      usage: { prompt_tokens: 120, completion_tokens: 30 },
                    },
                  },
                }),
                JSON.stringify({
                  custom_id: "req-1",
                  response: {
                    status_code: 200,
                    body: {
                      choices: [{ message: { content: '{"score": 90}' } }],
                      usage: { prompt_tokens: 110, completion_tokens: 25 },
                    },
                  },
                }),
              ].join("\n")
            ),
        }) as unknown as typeof fetch;

      const provider = new OpenAIBatchChatProvider({
        apiKey: "sk-test",
        model: "gpt-4o-mini",
        fetchFn,
        pollIntervalMs: 0,
      });

      const results = await provider.chatBatch([
        { id: "req-1", messages: [{ role: "user", content: "first" }] },
        { id: "req-2", messages: [{ role: "user", content: "second" }] },
      ]);

      // Results returned in input order
      expect(results).toEqual([
        { id: "req-1", response: { score: 90 }, usage: { inputTokens: 110, outputTokens: 25 } },
        { id: "req-2", response: { score: 70 }, usage: { inputTokens: 120, outputTokens: 30 } },
      ]);

      expect(fetchFn).toHaveBeenCalledTimes(4);

      // Upload call
      expect(fetchFn).toHaveBeenNthCalledWith(
        1,
        "https://api.openai.com/v1/files",
        expect.objectContaining({ method: "POST" })
      );

      // Create batch call
      expect(fetchFn).toHaveBeenNthCalledWith(
        2,
        "https://api.openai.com/v1/batches",
        expect.objectContaining({ method: "POST" })
      );

      // Poll call
      expect(fetchFn).toHaveBeenNthCalledWith(
        3,
        "https://api.openai.com/v1/batches/batch-xyz",
        expect.objectContaining({ method: "GET" })
      );

      // Download call
      expect(fetchFn).toHaveBeenNthCalledWith(
        4,
        "https://api.openai.com/v1/files/file-out-456/content",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("throws on batch create failure", async () => {
      const fetchFn = vi
        .fn()
        // Upload succeeds
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "file-abc" }),
        })
        // Batch create fails
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
        }) as unknown as typeof fetch;

      const provider = new OpenAIBatchChatProvider({
        apiKey: "sk-test",
        model: "gpt-4o-mini",
        fetchFn,
      });

      await expect(
        provider.chatBatch([
          { id: "req-1", messages: [{ role: "user", content: "test" }] },
          { id: "req-2", messages: [{ role: "user", content: "test" }] },
        ])
      ).rejects.toThrow("OpenAI batch create error: 500 Internal Server Error");
    });

    it("handles per-item errors in batch results", async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "file-abc" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "batch-err" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              status: "completed",
              output_file_id: "file-out",
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                custom_id: "req-1",
                response: {
                  status_code: 400,
                  body: { error: { message: "Bad request" } },
                },
              })
            ),
        }) as unknown as typeof fetch;

      const provider = new OpenAIBatchChatProvider({
        apiKey: "sk-test",
        model: "gpt-4o-mini",
        fetchFn,
        pollIntervalMs: 0,
      });

      const results = await provider.chatBatch([
        { id: "req-1", messages: [{ role: "user", content: "test" }] },
        { id: "req-2", messages: [{ role: "user", content: "test" }] },
      ]);

      expect(results[0].error).toMatch(/status 400/);
      expect(results[0].response).toEqual({});
    });

    it("resumes from existing batch ID (skips upload and create)", async () => {
      const fetchFn = vi
        .fn()
        // Poll -> completed
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              status: "completed",
              output_file_id: "file-out-resume",
            }),
        })
        // Results
        .mockResolvedValueOnce({
          ok: true,
          text: () =>
            Promise.resolve(
              [
                JSON.stringify({
                  custom_id: "req-1",
                  response: {
                    status_code: 200,
                    body: {
                      choices: [{ message: { content: '{"ok": true}' } }],
                      usage: { prompt_tokens: 50, completion_tokens: 10 },
                    },
                  },
                }),
                JSON.stringify({
                  custom_id: "req-2",
                  response: {
                    status_code: 200,
                    body: {
                      choices: [{ message: { content: '{"ok": true}' } }],
                      usage: { prompt_tokens: 50, completion_tokens: 10 },
                    },
                  },
                }),
              ].join("\n")
            ),
        }) as unknown as typeof fetch;

      const provider = new OpenAIBatchChatProvider({
        apiKey: "sk-test",
        model: "gpt-4o-mini",
        fetchFn,
        pollIntervalMs: 0,
      });

      const results = await provider.chatBatch(
        [
          { id: "req-1", messages: [{ role: "user", content: "test" }] },
          { id: "req-2", messages: [{ role: "user", content: "test2" }] },
        ],
        { existingBatchId: "batch-resume-123" }
      );

      expect(results).toHaveLength(2);
      // Only 2 calls: poll + download (no upload/create)
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(fetchFn).toHaveBeenNthCalledWith(
        1,
        "https://api.openai.com/v1/batches/batch-resume-123",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("calls onBatchCreated callback after creating a batch", async () => {
      const onBatchCreated = vi.fn();
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "file-abc" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "batch-cb-test" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              status: "completed",
              output_file_id: "file-out",
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: () =>
            Promise.resolve(
              [
                JSON.stringify({
                  custom_id: "req-1",
                  response: {
                    status_code: 200,
                    body: {
                      choices: [{ message: { content: '{"ok": true}' } }],
                      usage: { prompt_tokens: 10, completion_tokens: 5 },
                    },
                  },
                }),
                JSON.stringify({
                  custom_id: "req-2",
                  response: {
                    status_code: 200,
                    body: {
                      choices: [{ message: { content: '{"ok": true}' } }],
                      usage: { prompt_tokens: 10, completion_tokens: 5 },
                    },
                  },
                }),
              ].join("\n")
            ),
        }) as unknown as typeof fetch;

      const provider = new OpenAIBatchChatProvider({
        apiKey: "sk-test",
        model: "gpt-4o-mini",
        fetchFn,
        pollIntervalMs: 0,
      });

      await provider.chatBatch(
        [
          { id: "req-1", messages: [{ role: "user", content: "test" }] },
          { id: "req-2", messages: [{ role: "user", content: "test2" }] },
        ],
        { onBatchCreated }
      );

      expect(onBatchCreated).toHaveBeenCalledTimes(1);
      expect(onBatchCreated).toHaveBeenCalledWith("batch-cb-test");
    });

    it("defaults to 24h timeout", () => {
      const provider = new OpenAIBatchChatProvider({
        apiKey: "sk-test",
        model: "gpt-4o-mini",
      });
      expect((provider as any).timeoutMs).toBe(24 * 60 * 60 * 1000);
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/api && bun test src/services/openai-batch-chat-provider.test.ts`
Expected: FAIL — module `./openai-batch-chat-provider.js` not found

**Step 3: Commit**

```bash
git add packages/api/src/services/openai-batch-chat-provider.test.ts
git commit -m "test: add OpenAI batch chat provider tests"
```

---

### Task 4: OpenAI Batch Chat Provider — Implementation

**Files:**
- Create: `packages/api/src/services/openai-batch-chat-provider.ts`

**Step 1: Write the implementation**

Follow the exact same pattern as `openai-batch-embedding-provider.ts` but for chat completions:

```typescript
import type {
  BatchChatOptions,
  BatchChatProvider,
  BatchChatRequest,
  BatchChatResult,
  ChatResult,
  Message,
  TokenUsage,
} from "./llm-provider.js";
import type { Logger } from "../logger.js";
import { createTiktokenEncoder, countTokensTiktoken, type Tiktoken } from "./token-counting.js";

export interface OpenAIBatchChatProviderOptions {
  apiKey: string;
  model: string;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  logger?: Logger;
}

export class OpenAIBatchChatProvider implements BatchChatProvider {
  readonly batch = true as const;
  readonly maxContextTokens = 128_000;

  private apiKey: string;
  private model: string;
  private basePollIntervalMs: number;
  private maxPollIntervalMs: number;
  private timeoutMs: number;
  private fetchFn: typeof fetch;
  private encoder: Tiktoken;
  private logger?: Logger;

  constructor(options: OpenAIBatchChatProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchFn = options.fetchFn ?? fetch;
    this.basePollIntervalMs = options.pollIntervalMs ?? 10_000;
    this.maxPollIntervalMs = options.maxPollIntervalMs ?? 120_000;
    this.timeoutMs = options.timeoutMs ?? 24 * 60 * 60 * 1000;
    this.encoder = createTiktokenEncoder(options.model);
    this.logger = options.logger;
  }

  countTokens(text: string): number {
    return countTokensTiktoken(this.encoder, text);
  }

  async chat(messages: Message[]): Promise<ChatResult> {
    const response = await this.fetchFn(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 8192,
          response_format: { type: "json_object" },
          messages: messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      }
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `OpenAI chat error: ${response.status} ${response.statusText} — ${body}`
      );
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    const raw = data.choices[0].message.content;
    try {
      return {
        response: JSON.parse(raw) as Record<string, unknown>,
        usage: {
          inputTokens: data.usage.prompt_tokens,
          outputTokens: data.usage.completion_tokens,
        },
      };
    } catch {
      throw new Error(`LLM returned invalid JSON: ${raw.slice(0, 200)}`);
    }
  }

  async chatBatch(requests: BatchChatRequest[], options?: BatchChatOptions): Promise<BatchChatResult[]> {
    if (requests.length === 0) return [];

    // Single request: use sync path for efficiency
    if (requests.length === 1 && !options?.existingBatchId) {
      const result = await this.chat(requests[0].messages);
      return [{ id: requests[0].id, response: result.response, usage: result.usage }];
    }

    let batchId: string;

    if (options?.existingBatchId) {
      batchId = options.existingBatchId;
      this.logger?.info("Resuming existing batch", { batchId });
    } else {
      // 1. Build JSONL
      const jsonlLines = requests.map((req) =>
        JSON.stringify({
          custom_id: req.id,
          method: "POST",
          url: "/v1/chat/completions",
          body: {
            model: this.model,
            max_tokens: 8192,
            response_format: { type: "json_object" },
            messages: req.messages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
          },
        })
      );
      const jsonlContent = jsonlLines.join("\n");

      // 2. Upload file
      const formData = new FormData();
      formData.append("purpose", "batch");
      formData.append(
        "file",
        new Blob([jsonlContent], { type: "application/jsonl" }),
        "batch-input.jsonl"
      );

      const uploadRes = await this.fetchFn("https://api.openai.com/v1/files", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: formData,
      });

      if (!uploadRes.ok) {
        throw new Error(
          `OpenAI file upload error: ${uploadRes.status} ${uploadRes.statusText}`
        );
      }

      const uploadData = (await uploadRes.json()) as { id: string };
      const inputFileId = uploadData.id;

      // 3. Create batch
      const createRes = await this.fetchFn("https://api.openai.com/v1/batches", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          input_file_id: inputFileId,
          endpoint: "/v1/chat/completions",
          completion_window: "24h",
        }),
      });

      if (!createRes.ok) {
        throw new Error(
          `OpenAI batch create error: ${createRes.status} ${createRes.statusText}`
        );
      }

      const batchData = (await createRes.json()) as { id: string };
      batchId = batchData.id;
      this.logger?.info("Batch created", { batchId });
      options?.onBatchCreated?.(batchId);
    }

    // 4. Poll until completed
    const deadline = Date.now() + this.timeoutMs;
    const startTime = Date.now();
    let outputFileId: string | null = null;
    let pollCount = 0;
    let consecutiveErrors = 0;

    while (Date.now() < deadline) {
      const pollInterval = Math.min(
        this.basePollIntervalMs * Math.pow(1.5, pollCount),
        this.maxPollIntervalMs
      );
      await this.sleep(pollInterval);
      pollCount++;

      let pollRes: Response;
      try {
        pollRes = await this.fetchFn(
          `https://api.openai.com/v1/batches/${batchId}`,
          {
            method: "GET",
            headers: { Authorization: `Bearer ${this.apiKey}` },
          }
        );
      } catch (err) {
        consecutiveErrors++;
        const errMsg = err instanceof Error ? err.message : String(err);
        if (consecutiveErrors >= 4) {
          throw new Error(`OpenAI batch poll failed after ${consecutiveErrors} consecutive errors: ${errMsg}`);
        }
        this.logger?.warn("Transient poll error (network)", { batchId, consecutiveErrors, error: errMsg });
        continue;
      }

      if (!pollRes.ok) {
        const status = pollRes.status;
        if (status >= 500 && consecutiveErrors < 3) {
          consecutiveErrors++;
          this.logger?.warn("Transient poll error", { batchId, status, consecutiveErrors });
          continue;
        }
        throw new Error(
          `OpenAI batch poll error: ${pollRes.status} ${pollRes.statusText}`
        );
      }

      consecutiveErrors = 0;

      const pollData = (await pollRes.json()) as {
        status: string;
        output_file_id?: string;
        errors?: { data?: Array<{ message?: string }> };
      };

      const elapsedMs = Date.now() - startTime;
      this.logger?.info("Polling batch", { batchId, status: pollData.status, elapsedMs });

      if (pollData.status === "completed") {
        outputFileId = pollData.output_file_id ?? null;
        this.logger?.info("Batch completed", { batchId, elapsedMs });
        break;
      }

      if (
        pollData.status === "failed" ||
        pollData.status === "expired" ||
        pollData.status === "cancelled"
      ) {
        const firstError = pollData.errors?.data?.[0]?.message;
        const detail = firstError ? `: ${firstError}` : "";
        throw new Error(`OpenAI batch ${pollData.status}${detail}`);
      }

      const nextInterval = Math.min(
        this.basePollIntervalMs * Math.pow(1.5, pollCount),
        this.maxPollIntervalMs
      );
      if (Date.now() + nextInterval > deadline) {
        throw new Error(`OpenAI batch timed out after ${this.timeoutMs}ms`);
      }
    }

    if (!outputFileId) {
      throw new Error("OpenAI batch completed but no output_file_id");
    }

    // 5. Download results
    const downloadRes = await this.fetchFn(
      `https://api.openai.com/v1/files/${outputFileId}/content`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}` },
      }
    );

    if (!downloadRes.ok) {
      throw new Error(
        `OpenAI file download error: ${downloadRes.status} ${downloadRes.statusText}`
      );
    }

    const resultsText = await downloadRes.text();
    const resultMap = new Map<string, { response: Record<string, unknown>; usage: TokenUsage; error?: string }>();

    for (const line of resultsText.split("\n")) {
      if (!line.trim()) continue;

      const parsed = JSON.parse(line) as {
        custom_id: string;
        response: {
          status_code: number;
          body: {
            choices?: Array<{ message: { content: string } }>;
            usage?: { prompt_tokens: number; completion_tokens: number };
            error?: { message: string };
          };
        };
      };

      if (parsed.response.status_code !== 200) {
        const errorMsg = parsed.response.body.error?.message ?? `status ${parsed.response.status_code}`;
        this.logger?.warn("Batch item errored", { customId: parsed.custom_id, error: errorMsg });
        resultMap.set(parsed.custom_id, {
          response: {},
          usage: { inputTokens: 0, outputTokens: 0 },
          error: errorMsg,
        });
        continue;
      }

      const raw = parsed.response.body.choices![0].message.content;
      try {
        resultMap.set(parsed.custom_id, {
          response: JSON.parse(raw),
          usage: {
            inputTokens: parsed.response.body.usage?.prompt_tokens ?? 0,
            outputTokens: parsed.response.body.usage?.completion_tokens ?? 0,
          },
        });
      } catch {
        const errorMsg = `Invalid JSON: ${raw.slice(0, 200)}`;
        this.logger?.warn("Batch item returned invalid JSON", { customId: parsed.custom_id });
        resultMap.set(parsed.custom_id, {
          response: {},
          usage: {
            inputTokens: parsed.response.body.usage?.prompt_tokens ?? 0,
            outputTokens: parsed.response.body.usage?.completion_tokens ?? 0,
          },
          error: errorMsg,
        });
      }
    }

    return requests.map((req) => {
      const entry = resultMap.get(req.id);
      if (!entry) {
        return { id: req.id, response: {}, usage: { inputTokens: 0, outputTokens: 0 }, error: "No result returned from batch" };
      }
      return { id: req.id, response: entry.response, usage: entry.usage, error: entry.error };
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
```

**Step 2: Run tests to verify they pass**

Run: `cd packages/api && bun test src/services/openai-batch-chat-provider.test.ts`
Expected: All 9 tests PASS

**Step 3: Commit**

```bash
git add packages/api/src/services/openai-batch-chat-provider.ts
git commit -m "feat: add OpenAI batch chat provider"
```

---

### Task 5: Factory Update — Tests

**Files:**
- Modify: `packages/api/src/services/factory.test.ts`

**Step 1: Add failing tests to existing factory test file**

Add these tests to the existing `createLLMProvider` describe block:

```typescript
it("returns OpenAIChatProvider when provider is openai", () => {
  const factory = new ServiceFactory(
    makeConfig({ llm: { provider: "openai", url: "", model: "gpt-4o-mini", apiKey: "sk-test" } })
  );
  const llm = factory.createLLMProvider();
  expect(llm.constructor.name).toBe("OpenAIChatProvider");
});

it("returns OpenAIBatchChatProvider when provider is openai with batch=true", () => {
  const factory = new ServiceFactory(
    makeConfig({ llm: { provider: "openai", url: "", model: "gpt-4o-mini", apiKey: "sk-test", batch: true } })
  );
  const llm = factory.createLLMProvider();
  expect(llm.constructor.name).toBe("OpenAIBatchChatProvider");
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/api && bun test src/services/factory.test.ts`
Expected: FAIL — `OpenAIChatProvider` not found / wrong constructor name

**Step 3: Commit**

```bash
git add packages/api/src/services/factory.test.ts
git commit -m "test: add factory tests for OpenAI LLM provider"
```

---

### Task 6: Factory Update — Implementation

**Files:**
- Modify: `packages/api/src/services/factory.ts`

**Step 1: Update factory to support OpenAI chat providers**

Add imports at top of `factory.ts`:

```typescript
import { OpenAIChatProvider } from "./openai-chat-provider.js";
import { OpenAIBatchChatProvider } from "./openai-batch-chat-provider.js";
```

In `createLLMProvider()`, add the `"openai"` case before the Ollama fallback:

```typescript
if (this.config.llm.provider === "openai") {
  if (this.config.llm.batch) {
    return new OpenAIBatchChatProvider({
      apiKey: this.config.llm.apiKey,
      model: this.config.llm.model,
      logger: log.child("openai-batch-chat"),
    });
  }
  return new OpenAIChatProvider({
    apiKey: this.config.llm.apiKey,
    model: this.config.llm.model,
  });
}
```

**Step 2: Run tests to verify they pass**

Run: `cd packages/api && bun test src/services/factory.test.ts`
Expected: All tests PASS (existing + new)

**Step 3: Commit**

```bash
git add packages/api/src/services/factory.ts
git commit -m "feat: wire OpenAI chat providers into factory"
```

---

### Task 7: Provider Health Check — Tests

**Files:**
- Create: `packages/api/src/services/provider-health.test.ts`

**Step 1: Write the failing tests**

```typescript
import { checkLLMHealth, checkEmbeddingHealth } from "./provider-health.js";

function mockFetch(ok: boolean, body?: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 401,
    statusText: ok ? "OK" : "Unauthorized",
    json: () => Promise.resolve(body ?? {}),
    text: () => Promise.resolve(JSON.stringify(body ?? {})),
  }) as unknown as typeof fetch;
}

describe("checkLLMHealth", () => {
  it("returns ok:true for a successful OpenAI chat call", async () => {
    const fetchFn = mockFetch(true, {
      choices: [{ message: { content: "hi" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const result = await checkLLMHealth(
      { provider: "openai", apiKey: "sk-test", model: "gpt-4o-mini", url: "" },
      fetchFn
    );
    expect(result.ok).toBe(true);
  });

  it("returns ok:false with error message for failed OpenAI call", async () => {
    const fetchFn = mockFetch(false);
    const result = await checkLLMHealth(
      { provider: "openai", apiKey: "bad-key", model: "gpt-4o-mini", url: "" },
      fetchFn
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("returns ok:true for a successful Anthropic call", async () => {
    const fetchFn = mockFetch(true, {
      content: [{ type: "text", text: "hi" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const result = await checkLLMHealth(
      { provider: "anthropic", apiKey: "sk-test", model: "claude-haiku-4-5-20251001", url: "" },
      fetchFn
    );
    expect(result.ok).toBe(true);
  });

  it("returns ok:true for a successful Ollama call", async () => {
    const fetchFn = mockFetch(true, { models: [] });
    const result = await checkLLMHealth(
      { provider: "ollama", apiKey: "", model: "llama3", url: "http://localhost:11434" },
      fetchFn
    );
    expect(result.ok).toBe(true);
  });

  it("catches thrown errors and returns ok:false", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;
    const result = await checkLLMHealth(
      { provider: "ollama", apiKey: "", model: "llama3", url: "http://localhost:11434" },
      fetchFn
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ECONNREFUSED/);
  });
});

describe("checkEmbeddingHealth", () => {
  it("returns ok:true for a successful OpenAI embedding call", async () => {
    const fetchFn = mockFetch(true, {
      data: [{ index: 0, embedding: [0.1, 0.2] }],
    });
    const result = await checkEmbeddingHealth(
      { provider: "openai", apiKey: "sk-test", model: "text-embedding-3-small", url: "" },
      fetchFn
    );
    expect(result.ok).toBe(true);
  });

  it("returns ok:true for a successful Ollama embedding call", async () => {
    const fetchFn = mockFetch(true, { models: [] });
    const result = await checkEmbeddingHealth(
      { provider: "ollama", apiKey: "", model: "nomic-embed-text", url: "http://localhost:11434" },
      fetchFn
    );
    expect(result.ok).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/api && bun test src/services/provider-health.test.ts`
Expected: FAIL — module `./provider-health.js` not found

**Step 3: Commit**

```bash
git add packages/api/src/services/provider-health.test.ts
git commit -m "test: add provider health check tests"
```

---

### Task 8: Provider Health Check — Implementation

**Files:**
- Create: `packages/api/src/services/provider-health.ts`

**Step 1: Write the implementation**

```typescript
export interface HealthCheckConfig {
  provider: string;
  apiKey: string;
  model: string;
  url: string;
}

export interface HealthCheckResult {
  ok: boolean;
  error?: string;
}

export async function checkLLMHealth(
  config: HealthCheckConfig,
  fetchFn: typeof fetch = fetch
): Promise<HealthCheckResult> {
  try {
    if (config.provider === "openai") {
      const res = await fetchFn("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { ok: false, error: `OpenAI LLM health check failed: ${res.status} ${res.statusText} — ${body}` };
      }
      return { ok: true };
    }

    if (config.provider === "anthropic") {
      const res = await fetchFn("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { ok: false, error: `Anthropic LLM health check failed: ${res.status} ${res.statusText} — ${body}` };
      }
      return { ok: true };
    }

    // Ollama — check connectivity via tags endpoint
    const res = await fetchFn(`${config.url}/api/tags`, { method: "GET" });
    if (!res.ok) {
      return { ok: false, error: `Ollama health check failed: ${res.status} ${res.statusText}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function checkEmbeddingHealth(
  config: HealthCheckConfig,
  fetchFn: typeof fetch = fetch
): Promise<HealthCheckResult> {
  try {
    if (config.provider === "openai") {
      const res = await fetchFn("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          input: "health check",
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { ok: false, error: `OpenAI embedding health check failed: ${res.status} ${res.statusText} — ${body}` };
      }
      return { ok: true };
    }

    // Ollama — same tags endpoint
    const res = await fetchFn(`${config.url}/api/tags`, { method: "GET" });
    if (!res.ok) {
      return { ok: false, error: `Ollama health check failed: ${res.status} ${res.statusText}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

**Step 2: Run tests to verify they pass**

Run: `cd packages/api && bun test src/services/provider-health.test.ts`
Expected: All 6 tests PASS

**Step 3: Commit**

```bash
git add packages/api/src/services/provider-health.ts
git commit -m "feat: add provider health check for OpenAI, Anthropic, and Ollama"
```

---

### Task 9: Run Full Test Suite

**Files:** None (verification only)

**Step 1: Run all tests**

Run: `cd packages/api && bun test`
Expected: All tests PASS, no regressions

**Step 2: If any failures, fix and re-run**

Fix any issues, then re-run. Do not commit until all tests pass.

**Step 3: Commit any fixes**

If there were fixes:
```bash
git add -A && git commit -m "fix: resolve test failures from OpenAI provider integration"
```
