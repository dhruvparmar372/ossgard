import { describe, it, expect, vi } from "vitest";
import { AnthropicBatchProvider } from "./anthropic-batch-provider.js";

function mockFetch(responseBody: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(responseBody),
    text: () => Promise.resolve(JSON.stringify(responseBody)),
  }) as unknown as typeof fetch;
}

describe("AnthropicBatchProvider", () => {
  it("has batch property set to true", () => {
    const provider = new AnthropicBatchProvider({
      apiKey: "sk-test",
      model: "claude-sonnet-4-20250514",
    });
    expect(provider.batch).toBe(true);
  });

  describe("chat (sync fallback)", () => {
    it("returns parsed JSON from response content", async () => {
      const chatResponse = { groups: [{ prIds: [1, 2] }] };
      const fetchFn = mockFetch({
        content: [{ type: "text", text: JSON.stringify(chatResponse) }],
      });
      const provider = new AnthropicBatchProvider({
        apiKey: "sk-test",
        model: "claude-sonnet-4-20250514",
        fetchFn,
      });

      const result = await provider.chat([
        { role: "user", content: "analyze" },
      ]);

      expect(result).toEqual(chatResponse);
    });

    it("sends system as content block array with cache_control", async () => {
      const fetchFn = mockFetch({
        content: [{ type: "text", text: '{"ok": true}' }],
      });
      const provider = new AnthropicBatchProvider({
        apiKey: "sk-test",
        model: "claude-sonnet-4-20250514",
        fetchFn,
      });

      await provider.chat([
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello" },
      ]);

      const callArgs = vi.mocked(fetchFn).mock.calls[0];
      const body = JSON.parse(callArgs[1]!.body as string);

      expect(body.system).toEqual([
        {
          type: "text",
          text: "You are helpful.",
          cache_control: { type: "ephemeral" },
        },
      ]);
    });

    it("throws on non-OK response", async () => {
      const fetchFn = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      }) as unknown as typeof fetch;

      const provider = new AnthropicBatchProvider({
        apiKey: "bad-key",
        model: "claude-sonnet-4-20250514",
        fetchFn,
      });

      await expect(
        provider.chat([{ role: "user", content: "test" }])
      ).rejects.toThrow("Anthropic API error: 401 Unauthorized");
    });
  });

  describe("chatBatch", () => {
    it("returns empty array for empty input", async () => {
      const provider = new AnthropicBatchProvider({
        apiKey: "sk-test",
        model: "claude-sonnet-4-20250514",
      });

      const results = await provider.chatBatch([]);
      expect(results).toEqual([]);
    });

    it("uses sync path for single request", async () => {
      const chatResponse = { result: "ok" };
      const fetchFn = mockFetch({
        content: [{ type: "text", text: JSON.stringify(chatResponse) }],
      });
      const provider = new AnthropicBatchProvider({
        apiKey: "sk-test",
        model: "claude-sonnet-4-20250514",
        fetchFn,
      });

      const results = await provider.chatBatch([
        {
          id: "req-1",
          messages: [{ role: "user", content: "hello" }],
        },
      ]);

      expect(results).toEqual([{ id: "req-1", response: chatResponse }]);
      // Only 1 fetch call (the sync chat call), not 3 (create+poll+results)
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(fetchFn).toHaveBeenCalledWith(
        "https://api.anthropic.com/v1/messages",
        expect.anything()
      );
    });

    it("creates batch, polls, and retrieves results", async () => {
      const fetchFn = vi
        .fn()
        // 1. Create batch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "batch-123" }),
        })
        // 2. Poll -> ended
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({ processing_status: "ended" }),
        })
        // 3. Retrieve results (JSONL)
        .mockResolvedValueOnce({
          ok: true,
          text: () =>
            Promise.resolve(
              [
                JSON.stringify({
                  custom_id: "req-2",
                  result: {
                    type: "succeeded",
                    message: {
                      content: [
                        { type: "text", text: '{"score": 70}' },
                      ],
                    },
                  },
                }),
                JSON.stringify({
                  custom_id: "req-1",
                  result: {
                    type: "succeeded",
                    message: {
                      content: [
                        { type: "text", text: '{"score": 90}' },
                      ],
                    },
                  },
                }),
              ].join("\n")
            ),
        }) as unknown as typeof fetch;

      const provider = new AnthropicBatchProvider({
        apiKey: "sk-test",
        model: "claude-sonnet-4-20250514",
        fetchFn,
        pollIntervalMs: 0,
      });

      const results = await provider.chatBatch([
        {
          id: "req-1",
          messages: [{ role: "user", content: "first" }],
        },
        {
          id: "req-2",
          messages: [{ role: "user", content: "second" }],
        },
      ]);

      // Results returned in input order
      expect(results).toEqual([
        { id: "req-1", response: { score: 90 } },
        { id: "req-2", response: { score: 70 } },
      ]);

      // Verify 3 fetch calls: create, poll, results
      expect(fetchFn).toHaveBeenCalledTimes(3);

      // Create call
      expect(fetchFn).toHaveBeenNthCalledWith(
        1,
        "https://api.anthropic.com/v1/messages/batches",
        expect.objectContaining({ method: "POST" })
      );

      // Poll call
      expect(fetchFn).toHaveBeenNthCalledWith(
        2,
        "https://api.anthropic.com/v1/messages/batches/batch-123",
        expect.objectContaining({ method: "GET" })
      );

      // Results call
      expect(fetchFn).toHaveBeenNthCalledWith(
        3,
        "https://api.anthropic.com/v1/messages/batches/batch-123/results",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("polls multiple times until ended", async () => {
      const fetchFn = vi
        .fn()
        // Create
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "batch-456" }),
        })
        // Poll 1 -> in_progress
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({ processing_status: "in_progress" }),
        })
        // Poll 2 -> ended
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({ processing_status: "ended" }),
        })
        // Results
        .mockResolvedValueOnce({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                custom_id: "req-1",
                result: {
                  type: "succeeded",
                  message: {
                    content: [{ type: "text", text: '{"ok": true}' }],
                  },
                },
              })
            ),
        }) as unknown as typeof fetch;

      const provider = new AnthropicBatchProvider({
        apiKey: "sk-test",
        model: "claude-sonnet-4-20250514",
        fetchFn,
        pollIntervalMs: 0,
      });

      const results = await provider.chatBatch([
        { id: "req-1", messages: [{ role: "user", content: "test" }] },
        { id: "req-2", messages: [{ role: "user", content: "test2" }] },
      ]);

      expect(results[0].response).toEqual({ ok: true });
      // 4 calls: create + 2 polls + results
      expect(fetchFn).toHaveBeenCalledTimes(4);
    });

    it("throws on batch create failure", async () => {
      const fetchFn = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      }) as unknown as typeof fetch;

      const provider = new AnthropicBatchProvider({
        apiKey: "sk-test",
        model: "claude-sonnet-4-20250514",
        fetchFn,
      });

      await expect(
        provider.chatBatch([
          { id: "req-1", messages: [{ role: "user", content: "test" }] },
          { id: "req-2", messages: [{ role: "user", content: "test" }] },
        ])
      ).rejects.toThrow("Anthropic batch create error: 500 Internal Server Error");
    });

    it("throws on errored batch items", async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "batch-err" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({ processing_status: "ended" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                custom_id: "req-1",
                result: {
                  type: "errored",
                  error: { message: "Rate limit exceeded" },
                },
              })
            ),
        }) as unknown as typeof fetch;

      const provider = new AnthropicBatchProvider({
        apiKey: "sk-test",
        model: "claude-sonnet-4-20250514",
        fetchFn,
        pollIntervalMs: 0,
      });

      await expect(
        provider.chatBatch([
          { id: "req-1", messages: [{ role: "user", content: "test" }] },
          { id: "req-2", messages: [{ role: "user", content: "test" }] },
        ])
      ).rejects.toThrow("Anthropic batch item req-1 errored: Rate limit exceeded");
    });

    it("throws on invalid JSON in batch results", async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "batch-bad" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({ processing_status: "ended" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                custom_id: "req-1",
                result: {
                  type: "succeeded",
                  message: {
                    content: [{ type: "text", text: "not json" }],
                  },
                },
              })
            ),
        }) as unknown as typeof fetch;

      const provider = new AnthropicBatchProvider({
        apiKey: "sk-test",
        model: "claude-sonnet-4-20250514",
        fetchFn,
        pollIntervalMs: 0,
      });

      await expect(
        provider.chatBatch([
          { id: "req-1", messages: [{ role: "user", content: "test" }] },
          { id: "req-2", messages: [{ role: "user", content: "test" }] },
        ])
      ).rejects.toThrow("LLM returned invalid JSON for req-1");
    });

    it("includes prompt caching in batch create request", async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "batch-cache" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({ processing_status: "ended" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                custom_id: "req-1",
                result: {
                  type: "succeeded",
                  message: {
                    content: [{ type: "text", text: '{"ok": true}' }],
                  },
                },
              }) +
                "\n" +
                JSON.stringify({
                  custom_id: "req-2",
                  result: {
                    type: "succeeded",
                    message: {
                      content: [{ type: "text", text: '{"ok": true}' }],
                    },
                  },
                })
            ),
        }) as unknown as typeof fetch;

      const provider = new AnthropicBatchProvider({
        apiKey: "sk-test",
        model: "claude-sonnet-4-20250514",
        fetchFn,
        pollIntervalMs: 0,
      });

      await provider.chatBatch([
        {
          id: "req-1",
          messages: [
            { role: "system", content: "You are a reviewer." },
            { role: "user", content: "Review PR 1" },
          ],
        },
        {
          id: "req-2",
          messages: [
            { role: "system", content: "You are a reviewer." },
            { role: "user", content: "Review PR 2" },
          ],
        },
      ]);

      const createCall = vi.mocked(fetchFn).mock.calls[0];
      const body = JSON.parse(createCall[1]!.body as string);

      // Verify system uses cache_control
      expect(body.requests[0].params.system).toEqual([
        {
          type: "text",
          text: "You are a reviewer.",
          cache_control: { type: "ephemeral" },
        },
      ]);
    });
  });
});
