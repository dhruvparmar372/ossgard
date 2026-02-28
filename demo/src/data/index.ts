import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import type { RepoScanData, RepoScanIndex, ScanSummary } from "@/lib/types";

const DATA_DIR = join(process.cwd(), "src", "data");

function discoverRepos(): RepoScanIndex[] {
  const entries = readdirSync(DATA_DIR, { withFileTypes: true });
  const repoDirs = entries.filter((e) => e.isDirectory());

  const indexes: RepoScanIndex[] = [];

  for (const dir of repoDirs) {
    const dirPath = join(DATA_DIR, dir.name);
    const files = readdirSync(dirPath).filter(
      (f) => f.startsWith("scan-") && f.endsWith(".json")
    );

    if (files.length === 0) continue;

    // Parse the first scan to get repo metadata
    const firstScan: RepoScanData = JSON.parse(
      readFileSync(join(dirPath, files[0]), "utf-8")
    );

    const scans: ScanSummary[] = files
      .map((f) => {
        const data: RepoScanData = JSON.parse(
          readFileSync(join(dirPath, f), "utf-8")
        );
        return {
          id: data.scan.id,
          completedAt: data.scan.completedAt,
          prCount: data.scan.prCount,
          dupeGroupCount: data.scan.dupeGroupCount,
          dupePrCount: data.groups.reduce(
            (sum, g) => sum + g.members.filter((m) => m.rank > 1).length,
            0
          ),
          inputTokens: data.scan.inputTokens ?? 0,
          outputTokens: data.scan.outputTokens ?? 0,
          tokenUsage: data.scan.tokenUsage ?? null,
          llmProvider: data.scan.llmProvider ?? null,
          llmModel: data.scan.llmModel ?? null,
          embeddingProvider: data.scan.embeddingProvider ?? null,
          embeddingModel: data.scan.embeddingModel ?? null,
        };
      })
      .sort((a, b) => b.id - a.id); // newest first

    indexes.push({
      repo: firstScan.repo,
      scans,
    });
  }

  return indexes;
}

export const repos: RepoScanIndex[] = discoverRepos();

export function getRepoData(owner: string, name: string): RepoScanIndex | undefined {
  return repos.find((r) => r.repo.owner === owner && r.repo.name === name);
}

export function getScanData(owner: string, name: string, scanId: number): RepoScanData | undefined {
  const dirName = `${owner}-${name}`;
  const filePath = join(DATA_DIR, dirName, `scan-${scanId}.json`);
  if (!existsSync(filePath)) return undefined;
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

export function getLatestScan(owner: string, name: string): RepoScanData | undefined {
  const repo = getRepoData(owner, name);
  if (!repo || repo.scans.length === 0) return undefined;
  return getScanData(owner, name, repo.scans[0].id);
}
