import { AnthropicProvider } from "./anthropic-provider.js";

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
  }) as unknown as typeof fetch;
}

describe("AnthropicProvider", () => {
  describe("chat", () => {
    it("returns ChatResult with parsed JSON and token usage", async () => {
      const chatResponse = {
        groups: [{ prIds: [1, 2], label: "duplicate" }],
      };
      const fetchFn = mockFetch({
        content: [{ type: "text", text: JSON.stringify(chatResponse) }],
        usage: { input_tokens: 100, output_tokens: 50 },
      });
      const provider = new AnthropicProvider({
        apiKey: "sk-test-key",
        model: "claude-sonnet-4-20250514",
        fetchFn,
      });

      const result = await provider.chat([
        { role: "user", content: "analyze this" },
      ]);

      expect(result.response).toEqual(chatResponse);
      expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    });

    it("sends correct headers including x-api-key, anthropic-version, and prompt caching beta", async () => {
      const fetchFn = mockFetch({
        content: [{ type: "text", text: '{"ok": true}' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      const provider = new AnthropicProvider({
        apiKey: "sk-my-secret-key",
        model: "claude-sonnet-4-20250514",
        fetchFn,
      });

      await provider.chat([{ role: "user", content: "hello" }]);

      expect(fetchFn).toHaveBeenCalledWith(
        "https://api.anthropic.com/v1/messages",
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": "sk-my-secret-key",
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "prompt-caching-2024-07-31",
          },
        })
      );
    });

    it("extracts system message and sends it separately", async () => {
      const fetchFn = mockFetch({
        content: [{ type: "text", text: '{"result": "ok"}' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      const provider = new AnthropicProvider({
        apiKey: "sk-test-key",
        model: "claude-sonnet-4-20250514",
        fetchFn,
      });

      await provider.chat([
        { role: "system", content: "You are a code reviewer." },
        { role: "user", content: "Review this PR." },
      ]);

      const callArgs = (fetchFn as any).mock.calls[0];
      const body = JSON.parse(callArgs[1]!.body as string);

      expect(body.system).toEqual([
        {
          type: "text",
          text: "You are a code reviewer.",
          cache_control: { type: "ephemeral" },
        },
      ]);
      expect(body.messages).toEqual([
        { role: "user", content: "Review this PR." },
      ]);
      expect(body.messages).not.toContainEqual(
        expect.objectContaining({ role: "system" })
      );
    });

    it("does not include system field when no system message", async () => {
      const fetchFn = mockFetch({
        content: [{ type: "text", text: '{"result": "ok"}' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      const provider = new AnthropicProvider({
        apiKey: "sk-test-key",
        model: "claude-sonnet-4-20250514",
        fetchFn,
      });

      await provider.chat([{ role: "user", content: "Hello" }]);

      const callArgs = (fetchFn as any).mock.calls[0];
      const body = JSON.parse(callArgs[1]!.body as string);

      expect(body.system).toBeUndefined();
    });

    it("sends the correct model in the body", async () => {
      const fetchFn = mockFetch({
        content: [{ type: "text", text: '{"ok": true}' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      const provider = new AnthropicProvider({
        apiKey: "sk-test-key",
        model: "claude-sonnet-4-20250514",
        fetchFn,
      });

      await provider.chat([{ role: "user", content: "test" }]);

      const callArgs = (fetchFn as any).mock.calls[0];
      const body = JSON.parse(callArgs[1]!.body as string);

      expect(body.model).toBe("claude-sonnet-4-20250514");
    });

    it("throws on non-OK response", async () => {
      const fetchFn = mockFetchError(401, "Unauthorized");
      const provider = new AnthropicProvider({
        apiKey: "bad-key",
        model: "claude-sonnet-4-20250514",
        fetchFn,
      });

      await expect(
        provider.chat([{ role: "user", content: "test" }])
      ).rejects.toThrow("Anthropic API error: 401 Unauthorized");
    });

    it("throws descriptive error when LLM returns invalid JSON", async () => {
      const fetchFn = mockFetch({
        content: [{ type: "text", text: "not json" }],
      });
      const provider = new AnthropicProvider({
        apiKey: "sk-test-key",
        model: "claude-sonnet-4-20250514",
        fetchFn,
      });

      await expect(
        provider.chat([{ role: "user", content: "test" }])
      ).rejects.toThrow("LLM returned invalid JSON");
    });
  });
});
