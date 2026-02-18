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

    it("throws when choices array is empty", async () => {
      const fetchFn = mockFetch({
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
      const provider = new OpenAIChatProvider({
        apiKey: "sk-test-key",
        model: "gpt-4o-mini",
        fetchFn,
      });

      await expect(
        provider.chat([{ role: "user", content: "test" }])
      ).rejects.toThrow("OpenAI chat returned no content in choices");
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
