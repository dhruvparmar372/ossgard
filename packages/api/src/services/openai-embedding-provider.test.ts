import { OpenAIEmbeddingProvider } from "./openai-embedding-provider.js";

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

describe("OpenAIEmbeddingProvider", () => {
  describe("dimensions", () => {
    it("returns 3072 for text-embedding-3-large", () => {
      const provider = new OpenAIEmbeddingProvider({
        apiKey: "sk-test",
        model: "text-embedding-3-large",
      });
      expect(provider.dimensions).toBe(3072);
    });

    it("returns 1536 for text-embedding-3-small", () => {
      const provider = new OpenAIEmbeddingProvider({
        apiKey: "sk-test",
        model: "text-embedding-3-small",
      });
      expect(provider.dimensions).toBe(1536);
    });

    it("defaults to 3072 for unknown models", () => {
      const provider = new OpenAIEmbeddingProvider({
        apiKey: "sk-test",
        model: "unknown-model",
      });
      expect(provider.dimensions).toBe(3072);
    });
  });

  describe("embed", () => {
    it("calls the correct endpoint with correct headers and body", async () => {
      const fetchFn = mockFetch({
        data: [{ index: 0, embedding: [0.1, 0.2] }],
      });
      const provider = new OpenAIEmbeddingProvider({
        apiKey: "sk-my-key",
        model: "text-embedding-3-large",
        fetchFn,
      });

      await provider.embed(["hello"]);

      expect(fetchFn).toHaveBeenCalledWith(
        "https://api.openai.com/v1/embeddings",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer sk-my-key",
          },
          body: JSON.stringify({
            model: "text-embedding-3-large",
            input: ["hello"],
          }),
        }
      );
    });

    it("returns embedding vectors", async () => {
      const fetchFn = mockFetch({
        data: [
          { index: 0, embedding: [0.1, 0.2, 0.3] },
          { index: 1, embedding: [0.4, 0.5, 0.6] },
        ],
      });
      const provider = new OpenAIEmbeddingProvider({
        apiKey: "sk-test",
        model: "text-embedding-3-large",
        fetchFn,
      });

      const result = await provider.embed(["hello", "world"]);

      expect(result).toEqual([
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ]);
    });

    it("sorts response by index to guarantee input order", async () => {
      const fetchFn = mockFetch({
        data: [
          { index: 2, embedding: [0.7, 0.8] },
          { index: 0, embedding: [0.1, 0.2] },
          { index: 1, embedding: [0.4, 0.5] },
        ],
      });
      const provider = new OpenAIEmbeddingProvider({
        apiKey: "sk-test",
        model: "text-embedding-3-large",
        fetchFn,
      });

      const result = await provider.embed(["a", "b", "c"]);

      expect(result).toEqual([
        [0.1, 0.2],
        [0.4, 0.5],
        [0.7, 0.8],
      ]);
    });

    it("throws on non-OK response", async () => {
      const fetchFn = mockFetchError(401, "Unauthorized");
      const provider = new OpenAIEmbeddingProvider({
        apiKey: "bad-key",
        model: "text-embedding-3-large",
        fetchFn,
      });

      await expect(provider.embed(["test"])).rejects.toThrow(
        "OpenAI embedding error: 401 Unauthorized"
      );
    });

    it("throws on rate limit error", async () => {
      const fetchFn = mockFetchError(429, "Too Many Requests");
      const provider = new OpenAIEmbeddingProvider({
        apiKey: "sk-test",
        model: "text-embedding-3-large",
        fetchFn,
      });

      await expect(provider.embed(["test"])).rejects.toThrow(
        "OpenAI embedding error: 429 Too Many Requests"
      );
    });
  });
});
