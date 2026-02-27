import { Hono } from "hono";
import type { AppEnv } from "../app.js";
import { log } from "../logger.js";

const scansLog = log.child("scans");

const scans = new Hono<AppEnv>();

scans.post("/repos/:owner/:name/scan", async (c) => {
  const db = c.get("db");
  const queue = c.get("queue");
  const account = c.get("account");
  const { owner, name } = c.req.param();

  let repo = db.getRepoByOwnerName(owner, name);
  if (!repo) {
    repo = db.insertRepo(owner, name);
    scansLog.info("Auto-tracked repo", { repo: `${owner}/${name}` });
  }

  // Parse optional body for scan options
  let full = false;
  let maxPrs: number | undefined;
  try {
    const body = await c.req.json();
    if (body && typeof body.full === "boolean") {
      full = body.full;
    }
    if (body && typeof body.maxPrs === "number" && body.maxPrs > 0) {
      maxPrs = body.maxPrs;
    }
  } catch {
    // No body or invalid JSON is fine - defaults to incremental
  }

  // If a scan is already running, return it instead of creating a new one
  const activeScan = db.getActiveScan(repo.id, account.id);
  if (activeScan) {
    scansLog.info("Scan already active", { repo: `${owner}/${name}`, scanId: activeScan.id });
    return c.json({ scanId: activeScan.id, status: activeScan.status }, 200);
  }

  const scan = db.createScan(repo.id, account.id);

  const jobId = await queue.enqueue({
    type: "scan",
    payload: { scanId: scan.id, repoId: repo.id, accountId: account.id, full, ...(maxPrs !== undefined && { maxPrs }) },
  });

  scansLog.info("Scan started", { repo: `${owner}/${name}`, scanId: scan.id });

  return c.json({ scanId: scan.id, jobId, status: "queued" }, 202);
});

scans.get("/repos/:owner/:name/scans", (c) => {
  const db = c.get("db");
  const account = c.get("account");
  const { owner, name } = c.req.param();

  const repo = db.getRepoByOwnerName(owner, name);
  if (!repo) {
    return c.json({ error: `${owner}/${name} is not tracked` }, 404);
  }

  const completed = db.listCompletedScans(repo.id, account.id);

  return c.json({
    scans: completed.map((s) => ({
      id: s.id,
      status: s.status,
      prCount: s.prCount,
      dupeGroupCount: s.dupeGroupCount,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      tokenUsage: s.tokenUsage,
      llmProvider: s.llmProvider,
      llmModel: s.llmModel,
      embeddingProvider: s.embeddingProvider,
      embeddingModel: s.embeddingModel,
      completedAt: s.completedAt,
    })),
  });
});

scans.get("/scans/:id", (c) => {
  const db = c.get("db");
  const account = c.get("account");
  const id = Number(c.req.param("id"));

  if (Number.isNaN(id)) {
    return c.json({ error: "Invalid scan ID" }, 400);
  }

  const scan = db.getScan(id);
  if (!scan) {
    return c.json({ error: "Scan not found" }, 404);
  }

  return c.json(scan);
});

export { scans };
