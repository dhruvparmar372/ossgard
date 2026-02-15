import { Hono } from "hono";
import type { AppEnv } from "../app.js";

const dupes = new Hono<AppEnv>();

dupes.get("/repos/:owner/:name/dupes", (c) => {
  const db = c.get("db");
  const { owner, name } = c.req.param();

  const repo = db.getRepoByOwnerName(owner, name);
  if (!repo) {
    return c.json({ error: `${owner}/${name} is not tracked` }, 404);
  }

  const scan = db.getLatestCompletedScan(repo.id);
  if (!scan) {
    return c.json(
      { error: `No completed scan found for ${owner}/${name}` },
      404
    );
  }

  const groups = db.listDupeGroups(scan.id);

  const result = groups.map((group) => {
    const members = db.listDupeGroupMembers(group.id);

    const membersWithPRs = members.map((member) => {
      const pr = db.getPR(member.prId);
      return {
        prId: member.prId,
        prNumber: pr?.number ?? 0,
        title: pr?.title ?? "Unknown",
        author: pr?.author ?? "Unknown",
        state: pr?.state ?? "open",
        rank: member.rank,
        score: member.score,
        rationale: member.rationale,
      };
    });

    return {
      groupId: group.id,
      label: group.label,
      prCount: group.prCount,
      members: membersWithPRs,
    };
  });

  return c.json({
    repo: `${repo.owner}/${repo.name}`,
    scanId: scan.id,
    completedAt: scan.completedAt,
    groupCount: groups.length,
    groups: result,
  });
});

export { dupes };
