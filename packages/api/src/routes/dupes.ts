import { Hono } from "hono";
import type { AppEnv } from "../app.js";

const dupes = new Hono<AppEnv>();

dupes.get("/repos/:owner/:name/dupes", (c) => {
  const db = c.get("db");
  const account = c.get("account");
  const { owner, name } = c.req.param();

  const repo = db.getRepoByOwnerName(owner, name);
  if (!repo) {
    return c.json({ error: `${owner}/${name} is not tracked` }, 404);
  }

  const scan = db.getLatestCompletedScan(repo.id, account.id);
  if (!scan) {
    return c.json(
      { error: `No completed scan found for ${owner}/${name}` },
      404
    );
  }

  const groups = db.listDupeGroups(scan.id);

  // Collect all PR IDs across all groups
  const allPrIds = new Set<number>();
  const groupsWithMembers = groups.map((group) => {
    const members = db.listDupeGroupMembers(group.id);
    for (const m of members) allPrIds.add(m.prId);
    return { group, members };
  });

  // Batch fetch all PRs
  const prs = db.getPRsByIds([...allPrIds]);
  const prMap = new Map(prs.map((pr) => [pr.id, pr]));

  // Build result using the map
  const result = groupsWithMembers.map(({ group, members }) => {
    const membersWithPRs = members.map((member) => {
      const pr = prMap.get(member.prId);
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
