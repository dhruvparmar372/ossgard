import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import TOML from "@iarna/toml";
import { createApp } from "./app.js";
import { Database } from "./db/database.js";
import { ServiceFactory, type ServiceConfig } from "./services/factory.js";
import { ScanOrchestrator } from "./pipeline/scan-orchestrator.js";
import { IngestProcessor } from "./pipeline/ingest.js";
import { EmbedProcessor } from "./pipeline/embed.js";
import { ClusterProcessor } from "./pipeline/cluster.js";
import { VerifyProcessor } from "./pipeline/verify.js";
import { RankProcessor } from "./pipeline/rank.js";

interface TomlConfig {
  github?: { token?: string };
  llm?: { provider?: string; url?: string; model?: string; api_key?: string; batch?: boolean };
  embedding?: { provider?: string; url?: string; model?: string; api_key?: string; batch?: boolean };
  vector_store?: { url?: string; api_key?: string };
  scan?: {
    code_similarity_threshold?: number;
    intent_similarity_threshold?: number;
  };
}

function loadTomlConfig(): TomlConfig {
  const configPath = process.env.CONFIG_PATH;
  if (!configPath || !existsSync(configPath)) {
    return {};
  }
  try {
    const raw = readFileSync(configPath, "utf-8");
    return TOML.parse(raw) as unknown as TomlConfig;
  } catch {
    console.warn(`Warning: could not parse config at ${configPath}`);
    return {};
  }
}

async function main() {
  const toml = loadTomlConfig();

  const serviceConfig: ServiceConfig = {
    github: {
      token: process.env.GITHUB_TOKEN || toml.github?.token || "",
    },
    llm: {
      provider: toml.llm?.provider || "ollama",
      url: toml.llm?.url || "http://localhost:11434",
      model: toml.llm?.model || "llama3",
      apiKey: toml.llm?.api_key || "",
      batch: toml.llm?.batch || false,
    },
    embedding: {
      provider: toml.embedding?.provider || "ollama",
      url: toml.embedding?.url || "http://localhost:11434",
      model: toml.embedding?.model || "nomic-embed-text",
      apiKey: toml.embedding?.api_key || "",
      batch: toml.embedding?.batch || false,
    },
    vectorStoreUrl: toml.vector_store?.url || "http://localhost:6333",
    vectorStoreApiKey: toml.vector_store?.api_key || "",
  };

  if (!serviceConfig.github.token) {
    console.warn(
      "WARNING: No GITHUB_TOKEN configured. Scans will fail. " +
      "Set GITHUB_TOKEN env var or run 'ossgard init'."
    );
  }

  const factory = new ServiceFactory(serviceConfig);
  const github = factory.createGitHubClient();
  const embeddingLLM = factory.createEmbeddingProvider();
  const chatLLM = factory.createLLMProvider();
  const vectorStore = await factory.createVectorStore();

  const defaultDbDir = join(homedir(), ".ossgard");
  mkdirSync(defaultDbDir, { recursive: true });
  const dbPath = process.env.DATABASE_PATH ?? join(defaultDbDir, "ossgard.db");
  const db = new Database(dbPath);

  const codeSimilarityThreshold =
    toml.scan?.code_similarity_threshold ?? 0.85;
  const intentSimilarityThreshold =
    toml.scan?.intent_similarity_threshold ?? 0.80;

  // Create the Hono app with shared db (empty processors initially)
  const { app, ctx } = createApp(db);

  // Build processors using ctx.queue (the shared queue instance)
  const queue = ctx.queue;
  const processors = [
    new ScanOrchestrator(db, queue),
    new IngestProcessor(db, github, queue),
    new EmbedProcessor(db, embeddingLLM, vectorStore, queue),
    new ClusterProcessor(db, vectorStore, {
      codeSimilarityThreshold,
      intentSimilarityThreshold,
    }, queue),
    new VerifyProcessor(db, chatLLM, queue),
    new RankProcessor(db, chatLLM),
  ];

  // Register processors with the worker
  for (const p of processors) {
    ctx.worker.register(p);
  }

  // When a job permanently fails, mark the associated scan as failed too
  ctx.worker.setOnJobFailed((job, error) => {
    const scanId = (job.payload as Record<string, unknown>).scanId;
    if (typeof scanId === "number") {
      db.updateScanStatus(scanId, "failed", { error });
    }
  });

  const port = Number(process.env.PORT) || 3400;
  const server = Bun.serve({ fetch: app.fetch, port });
  console.log(`ossgard-api listening on http://localhost:${server.port}`);
  ctx.worker.start();
  console.log("Worker loop started");

  const shutdown = () => {
    console.log("Shutting down gracefully...");
    server.stop();
    ctx.worker.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch(console.error);

export { createApp };
