import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { RegisterAccountRequest, PatchAccountConfig, AccountConfigSchema } from "@ossgard/shared";
import type { AccountConfig } from "@ossgard/shared";
import type { AppEnv } from "../app.js";
import { authMiddleware } from "../middleware/auth.js";
import { validateGitHubToken, checkOllamaHealth, checkQdrantHealth } from "../services/validators.js";
import { log } from "../logger.js";

function redactConfig(config: AccountConfig): Record<string, unknown> {
  const redact = (val: string) => (val.length > 4 ? "****" + val.slice(-4) : "****");
  return {
    github: { token: redact(config.github.token) },
    llm: { ...config.llm, api_key: config.llm.api_key ? redact(config.llm.api_key) : "" },
    embedding: { ...config.embedding, api_key: config.embedding.api_key ? redact(config.embedding.api_key) : "" },
    vector_store: { ...config.vector_store, api_key: config.vector_store.api_key ? redact(config.vector_store.api_key) : "" },
    scan: config.scan,
  };
}

const accountsLog = log.child("accounts");

const accounts = new Hono<AppEnv>();

// POST /accounts — unauthenticated registration
accounts.post("/accounts", async (c) => {
  const db = c.get("db");
  const body = await c.req.json();

  const parsed = RegisterAccountRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const { label, config } = parsed.data;
  const warnings: string[] = [];

  // Validate GitHub token (required)
  const gh = await validateGitHubToken(config.github.token);
  if (!gh.valid) {
    return c.json({ error: `Invalid GitHub token: ${gh.error}` }, 400);
  }

  // Check LLM provider (warning only)
  if (config.llm.provider === "ollama" && config.llm.url) {
    const ollama = await checkOllamaHealth(config.llm.url);
    if (!ollama.reachable) {
      warnings.push(`LLM provider (Ollama) not reachable at ${config.llm.url}`);
    }
  }

  // Check embedding provider (warning only)
  if (config.embedding.provider === "ollama" && config.embedding.url) {
    const ollama = await checkOllamaHealth(config.embedding.url);
    if (!ollama.reachable) {
      warnings.push(`Embedding provider (Ollama) not reachable at ${config.embedding.url}`);
    }
  }

  // Check Qdrant (warning only)
  const qdrant = await checkQdrantHealth(config.vector_store.url);
  if (!qdrant.reachable) {
    warnings.push(`Qdrant not reachable at ${config.vector_store.url}`);
  }

  const apiKey = uuidv4();
  db.createAccount(apiKey, label ?? null, config);

  accountsLog.info("Account registered", { label: label ?? "" });
  if (warnings.length > 0) {
    accountsLog.warn("Registration warnings", { warnings });
  }

  return c.json({ apiKey, warnings }, 201);
});

// GET /accounts/me — authenticated
accounts.get("/accounts/me", authMiddleware, (c) => {
  const account = c.get("account");
  return c.json({
    id: account.id,
    label: account.label,
    config: redactConfig(account.config),
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  });
});

// PUT /accounts/me — authenticated
accounts.put("/accounts/me", authMiddleware, async (c) => {
  const db = c.get("db");
  const account = c.get("account");
  const body = await c.req.json();

  const parsed = RegisterAccountRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const { config } = parsed.data;
  const warnings: string[] = [];

  // Validate GitHub token (required)
  const gh = await validateGitHubToken(config.github.token);
  if (!gh.valid) {
    return c.json({ error: `Invalid GitHub token: ${gh.error}` }, 400);
  }

  // Check LLM provider (warning only)
  if (config.llm.provider === "ollama" && config.llm.url) {
    const ollama = await checkOllamaHealth(config.llm.url);
    if (!ollama.reachable) {
      warnings.push(`LLM provider (Ollama) not reachable at ${config.llm.url}`);
    }
  }

  // Check embedding provider (warning only)
  if (config.embedding.provider === "ollama" && config.embedding.url) {
    const ollama = await checkOllamaHealth(config.embedding.url);
    if (!ollama.reachable) {
      warnings.push(`Embedding provider (Ollama) not reachable at ${config.embedding.url}`);
    }
  }

  // Check Qdrant (warning only)
  const qdrant = await checkQdrantHealth(config.vector_store.url);
  if (!qdrant.reachable) {
    warnings.push(`Qdrant not reachable at ${config.vector_store.url}`);
  }

  db.updateAccountConfig(account.id, config);

  return c.json({ updated: true, warnings });
});

// PATCH /accounts/me — authenticated, partial config update
accounts.patch("/accounts/me", authMiddleware, async (c) => {
  const db = c.get("db");
  const account = c.get("account");
  const body = await c.req.json();

  const parsed = PatchAccountConfig.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  // Deep-merge patch into existing config
  const existing = account.config;
  const patch = parsed.data.config;
  const merged: Record<string, unknown> = {};

  for (const section of ["github", "llm", "embedding", "vector_store", "scan"] as const) {
    const existingSection = (existing as unknown as Record<string, Record<string, unknown>>)[section];
    const patchSection = (patch as unknown as Record<string, Record<string, unknown> | undefined>)[section];
    if (patchSection) {
      merged[section] = { ...existingSection, ...patchSection };
    } else if (existingSection) {
      merged[section] = existingSection;
    }
  }

  // Validate merged result against full schema
  const validated = AccountConfigSchema.safeParse(merged);
  if (!validated.success) {
    return c.json({ error: validated.error.flatten() }, 400);
  }

  const config = validated.data as AccountConfig;
  const warnings: string[] = [];

  // Validate GitHub token if it changed
  if (patch.github?.token) {
    const gh = await validateGitHubToken(config.github.token);
    if (!gh.valid) {
      return c.json({ error: `Invalid GitHub token: ${gh.error}` }, 400);
    }
  }

  // Check LLM provider (warning only)
  if (config.llm.provider === "ollama" && config.llm.url) {
    const ollama = await checkOllamaHealth(config.llm.url);
    if (!ollama.reachable) {
      warnings.push(`LLM provider (Ollama) not reachable at ${config.llm.url}`);
    }
  }

  // Check embedding provider (warning only)
  if (config.embedding.provider === "ollama" && config.embedding.url) {
    const ollama = await checkOllamaHealth(config.embedding.url);
    if (!ollama.reachable) {
      warnings.push(`Embedding provider (Ollama) not reachable at ${config.embedding.url}`);
    }
  }

  // Check Qdrant (warning only)
  if (patch.vector_store?.url) {
    const qdrant = await checkQdrantHealth(config.vector_store.url);
    if (!qdrant.reachable) {
      warnings.push(`Qdrant not reachable at ${config.vector_store.url}`);
    }
  }

  db.updateAccountConfig(account.id, config);

  return c.json({ updated: true, warnings });
});

export { accounts };
