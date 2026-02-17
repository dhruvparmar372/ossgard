import { Hono } from "hono";
import type { Account } from "@ossgard/shared";
import { Database } from "./db/database.js";
import { LocalJobQueue } from "./queue/local-job-queue.js";
import { WorkerLoop } from "./queue/worker.js";
import type { JobProcessor } from "./queue/worker.js";
import { authMiddleware } from "./middleware/auth.js";
import { health } from "./routes/health.js";
import { accounts } from "./routes/accounts.js";
import { repos } from "./routes/repos.js";
import { scans } from "./routes/scans.js";
import { dupes } from "./routes/dupes.js";
import { reset } from "./routes/reset.js";
import { log } from "./logger.js";

export type AppEnv = {
  Variables: {
    db: Database;
    queue: LocalJobQueue;
    account: Account;
  };
};

export interface AppContext {
  db: Database;
  queue: LocalJobQueue;
  worker: WorkerLoop;
}

export function createApp(
  db?: Database,
  processors: JobProcessor[] = []
): { app: Hono<AppEnv>; ctx: AppContext } {
  const database = db ?? new Database(process.env.DATABASE_PATH ?? ":memory:");
  const queue = new LocalJobQueue(database.raw);
  const worker = new WorkerLoop(queue, processors);

  const app = new Hono<AppEnv>();
  const httpLog = log.child("http");

  // Request logging
  app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    const line = `← ${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms`;
    if (c.req.path === "/health") {
      httpLog.debug(line);
    } else {
      httpLog.info(line);
    }
  });

  // Inject database and queue into context
  app.use("*", async (c, next) => {
    c.set("db", database);
    c.set("queue", queue);
    await next();
  });

  // Unauthenticated routes
  app.route("/", health);
  app.route("/", accounts);

  // Auth middleware for all other routes
  app.use("/repos/*", authMiddleware);
  app.use("/scans/*", authMiddleware);
  app.use("/clear-scans", authMiddleware);
  app.use("/clear-repos", authMiddleware);

  // Authenticated routes
  app.route("/", repos);
  app.route("/", scans);
  app.route("/", dupes);
  app.route("/", reset);

  return { app, ctx: { db: database, queue, worker } };
}
