import { Hono } from "hono";
import type { AppEnv } from "../app.js";

const health = new Hono<AppEnv>();

health.get("/health", (c) => {
  return c.json({ status: "ok" });
});

export { health };
