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
          max_completion_tokens: 1,
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
