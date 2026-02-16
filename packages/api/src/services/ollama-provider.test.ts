import { OllamaProvider } from "./ollama-provider.js";

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

describe("OllamaProvider", () => {
  describe("dimensions", () => {
    it("returns 768 for nomic-embed-text", () => {
      const provider = new OllamaProvider({
        baseUrl: "http://localhost:11434",
        embeddingModel: "nomic-embed-text",
        chatModel: "llama3",
      });
      expect(provider.dimensions).toBe(768);
    });

    it("returns 1024 for mxbai-embed-large", () => {
      const provider = new OllamaProvider({
        baseUrl: "http://localhost:11434",
        embeddingModel: "mxbai-embed-large",
        chatModel: "llama3",
      });
      expect(provider.dimensions).toBe(1024);
    });

    it("defaults to 768 for unknown models", () => {
      const provider = new OllamaProvider({
        baseUrl: "http://localhost:11434",
        embeddingModel: "unknown-model",
        chatModel: "llama3",
      });
      expect(provider.dimensions).toBe(768);
    });
  });

  describe("embed", () => {
    it("returns embedding vectors", async () => {
      const embeddings = [
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ];
      const fetchFn = mockFetch({ embeddings });
      const provider = new OllamaProvider({
        baseUrl: "http://localhost:11434",
        embeddingModel: "nomic-embed-text",
        chatModel: "llama3",
        fetchFn,
      });

      const result = await provider.embed(["hello", "world"]);

      expect(result).toEqual(embeddings);
    });

    it("calls the correct endpoint with correct body", async () => {
      const fetchFn = mockFetch({ embeddings: [[0.1]] });
      const provider = new OllamaProvider({
        baseUrl: "http://localhost:11434",
        embeddingModel: "nomic-embed-text",
        chatModel: "llama3",
        fetchFn,
      });

      await provider.embed(["test input"]);

      expect(fetchFn).toHaveBeenCalledWith(
        "http://localhost:11434/api/embed",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "nomic-embed-text",
            input: ["test input"],
          }),
        }
      );
    });

    it("throws on non-OK response", async () => {
      const fetchFn = mockFetchError(500, "Internal Server Error");
      const provider = new OllamaProvider({
        baseUrl: "http://localhost:11434",
        embeddingModel: "nomic-embed-text",
        chatModel: "llama3",
        fetchFn,
      });

      await expect(provider.embed(["test"])).rejects.toThrow(
        "Ollama embed error: 500 Internal Server Error"
      );
    });
  });

  describe("chat", () => {
    it("returns parsed JSON from response", async () => {
      const chatResponse = { groups: [{ id: 1, label: "test" }] };
      const fetchFn = mockFetch({
        message: { content: JSON.stringify(chatResponse) },
      });
      const provider = new OllamaProvider({
        baseUrl: "http://localhost:11434",
        embeddingModel: "nomic-embed-text",
        chatModel: "llama3",
        fetchFn,
      });

      const result = await provider.chat([
        { role: "user", content: "analyze this" },
      ]);

      expect(result).toEqual(chatResponse);
    });

    it("calls the correct endpoint with correct body", async () => {
      const fetchFn = mockFetch({
        message: { content: '{"ok": true}' },
      });
      const provider = new OllamaProvider({
        baseUrl: "http://localhost:11434",
        embeddingModel: "nomic-embed-text",
        chatModel: "llama3",
        fetchFn,
      });

      const messages = [
        { role: "system" as const, content: "You are helpful." },
        { role: "user" as const, content: "Hello" },
      ];
      await provider.chat(messages);

      expect(fetchFn).toHaveBeenCalledWith(
        "http://localhost:11434/api/chat",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "llama3",
            messages,
            stream: false,
            format: "json",
            options: { num_ctx: 8192 },
          }),
        }
      );
    });

    it("throws on non-OK response", async () => {
      const fetchFn = mockFetchError(503, "Service Unavailable");
      const provider = new OllamaProvider({
        baseUrl: "http://localhost:11434",
        embeddingModel: "nomic-embed-text",
        chatModel: "llama3",
        fetchFn,
      });

      await expect(
        provider.chat([{ role: "user", content: "test" }])
      ).rejects.toThrow("Ollama chat error: 503 Service Unavailable");
    });

    it("throws descriptive error when LLM returns invalid JSON", async () => {
      const fetchFn = mockFetch({
        message: { content: "not json {broken" },
      });
      const provider = new OllamaProvider({
        baseUrl: "http://localhost:11434",
        embeddingModel: "nomic-embed-text",
        chatModel: "llama3",
        fetchFn,
      });

      await expect(
        provider.chat([{ role: "user", content: "test" }])
      ).rejects.toThrow("LLM returned invalid JSON");
    });
  });
});
