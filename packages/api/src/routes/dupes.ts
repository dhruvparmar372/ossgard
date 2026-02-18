import { Hono } from "hono";
import type { AppEnv } from "../app.js";
import { ServiceResolver } from "../services/service-resolver.js";
import { DiffTooLargeError } from "../services/github-client.js";
import { hashDiff } from "../pipeline/normalize-diff.js";
import { buildCodeInput, buildIntentInput, computeEmbedHash, CODE_COLLECTION, INTENT_COLLECTION } from "../pipeline/embed.js";
import { TOKEN_BUDGET_FACTOR } from "../services/token-counting.js";

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
      { error: `No completed scan found for ${owner}/${name}. Run 'ossgard scan ${owner}/${name}' first.` },
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

dupes.get("/repos/:owner/:name/review/:prNumber", async (c) => {
  const db = c.get("db");
  const account = c.get("account");
  const { owner, name, prNumber: prNumberStr } = c.req.param();
  const prNumber = parseInt(prNumberStr, 10);

  if (isNaN(prNumber)) {
    return c.json({ error: "Invalid PR number" }, 400);
  }

  const repo = db.getRepoByOwnerName(owner, name);
  if (!repo) {
    return c.json({ error: `${owner}/${name} is not tracked` }, 404);
  }

  const scan = db.getLatestCompletedScan(repo.id, account.id);
  if (!scan) {
    return c.json(
      { error: `No completed scan found for ${owner}/${name}. Run 'ossgard scan ${owner}/${name}' first.` },
      404
    );
  }

  const resolver = new ServiceResolver(db);
  const services = await resolver.resolve(account.id);

  let pr = db.getPRByNumber(repo.id, prNumber);
  let hadToFetch = false;

  // If PR is not in DB, fetch it from GitHub
  if (!pr) {
    const ghPR = await services.github.fetchPR(owner, name, prNumber);

    let filePaths: string[] = [];
    let diffHash: string | null = null;
    let etag: string | null = null;

    try {
      const [files, diffResult] = await Promise.all([
        services.github.getPRFiles(owner, name, prNumber),
        services.github.getPRDiff(owner, name, prNumber),
      ]);
      filePaths = files;
      if (diffResult) {
        diffHash = hashDiff(diffResult.diff);
        etag = diffResult.etag;
      }
    } catch (err) {
      if (err instanceof DiffTooLargeError) {
        filePaths = await services.github.getPRFiles(owner, name, prNumber);
      } else {
        throw err;
      }
    }

    pr = db.upsertPR({
      repoId: repo.id,
      number: ghPR.number,
      title: ghPR.title,
      body: ghPR.body,
      author: ghPR.author,
      diffHash,
      filePaths,
      state: ghPR.state,
      createdAt: ghPR.createdAt,
      updatedAt: ghPR.updatedAt,
    });

    if (etag) {
      db.updatePREtag(pr.id, etag);
    }

    hadToFetch = true;
  }

  // Check existing dupe groups from the scan
  const dupeGroups = db.findDupeGroupsByPR(scan.id, pr.id);
  const groupResults = dupeGroups.map((group) => {
    const members = db.listDupeGroupMembers(group.id);
    const memberPrIds = members.map((m) => m.prId);
    const memberPrs = db.getPRsByIds(memberPrIds);
    const prMap = new Map(memberPrs.map((p) => [p.id, p]));

    return {
      groupId: group.id,
      label: group.label,
      prCount: group.prCount,
      members: members.map((m) => {
        const mPr = prMap.get(m.prId);
        return {
          prId: m.prId,
          prNumber: mPr?.number ?? 0,
          title: mPr?.title ?? "Unknown",
          author: mPr?.author ?? "Unknown",
          state: mPr?.state ?? "open",
          rank: m.rank,
          score: m.score,
          rationale: m.rationale,
        };
      }),
    };
  });

  // Search vector store for similar PRs
  const similarPrs: Array<{
    prId: number;
    prNumber: number;
    title: string;
    author: string;
    state: string;
    codeScore: number;
    intentScore: number;
  }> = [];

  const hasEmbeddings = pr.embedHash !== null;
  const needsEmbedding = !hasEmbeddings || hadToFetch;

  let codeVector: number[] | null = null;
  let intentVector: number[] | null = null;

  if (!needsEmbedding) {
    // PR already has embeddings in vector store — retrieve them
    codeVector = await services.vectorStore.getVector(
      CODE_COLLECTION,
      `${repo.id}-${pr.number}-code`
    );
    intentVector = await services.vectorStore.getVector(
      INTENT_COLLECTION,
      `${repo.id}-${pr.number}-intent`
    );
  }

  if (!codeVector || !intentVector) {
    // Embed the PR
    const dimensions = services.embedding.dimensions;
    await services.vectorStore.ensureCollection(CODE_COLLECTION, dimensions);
    await services.vectorStore.ensureCollection(INTENT_COLLECTION, dimensions);

    const tokenBudget = Math.floor(services.embedding.maxInputTokens * TOKEN_BUDGET_FACTOR);
    const countTokens = services.embedding.countTokens.bind(services.embedding);

    const codeInput = buildCodeInput(pr.filePaths, tokenBudget, countTokens, pr.title);
    const intentInput = buildIntentInput(pr.title, pr.body, pr.filePaths, tokenBudget, countTokens);

    const [codeEmbeddings, intentEmbeddings] = await Promise.all([
      services.embedding.embed([codeInput]),
      services.embedding.embed([intentInput]),
    ]);

    codeVector = codeEmbeddings[0];
    intentVector = intentEmbeddings[0];

    // Upsert into vector store
    await services.vectorStore.upsert(CODE_COLLECTION, [{
      id: `${repo.id}-${pr.number}-code`,
      vector: codeVector,
      payload: { repoId: repo.id, prNumber: pr.number, prId: pr.id },
    }]);
    await services.vectorStore.upsert(INTENT_COLLECTION, [{
      id: `${repo.id}-${pr.number}-intent`,
      vector: intentVector,
      payload: { repoId: repo.id, prNumber: pr.number, prId: pr.id },
    }]);

    db.updatePREmbedHash(pr.id, computeEmbedHash(pr));
  }

  // Search for similar PRs (excluding self)
  const [codeResults, intentResults] = await Promise.all([
    services.vectorStore.search(CODE_COLLECTION, codeVector, {
      limit: 11,
      filter: {
        must: [{ key: "repoId", match: { value: repo.id } }],
      },
    }),
    services.vectorStore.search(INTENT_COLLECTION, intentVector, {
      limit: 11,
      filter: {
        must: [{ key: "repoId", match: { value: repo.id } }],
      },
    }),
  ]);

  // Merge code and intent results
  const scoreMap = new Map<number, { codeScore: number; intentScore: number }>();
  for (const r of codeResults) {
    const rPrId = r.payload.prId as number;
    if (rPrId === pr.id) continue;
    const entry = scoreMap.get(rPrId) ?? { codeScore: 0, intentScore: 0 };
    entry.codeScore = r.score;
    scoreMap.set(rPrId, entry);
  }
  for (const r of intentResults) {
    const rPrId = r.payload.prId as number;
    if (rPrId === pr.id) continue;
    const entry = scoreMap.get(rPrId) ?? { codeScore: 0, intentScore: 0 };
    entry.intentScore = r.score;
    scoreMap.set(rPrId, entry);
  }

  // Fetch PR details and build results
  const similarPrIds = [...scoreMap.keys()];
  if (similarPrIds.length > 0) {
    const prsById = db.getPRsByIds(similarPrIds);
    const prLookup = new Map(prsById.map((p) => [p.id, p]));

    for (const [prId, scores] of scoreMap) {
      const sPr = prLookup.get(prId);
      if (!sPr) continue;
      similarPrs.push({
        prId,
        prNumber: sPr.number,
        title: sPr.title,
        author: sPr.author,
        state: sPr.state,
        codeScore: scores.codeScore,
        intentScore: scores.intentScore,
      });
    }

    // Sort by max of code or intent score descending
    similarPrs.sort((a, b) =>
      Math.max(b.codeScore, b.intentScore) - Math.max(a.codeScore, a.intentScore)
    );
  }

  return c.json({
    repo: `${repo.owner}/${repo.name}`,
    scanId: scan.id,
    pr: {
      id: pr.id,
      number: pr.number,
      title: pr.title,
      author: pr.author,
      state: pr.state,
    },
    dupeGroups: groupResults,
    similarPrs: similarPrs.slice(0, 10),
  });
});

export { dupes };
