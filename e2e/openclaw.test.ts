/**
 * E2E Test: openclaw/openclaw
 *
 * Runs the full ossgard pipeline against the real openclaw/openclaw GitHub repo
 * with maxPrs=10 to stay within unauthenticated rate limits (60 req/hr).
 *
 * Prerequisites:
 *   docker compose up -d qdrant ollama
 *   docker compose exec ollama ollama pull nomic-embed-text
 *   docker compose exec ollama ollama pull llama3
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Scan } from "@ossgard/shared";

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const MAX_PRS = 100;

// Helper: check if a service is reachable
async function isReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

// Helper: check if Ollama has a specific model pulled
async function hasModel(model: string): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { models: Array<{ name: string }> };
    return data.models.some((m) => m.name.startsWith(model));
  } catch {
    return false;
  }
}

// Helper: poll scan status until terminal state or timeout
async function pollScan(
  appRequest: (path: string, init?: RequestInit) => Promise<Response>,
  scanId: number,
  timeoutMs: number
): Promise<Scan> {
  const deadline = Date.now() + timeoutMs;
  const terminalStates = new Set(["done", "failed"]);

  let lastStatus = "";
  while (Date.now() < deadline) {
    const res = await appRequest(`/scans/${scanId}`);
    const scan = (await res.json()) as Scan;
    if (scan.status !== lastStatus) {
      const elapsed = ((Date.now() - (deadline - timeoutMs)) / 1000).toFixed(0);
      console.log(`[${elapsed}s] scan ${scanId}: ${scan.status} (prCount=${scan.prCount})`);
      lastStatus = scan.status;
    }
    if (terminalStates.has(scan.status)) {
      return scan;
    }
    // Poll every 2 seconds
    await new Promise((r) => setTimeout(r, 2000));
  }

  // One final check
  const res = await appRequest(`/scans/${scanId}`);
  return (await res.json()) as Scan;
}

describe("E2E: openclaw/openclaw", () => {
  let appRequest: (path: string, init?: RequestInit) => Promise<Response>;
  let cleanup: (() => void) | undefined;
  let skipReason: string | null = null;

  beforeAll(async () => {
    // Check prerequisites
    const [qdrantUp, ollamaUp] = await Promise.all([
      isReachable(`${QDRANT_URL}/collections`),
      isReachable(`${OLLAMA_URL}/api/tags`),
    ]);

    if (!qdrantUp || !ollamaUp) {
      skipReason = `Infrastructure not available (qdrant: ${qdrantUp}, ollama: ${ollamaUp})`;
      return;
    }

    const [hasEmbed, hasChat] = await Promise.all([
      hasModel("nomic-embed-text"),
      hasModel("llama3"),
    ]);

    if (!hasEmbed || !hasChat) {
      skipReason = `Models not pulled (nomic-embed-text: ${hasEmbed}, llama3: ${hasChat})`;
      return;
    }

    // Wire up in-process Hono app with real services
    const { createApp } = await import("../packages/api/src/app.js");
    const { Database } = await import("../packages/api/src/db/database.js");
    const { ServiceFactory } = await import(
      "../packages/api/src/services/factory.js"
    );
    const { ScanOrchestrator } = await import(
      "../packages/api/src/pipeline/scan-orchestrator.js"
    );
    const { IngestProcessor } = await import(
      "../packages/api/src/pipeline/ingest.js"
    );
    const { EmbedProcessor } = await import(
      "../packages/api/src/pipeline/embed.js"
    );
    const { ClusterProcessor } = await import(
      "../packages/api/src/pipeline/cluster.js"
    );
    const { VerifyProcessor } = await import(
      "../packages/api/src/pipeline/verify.js"
    );
    const { RankProcessor } = await import(
      "../packages/api/src/pipeline/rank.js"
    );

    const db = new Database(":memory:");

    const { GitHubClient } = await import(
      "../packages/api/src/services/github-client.js"
    );
    const { Config } = await import("../packages/cli/src/config.js");

    // Load token: env var takes precedence, then ~/.ossgard/config.toml
    const configToken = new Config().get("github.token") as string | undefined;
    const githubToken = process.env.GITHUB_TOKEN || configToken || "";

    const factory = new ServiceFactory({
      github: { token: githubToken },
      llm: { provider: "ollama", model: "llama3", apiKey: "" },
      embedding: { provider: "ollama", model: "nomic-embed-text", apiKey: "" },
      ollamaUrl: OLLAMA_URL,
      qdrantUrl: QDRANT_URL,
    });

    // Create GitHub client directly with rateLimitBuffer: 0 to avoid
    // proactive throttling for unauthenticated access (60 req/hr, we need ~21)
    const github = new GitHubClient({
      token: githubToken,
      rateLimitBuffer: 0,
    });
    const embeddingLLM = factory.createEmbeddingProvider();
    const chatLLM = factory.createLLMProvider();
    const vectorStore = await factory.createVectorStore();

    const { app, ctx } = createApp(db);
    const queue = ctx.queue;

    const processors = [
      new ScanOrchestrator(db, queue),
      new IngestProcessor(db, github, queue),
      new EmbedProcessor(db, embeddingLLM, vectorStore, queue),
      new ClusterProcessor(
        db,
        vectorStore,
        { codeSimilarityThreshold: 0.85, intentSimilarityThreshold: 0.8 },
        queue
      ),
      new VerifyProcessor(db, chatLLM, queue),
      new RankProcessor(db, chatLLM),
    ];

    for (const p of processors) {
      ctx.worker.register(p);
    }

    ctx.worker.setOnJobFailed((job, error) => {
      const scanId = (job.payload as Record<string, unknown>).scanId;
      if (typeof scanId === "number") {
        db.updateScanStatus(scanId, "failed", { error });
      }
    });

    // Start the worker loop (fast polling for E2E)
    ctx.worker.start();

    appRequest = (path, init) => app.request(path, init);
    cleanup = () => {
      ctx.worker.stop();
      db.close();
    };
  }, 60_000); // 60s hook timeout for model loading

  afterAll(() => {
    cleanup?.();
  });

  it(
    "scans openclaw/openclaw with maxPrs=100 through the full pipeline",
    async () => {
      if (skipReason) {
        console.log(`SKIPPED: ${skipReason}`);
        return;
      }

      // 1. Track the repo
      const trackRes = await appRequest("/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "openclaw", name: "openclaw" }),
      });
      expect(trackRes.status).toBe(201);

      // 2. Trigger scan with maxPrs=10
      const scanRes = await appRequest("/repos/openclaw/openclaw/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxPrs: MAX_PRS }),
      });
      expect(scanRes.status).toBe(202);
      const { scanId } = (await scanRes.json()) as { scanId: number };

      // 3. Poll until done or failed (30 min timeout for 100 PRs)
      const scan = await pollScan(appRequest, scanId, 30 * 60 * 1000);

      // 4. Assert scan completed successfully
      if (scan.status === "failed") {
        console.error(`Scan failed: ${scan.error}`);
        console.error(`Scan state:`, JSON.stringify(scan, null, 2));
        if (scan.error?.includes("rate limit")) {
          console.log(`SKIPPED: GitHub rate limit exceeded. Wait for reset and re-run.`);
          return;
        }
      }
      expect(scan.status).toBe("done");
      expect(scan.prCount).toBe(MAX_PRS);

      // 5. Check dupes endpoint structure
      const dupesRes = await appRequest("/repos/openclaw/openclaw/dupes");
      expect(dupesRes.status).toBe(200);
      const dupesBody = (await dupesRes.json()) as {
        repo: string;
        scanId: number;
        groupCount: number;
        groups: Array<{
          groupId: number;
          label: string;
          prCount: number;
          members: Array<{
            prId: number;
            prNumber: number;
            title: string;
            author: string;
            rank: number;
            score: number;
            rationale: string;
          }>;
        }>;
      };

      expect(dupesBody.repo).toBe("openclaw/openclaw");
      expect(dupesBody.scanId).toBe(scanId);
      expect(typeof dupesBody.groupCount).toBe("number");

      // Validate structure of each group (if any dupes found)
      for (const group of dupesBody.groups) {
        expect(group.groupId).toBeGreaterThan(0);
        expect(typeof group.label).toBe("string");
        expect(group.prCount).toBeGreaterThanOrEqual(2);

        // Members may be fewer than prCount if LLM returned mismatched PR numbers
        for (const member of group.members) {
          expect(member.prNumber).toBeGreaterThan(0);
          expect(typeof member.title).toBe("string");
          expect(typeof member.author).toBe("string");
          expect(typeof member.score).toBe("number");
          expect(typeof member.rationale).toBe("string");
        }
      }

      // 6. Save results to .data directory
      const dataDir = join(import.meta.dirname, "..", ".data");
      mkdirSync(dataDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const resultFile = join(dataDir, `openclaw-${MAX_PRS}prs-${timestamp}.json`);

      writeFileSync(
        resultFile,
        JSON.stringify(
          {
            scan: {
              id: scan.id,
              status: scan.status,
              prCount: scan.prCount,
              dupeGroupCount: scan.dupeGroupCount,
              startedAt: scan.startedAt,
              completedAt: scan.completedAt,
            },
            dupes: dupesBody,
          },
          null,
          2
        )
      );

      console.log(`Results saved to ${resultFile}`);
      console.log(`  PRs scanned: ${scan.prCount}`);
      console.log(`  Dupe groups: ${dupesBody.groupCount}`);
    },
    35 * 60 * 1000 // 35-minute test timeout
  );
});
