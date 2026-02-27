import { Cpu, Database } from "lucide-react";
import type { PhaseTokenUsage } from "@/lib/types";
import { formatTokens, formatCost, estimateTokenCost } from "@/lib/utils";

interface TokenUsageCardProps {
  tokenUsage: PhaseTokenUsage;
  llmModel: string | null;
  embeddingModel: string | null;
}

function Row({
  label,
  input,
  output,
  cost,
}: {
  label: string;
  input: number;
  output?: number;
  cost: number;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex items-center gap-6 font-mono text-xs">
        <span className="text-foreground">
          {formatTokens(input)} in
          {output !== undefined && ` / ${formatTokens(output)} out`}
        </span>
        <span className="w-16 text-right text-muted-foreground">
          ~{formatCost(cost)}
        </span>
      </div>
    </div>
  );
}

export function TokenUsageCard({
  tokenUsage,
  llmModel,
  embeddingModel,
}: TokenUsageCardProps) {
  const embeddingCost = estimateTokenCost(
    tokenUsage.embedding.input,
    0,
    embeddingModel
  );

  const phases = [
    { label: "Intent", ...tokenUsage.intent },
    { label: "Verify", ...tokenUsage.verify },
    { label: "Rank", ...tokenUsage.rank },
  ];

  const llmPhaseCosts = phases.map((p) =>
    estimateTokenCost(p.input, p.output, llmModel)
  );
  const totalLlmCost = llmPhaseCosts.reduce((a, b) => a + b, 0);

  const totalInput =
    tokenUsage.embedding.input +
    phases.reduce((s, p) => s + p.input, 0);
  const totalOutput = phases.reduce((s, p) => s + p.output, 0);
  const totalCost = embeddingCost + totalLlmCost;

  return (
    <div className="rounded-sm border border-border bg-card">
      <div className="border-b border-border px-5 py-3">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Token Usage
        </h3>
      </div>

      {/* Embeddings */}
      <div className="border-b border-border px-5 py-3">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Database className="size-3" />
          Embeddings
          {embeddingModel && (
            <span className="font-mono font-normal">({embeddingModel})</span>
          )}
        </div>
        <div className="mt-1">
          <Row
            label="Embed PRs"
            input={tokenUsage.embedding.input}
            cost={embeddingCost}
          />
        </div>
      </div>

      {/* LLM */}
      <div className="border-b border-border px-5 py-3">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Cpu className="size-3" />
          LLM
          {llmModel && (
            <span className="font-mono font-normal">({llmModel})</span>
          )}
        </div>
        <div className="mt-1">
          {phases.map((p, i) => (
            <Row
              key={p.label}
              label={p.label}
              input={p.input}
              output={p.output}
              cost={llmPhaseCosts[i]}
            />
          ))}
        </div>
      </div>

      {/* Total */}
      <div className="px-5 py-3">
        <div className="flex items-center justify-between gap-4 text-sm font-medium">
          <span className="text-foreground">Total</span>
          <div className="flex items-center gap-6 font-mono text-xs">
            <span className="text-foreground">
              {formatTokens(totalInput)} in / {formatTokens(totalOutput)} out
            </span>
            <span className="w-16 text-right text-primary font-medium">
              ~{formatCost(totalCost)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
