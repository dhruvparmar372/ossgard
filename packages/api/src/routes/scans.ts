import { Hono } from "hono";
import type { AppEnv } from "../app.js";

const scans = new Hono<AppEnv>();

scans.post("/repos/:owner/:name/scan", async (c) => {
  const db = c.get("db");
  const queue = c.get("queue");
  const { owner, name } = c.req.param();

  const repo = db.getRepoByOwnerName(owner, name);
  if (!repo) {
    return c.json({ error: `${owner}/${name} is not tracked` }, 404);
  }

  // Parse optional body for scan options
  let full = false;
  try {
    const body = await c.req.json();
    if (body && typeof body.full === "boolean") {
      full = body.full;
    }
  } catch {
    // No body or invalid JSON is fine - defaults to incremental
  }

  const scan = db.createScan(repo.id);

  const jobId = await queue.enqueue({
    type: "scan",
    payload: { scanId: scan.id, repoId: repo.id, full },
  });

  return c.json({ scanId: scan.id, jobId, status: "queued" }, 202);
});

scans.get("/scans/:id", (c) => {
  const db = c.get("db");
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
