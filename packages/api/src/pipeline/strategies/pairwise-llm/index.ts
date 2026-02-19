import type { DuplicateStrategy, StrategyContext, StrategyResult, StrategyDupeGroup } from "../../strategy.js";
import { IntentExtractor } from "./intent-extractor.js";
import { PairwiseVerifier, type CandidatePair } from "./pairwise-verifier.js";
import { CliqueGrouper, type ConfirmedEdge } from "./clique-grouper.js";
import { isBatchChatProvider } from "../../../services/llm-provider.js";
import { buildRankPrompt } from "../../prompts.js";
import { log } from "../../../logger.js";

const CODE_V2_COLLECTION = "ossgard-code-v2";
const INTENT_V2_COLLECTION = "ossgard-intent-v2";
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

    // --- Phase 1: Intent Extraction ---
    db.updateScanStatus(scanId, "embedding"); // reuse status for progress
    strategyLog.info("Phase 1: Extracting intents", { scanId, prs: prs.length });

    const extractor = new IntentExtractor(llm);
    const intents = await extractor.extract(prs);

    // --- Phase 2: Embed (intent summaries + diff content) ---
    strategyLog.info("Phase 2: Embedding", { scanId });

    await vectorStore.ensureCollection(INTENT_V2_COLLECTION, embedding.dimensions);
    await vectorStore.ensureCollection(CODE_V2_COLLECTION, embedding.dimensions);

    // Embed intent summaries
    const intentTexts = prs.map((pr) => intents.get(pr.number) ?? pr.title);
    const intentVectors = await embedding.embed(intentTexts);

    await vectorStore.upsert(
      INTENT_V2_COLLECTION,
      prs.map((pr, i) => ({
        id: `${repoId}-${pr.number}-intent-v2`,
        vector: intentVectors[i],
        payload: { repoId, prNumber: pr.number, prId: pr.id },
      }))
    );

    // Embed normalized diff content (using filePaths + title as proxy for now)
    const codeTexts = prs.map((pr) => {
      const paths = pr.filePaths.join("\n");
      return paths.length > 0 ? `${pr.title}\n${paths}` : pr.title;
    });
    const codeVectors = await embedding.embed(codeTexts);

    await vectorStore.upsert(
      CODE_V2_COLLECTION,
      prs.map((pr, i) => ({
        id: `${repoId}-${pr.number}-code-v2`,
        vector: codeVectors[i],
        payload: { repoId, prNumber: pr.number, prId: pr.id },
      }))
    );

    // --- Phase 3: Candidate Retrieval + Pairwise Verification ---
    db.updateScanStatus(scanId, "verifying");
    strategyLog.info("Phase 3: Candidate retrieval + pairwise verification", { scanId });

    const threshold = DEFAULT_CANDIDATE_THRESHOLD;
    const maxK = DEFAULT_MAX_CANDIDATES;
    const candidatePairs = new Map<string, CandidatePair>();
    const prByNumber = new Map(prs.map((pr) => [pr.number, pr]));

    // k-NN on both collections
    for (let i = 0; i < prs.length; i++) {
      const pr = prs[i];

      for (const [collection, vector] of [
        [INTENT_V2_COLLECTION, intentVectors[i]],
        [CODE_V2_COLLECTION, codeVectors[i]],
      ] as const) {
        const neighbors = await vectorStore.search(collection, vector as number[], {
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

    // Pairwise LLM verification
    const verifier = new PairwiseVerifier(llm);
    const pairs = [...candidatePairs.values()];
    const { results: verifyResults, tokenUsage: verifyTokens } = await verifier.verifyBatch(pairs);
    totalInput += verifyTokens.inputTokens;
    totalOutput += verifyTokens.outputTokens;

    // Build confirmed edges
    const confirmedEdges: ConfirmedEdge[] = pairs.map((pair, i) => ({
      prA: pair.prA.number,
      prB: pair.prB.number,
      result: verifyResults[i],
    }));

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

    return {
      groups: strategyGroups,
      tokenUsage: { inputTokens: totalInput, outputTokens: totalOutput },
    };
  }
}
