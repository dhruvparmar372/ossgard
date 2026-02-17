import { Hono } from "hono";
import type { AppEnv } from "../app.js";
import { log } from "../logger.js";

const resetLog = log.child("reset");

const reset = new Hono<AppEnv>();

reset.post("/reset", (c) => {
  const db = c.get("db");
  db.reset();
  resetLog.info("Database reset");
  return c.json({ ok: true });
});

export { reset };
