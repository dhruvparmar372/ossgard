import type { PR } from "@ossgard/shared";
import type { ChatProvider, Message } from "../../../services/llm-provider.js";
import { isBatchChatProvider } from "../../../services/llm-provider.js";
import { log } from "../../../logger.js";

const INTENT_SYSTEM_PROMPT = `You are a code reviewer. Given a pull request's title, description, and code diff, summarize what this PR changes and WHY in 2-3 sentences. Focus on the problem being solved, not implementation details. Be specific and precise.

Respond with JSON: { "summary": "<your 2-3 sentence summary>" }`;

const MAX_DIFF_CHARS = 12_000; // ~3000 tokens

const intentLog = log.child("intent-extractor");

export class IntentExtractor {
  constructor(private llm: ChatProvider) {}

  async extract(prs: PR[], diffs?: Map<number, string>): Promise<{ intents: Map<number, string>; tokenUsage: { input: number; output: number } }> {
    const summaries = new Map<number, string>();
    let totalInput = 0;
    let totalOutput = 0;

    const messages = prs.map((pr) => this.buildMessages(pr, diffs?.get(pr.number)));

    if (isBatchChatProvider(this.llm) && prs.length > 1) {
      const results = await this.llm.chatBatch(
        prs.map((pr, i) => ({ id: `intent-${pr.number}`, messages: messages[i] }))
      );
      for (let i = 0; i < results.length; i++) {
        if (results[i].error) {
          intentLog.warn("Intent extraction failed", { pr: prs[i].number, error: results[i].error });
          continue;
        }
        summaries.set(prs[i].number, extractSummary(results[i].response));
        totalInput += results[i].usage.inputTokens;
        totalOutput += results[i].usage.outputTokens;
      }
    } else {
      for (let i = 0; i < prs.length; i++) {
        const result = await this.llm.chat(messages[i]);
        summaries.set(prs[i].number, extractSummary(result.response));
        totalInput += result.usage.inputTokens;
        totalOutput += result.usage.outputTokens;
      }
    }

    intentLog.info("Intent extraction complete", {
      prs: prs.length,
      extracted: summaries.size,
      inputTokens: totalInput,
      outputTokens: totalOutput,
    });

    return {
      intents: summaries,
      tokenUsage: { input: totalInput, output: totalOutput },
    };
  }

  buildMessages(pr: PR, diff?: string): Message[] {
    let diffSection = "";
    if (diff) {
      diffSection = `\nCode diff (truncated):\n${diff.slice(0, MAX_DIFF_CHARS)}`;
    } else if (pr.filePaths.length > 0) {
      diffSection = `\nChanged files:\n${pr.filePaths.join("\n")}`;
    }

    const userContent = `PR #${pr.number}: ${pr.title}

Description: ${(pr.body ?? "(none)").slice(0, 2000)}
${diffSection}`;

    return [
      { role: "system", content: INTENT_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ];
  }
}

/** Extract the summary string from the LLM JSON response. */
function extractSummary(response: Record<string, unknown>): string {
  if (typeof response.summary === "string") {
    return response.summary;
  }
  // Fallback: stringify the whole response
  return JSON.stringify(response);
}
