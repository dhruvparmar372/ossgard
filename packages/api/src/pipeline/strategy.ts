import type { PR, DuplicateStrategyName, PhaseTokenUsage } from "@ossgard/shared";
import type { Database } from "../db/database.js";
import type { ServiceResolver } from "../services/service-resolver.js";

export interface StrategyContext {
  prs: PR[];
  scanId: number;
  repoId: number;
  accountId: number;
  resolver: ServiceResolver;
  db: Database;
}

export interface StrategyDupeGroup {
  label: string;
  confidence: number;
  relationship: string;
  members: Array<{
    prId: number;
    prNumber: number;
    rank: number;
    score: number;
    rationale: string;
  }>;
}

export type { PhaseTokenUsage };

export interface StrategyResult {
  groups: StrategyDupeGroup[];
  tokenUsage: { inputTokens: number; outputTokens: number };
  phaseTokenUsage: PhaseTokenUsage;
  providerInfo: {
    llmProvider: string;
    llmModel: string;
    embeddingProvider: string;
    embeddingModel: string;
  };
}

export interface DuplicateStrategy {
  readonly name: DuplicateStrategyName;
  execute(ctx: StrategyContext): Promise<StrategyResult>;
}
