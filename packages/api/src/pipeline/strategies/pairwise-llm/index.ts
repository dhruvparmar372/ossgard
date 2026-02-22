import type { PR } from "@ossgard/shared";
import type { DuplicateStrategy, StrategyContext, StrategyResult, StrategyDupeGroup } from "../../strategy.js";
import { IntentExtractor } from "./intent-extractor.js";
import { PairwiseVerifier, type CandidatePair } from "./pairwise-verifier.js";
import { CliqueGrouper, type ConfirmedEdge } from "./clique-grouper.js";
import { isBatchChatProvider } from "../../../services/llm-provider.js";
import { buildRankPrompt } from "../../prompts.js";
import { computeEmbedHash } from "../../embed-utils.js";
import { log } from "../../../logger.js";

const CODE_COLLECTION = "ossgard-code";
const INTENT_COLLECTION = "ossgard-intent";
const DEFAULT_CANDIDATE_THRESHOLD = 0.65;
const DEFAULT_MAX_CANDIDATES = 5;

const strategyLog = log.child("pairwise-llm");

type RankingEntry = { prNumber: number; score: number; rationale: string };
type CliqueGroup = { members: number[]; avgConfidence: number; relationship: string };
type PRLike = { id: number; number: number };

/** Deduplicate rankings by prNumber, filter unmatched PRs, and build a StrategyDupeGroup. */
function buildStrategyGroup(
  rankings: RankingEntry[],
  groupPrs: PRLike[],
  cg: CliqueGroup,
  label: string
): StrategyDupeGroup | null {
  const sorted = [...rankings].sort((a, b) => b.score - a.score);
  const seen = new Set<number>();
  const members: StrategyDupeGroup["members"] = [];
  let rank = 1;

  for (const r of sorted) {
    if (seen.has(r.prNumber)) continue;
    const pr = groupPrs.find((p) => p.number === r.prNumber);
    if (!pr) continue;
    seen.add(r.prNumber);
    members.push({ prId: pr.id, prNumber: r.prNumber, rank: rank++, score: r.score, rationale: r.rationale });
  }

  if (members.length < 2) return null;

  return {
    label: label.slice(0, 200),
    confidence: cg.avgConfidence,
    relationship: cg.relationship,
    members,
  };
}

export class PairwiseLLMStrategy implements DuplicateStrategy {
  readonly name = "pairwise-llm" as const;

  async execute(ctx: StrategyContext): Promise<StrategyResult> {
    const { prs, scanId, repoId, accountId, resolver, db } = ctx;
    const { llm, embedding, vectorStore } = await resolver.resolve(accountId);

    let totalInput = 0;
    let totalOutput = 0;

    // --- Compute hashes and partition PRs into cached vs changed ---
    const hashMap = new Map<number, string>(); // prNumber → currentHash
    const changedPRs: PR[] = [];
    const unchangedPRs: PR[] = [];

    for (const pr of prs) {
      const currentHash = computeEmbedHash(pr);
      hashMap.set(pr.number, currentHash);
      if (pr.embedHash === currentHash) {
        unchangedPRs.push(pr);
      } else {
        changedPRs.push(pr);
      }
    }

    strategyLog.info("[detect] Cache partition", {
      scanId, total: prs.length, cached: unchangedPRs.length, changed: changedPRs.length,
    });

    // --- Phase 1: Intent Extraction ---
    db.updateScanStatus(scanId, "embedding"); // reuse status for progress
    strategyLog.info("Phase 1: Extracting intents", { scanId, prs: prs.length });

    // Build intents map: cached intents for unchanged PRs, LLM for changed PRs
    const intents = new Map<number, string>();

    // Load cached intents for unchanged PRs
    for (const pr of unchangedPRs) {
      if (pr.intentSummary) {
        intents.set(pr.number, pr.intentSummary);
      } else {
        // Has embed_hash but no intent_summary — treat as changed
        changedPRs.push(pr);
      }
    }

    // For changed PRs, reuse cached intent summaries when available
    // (e.g. from a previous run where Phase 1 succeeded but Phase 2 failed)
    const needsExtraction: PR[] = [];
    for (const pr of changedPRs) {
      if (pr.intentSummary) {
        intents.set(pr.number, pr.intentSummary);
      } else {
        needsExtraction.push(pr);
      }
    }

    // Extract intents only for PRs without cached summaries
    if (needsExtraction.length > 0) {
      const extractor = new IntentExtractor(llm);
      const newIntents = await extractor.extract(needsExtraction);
      for (const [prNum, summary] of newIntents) {
        intents.set(prNum, summary);
      }
    }

    strategyLog.info("[detect] Intent cache", {
      scanId, cached: changedPRs.length - needsExtraction.length, extracted: needsExtraction.length,
    });

    // Persist intent summaries immediately so they survive if Phase 2 fails
    for (const pr of changedPRs) {
      const summary = intents.get(pr.number);
      if (summary) {
        db.updatePRIntentSummary(pr.id, summary);
      }
    }

    // --- Phase 2: Embed (intent summaries + diff content) ---
    strategyLog.info("Phase 2: Embedding", { scanId });

    await vectorStore.ensureCollection(INTENT_COLLECTION, embedding.dimensions);
    await vectorStore.ensureCollection(CODE_COLLECTION, embedding.dimensions);

    // We need vectors for ALL PRs for k-NN search, but only embed changed PRs.
    // For changed PRs: compute and upsert new embeddings.
    // For unchanged PRs: vectors already in Qdrant from previous run.
    // However, we still need the vectors in-memory for k-NN search in Phase 3.
    // Strategy: embed changed PRs, then do k-NN search per-PR using vectorStore.search.

    // Track vectors for all PRs (needed for k-NN in Phase 3)
    const intentVectorMap = new Map<number, number[]>(); // prNumber → vector
    const codeVectorMap = new Map<number, number[]>();

    if (changedPRs.length > 0) {
      // Intent embeddings for changed PRs
      const intentTexts = changedPRs.map((pr) => intents.get(pr.number) ?? pr.title);
      const intentVectors = await embedding.embed(intentTexts);
      await vectorStore.upsert(
        INTENT_COLLECTION,
        changedPRs.map((pr, i) => ({
          id: `${repoId}-${pr.number}-intent`,
          vector: intentVectors[i],
          payload: { repoId, prNumber: pr.number, prId: pr.id },
        }))
      );
      for (let i = 0; i < changedPRs.length; i++) {
        intentVectorMap.set(changedPRs[i].number, intentVectors[i]);
      }

      // Code embeddings for changed PRs
      const codeTexts = changedPRs.map((pr) => {
        const paths = pr.filePaths.join("\n");
        return paths.length > 0 ? `${pr.title}\n${paths}` : pr.title;
      });
      const codeVectors = await embedding.embed(codeTexts);
      await vectorStore.upsert(
        CODE_COLLECTION,
        changedPRs.map((pr, i) => ({
          id: `${repoId}-${pr.number}-code`,
          vector: codeVectors[i],
          payload: { repoId, prNumber: pr.number, prId: pr.id },
        }))
      );
      for (let i = 0; i < changedPRs.length; i++) {
        codeVectorMap.set(changedPRs[i].number, codeVectors[i]);
      }

      // Persist embed hash now that vectors are in Qdrant
      for (const pr of changedPRs) {
        const hash = hashMap.get(pr.number)!;
        db.updatePREmbedHash(pr.id, hash);
      }
    }

    // For unchanged PRs, retrieve vectors from Qdrant
    for (const pr of unchangedPRs) {
      if (intents.has(pr.number)) {
        // PR was already handled (has cached intent)
        const intentPoint = await vectorStore.getVector(
          INTENT_COLLECTION,
          `${repoId}-${pr.number}-intent`
        );
        if (intentPoint) intentVectorMap.set(pr.number, intentPoint);

        const codePoint = await vectorStore.getVector(
          CODE_COLLECTION,
          `${repoId}-${pr.number}-code`
        );
        if (codePoint) codeVectorMap.set(pr.number, codePoint);
      }
    }

    // --- Phase 3: Candidate Retrieval + Pairwise Verification ---
    db.updateScanStatus(scanId, "verifying");
    strategyLog.info("Phase 3: Candidate retrieval + pairwise verification", { scanId });

    const threshold = DEFAULT_CANDIDATE_THRESHOLD;
    const maxK = DEFAULT_MAX_CANDIDATES;
    const candidatePairs = new Map<string, CandidatePair>();
    const prByNumber = new Map(prs.map((pr) => [pr.number, pr]));

    // k-NN on both collections
    for (const pr of prs) {
      const intentVector = intentVectorMap.get(pr.number);
      const codeVector = codeVectorMap.get(pr.number);

      const searches: Array<[string, number[]]> = [];
      if (intentVector) searches.push([INTENT_COLLECTION, intentVector]);
      if (codeVector) searches.push([CODE_COLLECTION, codeVector]);

      for (const [collection, vector] of searches) {
        const neighbors = await vectorStore.search(collection, vector, {
          limit: maxK * 2,
          filter: { must: [{ key: "repoId", match: { value: repoId } }] },
        });

        for (const neighbor of neighbors) {
          if (neighbor.score < threshold) continue;
          const neighborNumber = neighbor.payload.prNumber as number;
          if (neighborNumber === pr.number) continue;

          const a = Math.min(pr.number, neighborNumber);
          const b = Math.max(pr.number, neighborNumber);
          const key = `${a}-${b}`;

          if (!candidatePairs.has(key)) {
            const prB = prByNumber.get(neighborNumber);
            if (!prB) continue;
            candidatePairs.set(key, {
              prA: a === pr.number ? pr : prB,
              prB: a === pr.number ? prB : pr,
              intentA: intents.get(a) ?? "",
              intentB: intents.get(b) ?? "",
            });
          }
        }
      }
    }

    strategyLog.info("Candidate pairs found", { scanId, pairs: candidatePairs.size });

    // Check pairwise cache before LLM verification
    const pairs = [...candidatePairs.values()];
    const pairCacheLookups = pairs.map((p) => {
      const minPr = Math.min(p.prA.number, p.prB.number);
      const maxPr = Math.max(p.prA.number, p.prB.number);
      return {
        prA: minPr,
        prB: maxPr,
        hashA: hashMap.get(minPr)!,
        hashB: hashMap.get(maxPr)!,
      };
    });
    const cachedResults = db.getPairwiseCache(repoId, pairCacheLookups);

    const uncachedPairs: CandidatePair[] = [];
    const confirmedEdges: ConfirmedEdge[] = [];

    for (const pair of pairs) {
      const key = `${Math.min(pair.prA.number, pair.prB.number)}-${Math.max(pair.prA.number, pair.prB.number)}`;
      const cached = cachedResults.get(key);
      if (cached) {
        // Cache hit — use stored result directly as a confirmed edge
        confirmedEdges.push({ prA: pair.prA.number, prB: pair.prB.number, result: cached });
      } else {
        uncachedPairs.push(pair);
      }
    }

    // Only verify uncached pairs via LLM
    if (uncachedPairs.length > 0) {
      const verifier = new PairwiseVerifier(llm);
      const { results: verifyResults, tokenUsage: verifyTokens } = await verifier.verifyBatch(uncachedPairs);
      totalInput += verifyTokens.inputTokens;
      totalOutput += verifyTokens.outputTokens;

      // Store results in cache and build edges
      const cacheEntries = [];
      for (let i = 0; i < uncachedPairs.length; i++) {
        const pair = uncachedPairs[i];
        const result = verifyResults[i];
        const minPr = Math.min(pair.prA.number, pair.prB.number);
        const maxPr = Math.max(pair.prA.number, pair.prB.number);
        cacheEntries.push({
          prA: minPr,
          prB: maxPr,
          hashA: hashMap.get(minPr)!,
          hashB: hashMap.get(maxPr)!,
          result,
        });
        confirmedEdges.push({ prA: pair.prA.number, prB: pair.prB.number, result });
      }
      db.setPairwiseCache(repoId, cacheEntries);
    }

    const pairsCachedCount = pairs.length - uncachedPairs.length;
    strategyLog.info("[detect] Pairwise cache", {
      scanId, cached: pairsCachedCount, verified: uncachedPairs.length,
    });

    // --- Phase 4: Grouping + Ranking ---
    db.updateScanStatus(scanId, "ranking");
    strategyLog.info("Phase 4: Grouping + ranking", { scanId });

    const grouper = new CliqueGrouper();
    const cliqueGroups = grouper.group(confirmedEdges);

    strategyLog.info("Clique groups formed", { scanId, groups: cliqueGroups.length });

    // Rank within each group using existing rank prompt (batch or sequential)
    type RankingResponse = { rankings?: Array<{ prNumber: number; score: number; rationale: string }> };

    // Prepare all rank requests
    const rankInputs: Array<{
      cg: (typeof cliqueGroups)[number];
      groupPrs: typeof prs;
      label: string;
      messages: import("../../../services/llm-provider.js").Message[];
    }> = [];

    for (const cg of cliqueGroups) {
      const groupPrs = cg.members.map((n) => prByNumber.get(n)!).filter(Boolean);
      if (groupPrs.length < 2) continue;
      const label = intents.get(cg.members[0]) ?? groupPrs[0].title;
      const messages = buildRankPrompt(groupPrs, label, llm);
      rankInputs.push({ cg, groupPrs, label, messages });
    }

    const strategyGroups: StrategyDupeGroup[] = [];

    if (isBatchChatProvider(llm) && rankInputs.length > 1) {
      strategyLog.info("Ranking via batch", { scanId, groups: rankInputs.length });
      const batchResults = await llm.chatBatch(
        rankInputs.map((r, i) => ({ id: `rank-${i}`, messages: r.messages }))
      );
      for (let i = 0; i < rankInputs.length; i++) {
        const { cg, groupPrs, label } = rankInputs[i];
        const result = batchResults[i];
        if (result.error) {
          strategyLog.warn("Rank batch item failed", { group: i, error: result.error });
          continue;
        }
        totalInput += result.usage.inputTokens;
        totalOutput += result.usage.outputTokens;
        const rankings = (result.response as RankingResponse)?.rankings ?? [];
        const group = buildStrategyGroup(rankings, groupPrs, cg, label);
        if (group) strategyGroups.push(group);
      }
    } else {
      for (const { cg, groupPrs, label, messages } of rankInputs) {
        const rankResult = await llm.chat(messages);
        totalInput += rankResult.usage.inputTokens;
        totalOutput += rankResult.usage.outputTokens;
        const rankings = (rankResult.response as RankingResponse)?.rankings ?? [];
        const group = buildStrategyGroup(rankings, groupPrs, cg, label);
        if (group) strategyGroups.push(group);
      }
    }

    // Cache stats summary
    strategyLog.info("[detect] Cache stats", {
      scanId,
      prsCached: unchangedPRs.length,
      prsTotal: prs.length,
      pairsCached: pairsCachedCount,
      pairsTotal: pairs.length,
    });

    return {
      groups: strategyGroups,
      tokenUsage: { inputTokens: totalInput, outputTokens: totalOutput },
    };
  }
}
