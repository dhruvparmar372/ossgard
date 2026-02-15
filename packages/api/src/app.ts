import { Hono } from "hono";
import { Database } from "./db/database.js";
import { health } from "./routes/health.js";
import { repos } from "./routes/repos.js";

export type AppEnv = {
  Variables: {
    db: Database;
  };
};

export function createApp(db?: Database): Hono<AppEnv> {
  const database = db ?? new Database(process.env.DATABASE_PATH ?? ":memory:");

  const app = new Hono<AppEnv>();

  // Inject database into context
  app.use("*", async (c, next) => {
    c.set("db", database);
    await next();
  });

  app.route("/", health);
  app.route("/", repos);

  return app;
}
