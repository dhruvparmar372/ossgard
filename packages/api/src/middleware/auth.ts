import type { Context, Next } from "hono";
import type { AppEnv } from "../app.js";
import { log } from "../logger.js";

const authLog = log.child("auth");

export async function authMiddleware(c: Context<AppEnv>, next: Next) {
  const header = c.req.header("Authorization");
  if (!header || !header.startsWith("Bearer ")) {
    authLog.warn("Missing or malformed Authorization header", { path: c.req.path });
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const apiKey = header.slice(7);
  const db = c.get("db");
  const account = db.getAccountByApiKey(apiKey);

  if (!account) {
    authLog.warn("Invalid API key", { hint: `...${apiKey.slice(-4)}` });
    return c.json({ error: "Invalid API key" }, 401);
  }

  authLog.debug("Authenticated", { accountId: account.id, label: account.label ?? "" });
  c.set("account", account);
  await next();
}
