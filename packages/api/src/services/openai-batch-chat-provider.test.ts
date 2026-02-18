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
    const provider = new OpenAIBatchChatProvider({ apiKey: "sk-test", model: "gpt-4o-mini" });
    expect(provider.maxContextTokens).toBe(128_000);
  });

  it("counts tokens via tiktoken", () => {
    const provider = new OpenAIBatchChatProvider({ apiKey: "sk-test", model: "gpt-4o-mini" });
    const tokens = provider.countTokens("hello world");
    expect(tokens).toBeGreaterThan(0);
  });

  it("has batch property set to true", () => {
    const provider = new OpenAIBatchChatProvider({ apiKey: "sk-test", model: "gpt-4o-mini" });
    expect(provider.batch).toBe(true);
  });

  describe("chat (sync fallback)", () => {
    it("returns ChatResult with parsed JSON and token usage", async () => {
      const chatResponse = { groups: [{ prIds: [1, 2] }] };
      const fetchFn = mockFetch({
        choices: [{ message: { content: JSON.stringify(chatResponse) } }],
        usage: { prompt_tokens: 200, completion_tokens: 80 },
      });
      const provider = new OpenAIBatchChatProvider({ apiKey: "sk-test", model: "gpt-4o-mini", fetchFn });

      const result = await provider.chat([{ role: "user", content: "analyze" }]);

      expect(result.response).toEqual(chatResponse);
      expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 80 });
    });

    it("throws on non-OK response", async () => {
      const fetchFn = vi.fn().mockResolvedValue({
        ok: false, status: 401, statusText: "Unauthorized",
        text: () => Promise.resolve("bad key"),
      }) as unknown as typeof fetch;
      const provider = new OpenAIBatchChatProvider({ apiKey: "bad-key", model: "gpt-4o-mini", fetchFn });

      await expect(provider.chat([{ role: "user", content: "test" }]))
        .rejects.toThrow("OpenAI chat error: 401 Unauthorized");
    });
  });

  describe("chatBatch", () => {
    it("returns empty array for empty input", async () => {
      const provider = new OpenAIBatchChatProvider({ apiKey: "sk-test", model: "gpt-4o-mini" });
      const results = await provider.chatBatch([]);
      expect(results).toEqual([]);
    });

    it("uses sync path for single request", async () => {
      const chatResponse = { result: "ok" };
      const fetchFn = mockFetch({
        choices: [{ message: { content: JSON.stringify(chatResponse) } }],
        usage: { prompt_tokens: 50, completion_tokens: 20 },
      });
      const provider = new OpenAIBatchChatProvider({ apiKey: "sk-test", model: "gpt-4o-mini", fetchFn });

      const results = await provider.chatBatch([
        { id: "req-1", messages: [{ role: "user", content: "hello" }] },
      ]);

      expect(results).toEqual([
        { id: "req-1", response: chatResponse, usage: { inputTokens: 50, outputTokens: 20 } },
      ]);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(fetchFn).toHaveBeenCalledWith("https://api.openai.com/v1/chat/completions", expect.anything());
    });

    it("uploads file, creates batch, polls, and retrieves results", async () => {
      const fetchFn = vi.fn()
        // 1. Upload file
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: "file-abc123" }) })
        // 2. Create batch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: "batch-xyz" }) })
        // 3. Poll -> completed
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: "completed", output_file_id: "file-out-456" }) })
        // 4. Download results
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(
            [
              JSON.stringify({ custom_id: "req-2", response: { status_code: 200, body: { choices: [{ message: { content: '{"score": 70}' } }], usage: { prompt_tokens: 120, completion_tokens: 30 } } } }),
              JSON.stringify({ custom_id: "req-1", response: { status_code: 200, body: { choices: [{ message: { content: '{"score": 90}' } }], usage: { prompt_tokens: 110, completion_tokens: 25 } } } }),
            ].join("\n")
          ),
        }) as unknown as typeof fetch;

      const provider = new OpenAIBatchChatProvider({ apiKey: "sk-test", model: "gpt-4o-mini", fetchFn, pollIntervalMs: 0 });

      const results = await provider.chatBatch([
        { id: "req-1", messages: [{ role: "user", content: "first" }] },
        { id: "req-2", messages: [{ role: "user", content: "second" }] },
      ]);

      expect(results).toEqual([
        { id: "req-1", response: { score: 90 }, usage: { inputTokens: 110, outputTokens: 25 } },
        { id: "req-2", response: { score: 70 }, usage: { inputTokens: 120, outputTokens: 30 } },
      ]);
      expect(fetchFn).toHaveBeenCalledTimes(4);
      expect(fetchFn).toHaveBeenNthCalledWith(1, "https://api.openai.com/v1/files", expect.objectContaining({ method: "POST" }));
      expect(fetchFn).toHaveBeenNthCalledWith(2, "https://api.openai.com/v1/batches", expect.objectContaining({ method: "POST" }));
      expect(fetchFn).toHaveBeenNthCalledWith(3, "https://api.openai.com/v1/batches/batch-xyz", expect.objectContaining({ method: "GET" }));
      expect(fetchFn).toHaveBeenNthCalledWith(4, "https://api.openai.com/v1/files/file-out-456/content", expect.objectContaining({ method: "GET" }));
    });

    it("throws on batch create failure", async () => {
      const fetchFn = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: "file-abc" }) })
        .mockResolvedValueOnce({ ok: false, status: 500, statusText: "Internal Server Error" }) as unknown as typeof fetch;
      const provider = new OpenAIBatchChatProvider({ apiKey: "sk-test", model: "gpt-4o-mini", fetchFn });

      await expect(provider.chatBatch([
        { id: "req-1", messages: [{ role: "user", content: "test" }] },
        { id: "req-2", messages: [{ role: "user", content: "test" }] },
      ])).rejects.toThrow("OpenAI batch create error: 500 Internal Server Error");
    });

    it("handles per-item errors in batch results", async () => {
      const fetchFn = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: "file-abc" }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: "batch-err" }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: "completed", output_file_id: "file-out" }) })
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({
            custom_id: "req-1",
            response: { status_code: 400, body: { error: { message: "Bad request" } } },
          })),
        }) as unknown as typeof fetch;
      const provider = new OpenAIBatchChatProvider({ apiKey: "sk-test", model: "gpt-4o-mini", fetchFn, pollIntervalMs: 0 });

      const results = await provider.chatBatch([
        { id: "req-1", messages: [{ role: "user", content: "test" }] },
        { id: "req-2", messages: [{ role: "user", content: "test" }] },
      ]);

      expect(results[0].error).toMatch(/Bad request/);
      expect(results[0].response).toEqual({});
    });

    it("resumes from existing batch ID (skips upload and create)", async () => {
      const fetchFn = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: "completed", output_file_id: "file-out-resume" }) })
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(
            [
              JSON.stringify({ custom_id: "req-1", response: { status_code: 200, body: { choices: [{ message: { content: '{"ok": true}' } }], usage: { prompt_tokens: 50, completion_tokens: 10 } } } }),
              JSON.stringify({ custom_id: "req-2", response: { status_code: 200, body: { choices: [{ message: { content: '{"ok": true}' } }], usage: { prompt_tokens: 50, completion_tokens: 10 } } } }),
            ].join("\n")
          ),
        }) as unknown as typeof fetch;
      const provider = new OpenAIBatchChatProvider({ apiKey: "sk-test", model: "gpt-4o-mini", fetchFn, pollIntervalMs: 0 });

      const results = await provider.chatBatch(
        [
          { id: "req-1", messages: [{ role: "user", content: "test" }] },
          { id: "req-2", messages: [{ role: "user", content: "test2" }] },
        ],
        { existingBatchId: "batch-resume-123" }
      );

      expect(results).toHaveLength(2);
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(fetchFn).toHaveBeenNthCalledWith(1, "https://api.openai.com/v1/batches/batch-resume-123", expect.objectContaining({ method: "GET" }));
    });

    it("calls onBatchCreated callback after creating a batch", async () => {
      const onBatchCreated = vi.fn();
      const fetchFn = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: "file-abc" }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: "batch-cb-test" }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: "completed", output_file_id: "file-out" }) })
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(
            [
              JSON.stringify({ custom_id: "req-1", response: { status_code: 200, body: { choices: [{ message: { content: '{"ok": true}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } } } }),
              JSON.stringify({ custom_id: "req-2", response: { status_code: 200, body: { choices: [{ message: { content: '{"ok": true}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } } } }),
            ].join("\n")
          ),
        }) as unknown as typeof fetch;
      const provider = new OpenAIBatchChatProvider({ apiKey: "sk-test", model: "gpt-4o-mini", fetchFn, pollIntervalMs: 0 });

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
      const provider = new OpenAIBatchChatProvider({ apiKey: "sk-test", model: "gpt-4o-mini" });
      expect((provider as any).timeoutMs).toBe(24 * 60 * 60 * 1000);
    });

    it("tolerates transient 5xx poll errors", async () => {
      const fetchFn = vi
        .fn()
        // Upload file
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "file-abc" }),
        })
        // Create batch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "batch-5xx" }),
        })
        // Poll 1 -> 500 (transient)
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
        })
        // Poll 2 -> completed
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              status: "completed",
              output_file_id: "file-out",
            }),
        })
        // Download results
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

      const results = await provider.chatBatch([
        { id: "req-1", messages: [{ role: "user", content: "test" }] },
        { id: "req-2", messages: [{ role: "user", content: "test2" }] },
      ]);

      expect(results).toHaveLength(2);
      // 5 calls: upload, create, 500-poll, ok-poll, download
      expect(fetchFn).toHaveBeenCalledTimes(5);
    });

    it("throws when batch times out", async () => {
      const fetchFn = vi
        .fn()
        // Upload file
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "file-abc" }),
        })
        // Create batch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "batch-slow" }),
        })
        // Poll -> always in_progress
        .mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({ status: "in_progress" }),
        }) as unknown as typeof fetch;

      const provider = new OpenAIBatchChatProvider({
        apiKey: "sk-test",
        model: "gpt-4o-mini",
        fetchFn,
        pollIntervalMs: 0,
        timeoutMs: 1, // 1ms timeout to trigger quickly
      });

      await expect(
        provider.chatBatch([
          { id: "req-1", messages: [{ role: "user", content: "test" }] },
          { id: "req-2", messages: [{ role: "user", content: "test2" }] },
        ])
      ).rejects.toThrow("OpenAI batch timed out after 1ms");
    });
  });
});
