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
