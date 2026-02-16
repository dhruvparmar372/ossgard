import { describe, it, expect, vi } from "vitest";
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
    it("returns parsed JSON from response content", async () => {
      const chatResponse = {
        groups: [{ prIds: [1, 2], label: "duplicate" }],
      };
      const fetchFn = mockFetch({
        content: [{ type: "text", text: JSON.stringify(chatResponse) }],
      });
      const provider = new AnthropicProvider({
        apiKey: "sk-test-key",
        model: "claude-sonnet-4-20250514",
        fetchFn,
      });

      const result = await provider.chat([
        { role: "user", content: "analyze this" },
      ]);

      expect(result).toEqual(chatResponse);
    });

    it("sends correct headers including x-api-key and anthropic-version", async () => {
      const fetchFn = mockFetch({
        content: [{ type: "text", text: '{"ok": true}' }],
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
          },
        })
      );
    });

    it("extracts system message and sends it separately", async () => {
      const fetchFn = mockFetch({
        content: [{ type: "text", text: '{"result": "ok"}' }],
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

      const callArgs = vi.mocked(fetchFn).mock.calls[0];
      const body = JSON.parse(callArgs[1]!.body as string);

      expect(body.system).toBe("You are a code reviewer.");
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
      });
      const provider = new AnthropicProvider({
        apiKey: "sk-test-key",
        model: "claude-sonnet-4-20250514",
        fetchFn,
      });

      await provider.chat([{ role: "user", content: "Hello" }]);

      const callArgs = vi.mocked(fetchFn).mock.calls[0];
      const body = JSON.parse(callArgs[1]!.body as string);

      expect(body.system).toBeUndefined();
    });

    it("sends the correct model in the body", async () => {
      const fetchFn = mockFetch({
        content: [{ type: "text", text: '{"ok": true}' }],
      });
      const provider = new AnthropicProvider({
        apiKey: "sk-test-key",
        model: "claude-sonnet-4-20250514",
        fetchFn,
      });

      await provider.chat([{ role: "user", content: "test" }]);

      const callArgs = vi.mocked(fetchFn).mock.calls[0];
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
