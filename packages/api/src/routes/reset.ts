import { Hono } from "hono";
import type { AppEnv } from "../app.js";
import { log } from "../logger.js";

const resetLog = log.child("reset");

const reset = new Hono<AppEnv>();

reset.post("/clear-scans", (c) => {
  const db = c.get("db");
  db.clearScans();
  resetLog.info("Scans cleared");
  return c.json({ ok: true });
});

reset.post("/clear-repos", (c) => {
  const db = c.get("db");
  db.clearRepos();
  resetLog.info("Repos cleared");
  return c.json({ ok: true });
});

reset.post("/reset", (c) => {
  const db = c.get("db");
  db.resetAll();
  resetLog.info("Full reset — all data cleared including accounts");
  return c.json({ ok: true });
});

export { reset };
