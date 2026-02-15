import { Hono } from "hono";
import { Database } from "./db/database.js";
import { LocalJobQueue } from "./queue/local-job-queue.js";
import { WorkerLoop } from "./queue/worker.js";
import type { JobProcessor } from "./queue/worker.js";
import { health } from "./routes/health.js";
import { repos } from "./routes/repos.js";
import { scans } from "./routes/scans.js";

export type AppEnv = {
  Variables: {
    db: Database;
    queue: LocalJobQueue;
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

  // Inject database and queue into context
  app.use("*", async (c, next) => {
    c.set("db", database);
    c.set("queue", queue);
    await next();
  });

  app.route("/", health);
  app.route("/", repos);
  app.route("/", scans);

  return { app, ctx: { db: database, queue, worker } };
}
