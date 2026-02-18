import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createApp } from "./app.js";
import { Database } from "./db/database.js";
import { ServiceResolver } from "./services/service-resolver.js";
import { ScanOrchestrator } from "./pipeline/scan-orchestrator.js";
import { IngestProcessor } from "./pipeline/ingest.js";
import { EmbedProcessor } from "./pipeline/embed.js";
import { ClusterProcessor } from "./pipeline/cluster.js";
import { VerifyProcessor } from "./pipeline/verify.js";
import { RankProcessor } from "./pipeline/rank.js";
import { DetectProcessor } from "./pipeline/detect.js";
import { log } from "./logger.js";

async function main() {
  const defaultDbDir = join(homedir(), ".ossgard");
  mkdirSync(defaultDbDir, { recursive: true });
  const dbPath = process.env.DATABASE_PATH ?? join(defaultDbDir, "ossgard.db");
  const db = new Database(dbPath);

  const resolver = new ServiceResolver(db);

  // Create the Hono app with shared db (empty processors initially)
  const { app, ctx } = createApp(db);

  // Build processors using ctx.queue (the shared queue instance)
  const queue = ctx.queue;
  const processors = [
    new ScanOrchestrator(db, queue),
    new IngestProcessor(db, resolver, queue),
    new DetectProcessor(db, resolver),
    // Keep legacy processors registered for the LegacyStrategy's internal use
    // and to handle any in-flight jobs from before this change
    new EmbedProcessor(db, resolver, queue),
    new ClusterProcessor(db, resolver, queue),
    new VerifyProcessor(db, resolver, queue),
    new RankProcessor(db, resolver),
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

  // Recover any jobs that were running when the server was last killed
  const recovered = await queue.recoverRunningJobs();
  if (recovered > 0) {
    log.info("Recovered interrupted jobs", { count: recovered });
  }

  const port = Number(process.env.PORT) || 3400;
  const server = Bun.serve({ fetch: app.fetch, port });
  log.info(`Listening on http://localhost:${server.port}`, { logLevel: process.env.LOG_LEVEL ?? "info" });
  ctx.worker.start();
  log.info("Worker loop started");

  const shutdown = () => {
    log.info("Shutting down gracefully...");
    server.stop();
    ctx.worker.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => log.error("Fatal startup error", { error: String(err) }));

export { createApp };
