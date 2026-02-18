import type { PR } from "@ossgard/shared";
import type { ChatProvider, Message } from "../../../services/llm-provider.js";
import { isBatchChatProvider } from "../../../services/llm-provider.js";
import { log } from "../../../logger.js";

export interface PairwiseResult {
  isDuplicate: boolean;
  confidence: number;
  relationship: string;
  rationale: string;
}

export interface CandidatePair {
  prA: PR;
  prB: PR;
  intentA: string;
  intentB: string;
}

const VERIFY_SYSTEM_PROMPT = `You compare two pull requests and determine if they are solving the same problem.

Consider:
- Do they address the same issue or bug?
- Do they modify the same files in similar ways?
- Is their intent/goal the same, even if the implementation differs?

Two PRs are duplicates if they solve the SAME problem. They are NOT duplicates if they merely touch similar code for different reasons.

Respond with JSON:
{
  "isDuplicate": true/false,
  "confidence": 0.0-1.0,
  "relationship": "exact_duplicate|near_duplicate|related|unrelated",
  "rationale": "brief explanation"
}`;

const verifyLog = log.child("pairwise-verifier");

export class PairwiseVerifier {
  constructor(private llm: ChatProvider) {}

  async verify(prA: PR, prB: PR, intentA: string, intentB: string): Promise<PairwiseResult> {
    const messages = this.buildMessages(prA, prB, intentA, intentB);
    const result = await this.llm.chat(messages);
    return this.parseResult(result.response);
  }

  async verifyBatch(
    pairs: CandidatePair[]
  ): Promise<{ results: PairwiseResult[]; tokenUsage: { inputTokens: number; outputTokens: number } }> {
    let totalInput = 0;
    let totalOutput = 0;
    const results: PairwiseResult[] = [];

    if (isBatchChatProvider(this.llm) && pairs.length > 1) {
      const batchResults = await this.llm.chatBatch(
        pairs.map((p, i) => ({
          id: `verify-${i}`,
          messages: this.buildMessages(p.prA, p.prB, p.intentA, p.intentB),
        }))
      );
      for (const r of batchResults) {
        if (r.error) {
          results.push({ isDuplicate: false, confidence: 0, relationship: "error", rationale: String(r.error) });
        } else {
          results.push(this.parseResult(r.response));
          totalInput += r.usage.inputTokens;
          totalOutput += r.usage.outputTokens;
        }
      }
    } else {
      for (const pair of pairs) {
        const result = await this.llm.chat(
          this.buildMessages(pair.prA, pair.prB, pair.intentA, pair.intentB)
        );
        results.push(this.parseResult(result.response));
        totalInput += result.usage.inputTokens;
        totalOutput += result.usage.outputTokens;
      }
    }

    verifyLog.info("Pairwise verification complete", {
      pairs: pairs.length,
      duplicates: results.filter((r) => r.isDuplicate).length,
      inputTokens: totalInput,
      outputTokens: totalOutput,
    });

    return { results, tokenUsage: { inputTokens: totalInput, outputTokens: totalOutput } };
  }

  buildMessages(prA: PR, prB: PR, intentA: string, intentB: string): Message[] {
    const userContent = `## PR #${prA.number}: ${prA.title}
Author: ${prA.author}
Intent: ${intentA}
Files: ${prA.filePaths.slice(0, 20).join(", ")}
Body: ${(prA.body ?? "(none)").slice(0, 500)}

## PR #${prB.number}: ${prB.title}
Author: ${prB.author}
Intent: ${intentB}
Files: ${prB.filePaths.slice(0, 20).join(", ")}
Body: ${(prB.body ?? "(none)").slice(0, 500)}`;

    return [
      { role: "system", content: VERIFY_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ];
  }

  private parseResult(response: unknown): PairwiseResult {
    try {
      const parsed = typeof response === "string" ? JSON.parse(response) : response;
      return {
        isDuplicate: Boolean(parsed.isDuplicate),
        confidence: Number(parsed.confidence) || 0,
        relationship: String(parsed.relationship ?? "unknown"),
        rationale: String(parsed.rationale ?? ""),
      };
    } catch {
      return { isDuplicate: false, confidence: 0, relationship: "parse_error", rationale: "Failed to parse LLM response" };
    }
  }
}
