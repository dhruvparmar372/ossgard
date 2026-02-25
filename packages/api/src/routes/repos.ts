import { Hono } from "hono";
import { TrackRepoRequest } from "@ossgard/shared";
import type { AppEnv } from "../app.js";
import { ServiceResolver } from "../services/service-resolver.js";
import { log } from "../logger.js";

const reposLog = log.child("repos");

const repos = new Hono<AppEnv>();

repos.get("/repos", (c) => {
  const db = c.get("db");
  const account = c.get("account");
  const allRepos = db.listRepos();
  const enriched = allRepos.map((repo) => {
    const activeScan = db.getActiveScan(repo.id, account.id);
    return {
      ...repo,
      prCount: db.countPRs(repo.id),
      activeScanStatus: activeScan?.status ?? null,
      activeScanPrCount: activeScan?.prCount ?? null,
      activeScanDupeGroupCount: activeScan?.dupeGroupCount ?? null,
    };
  });
  return c.json(enriched);
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

  return c.body(null, 204);
});

repos.post("/repos/:owner/:name/reconcile", async (c) => {
  const db = c.get("db");
  const account = c.get("account");
  const { owner, name } = c.req.param();

  const repo = db.getRepoByOwnerName(owner, name);
  if (!repo) {
    return c.json({ error: `${owner}/${name} is not tracked` }, 404);
  }

  const resolver = new ServiceResolver(db);
  const { github } = await resolver.resolve(account.id);

  reposLog.info("Reconcile started", { repo: `${owner}/${name}` });

  // Fetch all currently-open PR numbers from GitHub (full fetch, no since)
  reposLog.info("Fetching open PRs from GitHub", { repo: `${owner}/${name}` });
  const openPRs = await github.listOpenPRs(owner, name);
  const openNumbers = openPRs.map((pr) => pr.number);
  reposLog.info("GitHub fetch complete", { repo: `${owner}/${name}`, githubOpen: openNumbers.length });

  // Mark any DB PRs as closed if they're not in the fetched open set
  const beforeCount = db.listOpenPRs(repo.id).length;
  reposLog.info("Marking stale PRs", { repo: `${owner}/${name}`, dbOpen: beforeCount, githubOpen: openNumbers.length });
  const closedCount = db.markStalePRsClosed(repo.id, openNumbers);
  const afterCount = beforeCount - closedCount;

  reposLog.info("Reconcile complete", {
    repo: `${owner}/${name}`,
    githubOpen: openNumbers.length,
    dbBefore: beforeCount,
    dbAfter: afterCount,
    closed: closedCount,
  });

  return c.json({
    repo: `${owner}/${name}`,
    githubOpen: openNumbers.length,
    dbOpenBefore: beforeCount,
    dbOpenAfter: afterCount,
    closed: closedCount,
  });
});

export { repos };
