import type { Context, Next } from "hono";
import type { AppEnv } from "../app.js";

export async function authMiddleware(c: Context<AppEnv>, next: Next) {
  const header = c.req.header("Authorization");
  if (!header || !header.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const apiKey = header.slice(7);
  const db = c.get("db");
  const account = db.getAccountByApiKey(apiKey);

  if (!account) {
    return c.json({ error: "Invalid API key" }, 401);
  }

  c.set("account", account);
  await next();
}
