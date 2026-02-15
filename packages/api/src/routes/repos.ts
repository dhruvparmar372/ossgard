import { Hono } from "hono";
import { TrackRepoRequest } from "@ossgard/shared";
import type { AppEnv } from "../app.js";

const repos = new Hono<AppEnv>();

repos.get("/repos", (c) => {
  const db = c.get("db");
  const allRepos = db.listRepos();
  return c.json(allRepos);
});

repos.post("/repos", async (c) => {
  const db = c.get("db");
  const body = await c.req.json();

  const parsed = TrackRepoRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const { owner, name } = parsed.data;

  const existing = db.getRepoByOwnerName(owner, name);
  if (existing) {
    return c.json({ error: `${owner}/${name} is already tracked` }, 409);
  }

  const repo = db.insertRepo(owner, name);
  return c.json(repo, 201);
});

repos.delete("/repos/:owner/:name", (c) => {
  const db = c.get("db");
  const { owner, name } = c.req.param();

  const deleted = db.deleteRepo(owner, name);
  if (!deleted) {
    return c.json({ error: `${owner}/${name} not found` }, 404);
  }

  return c.json({ ok: true });
});

export { repos };
