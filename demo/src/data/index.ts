import type { RepoScanData, RepoScanIndex } from "@/lib/types";

import openclawOpenclawScan38 from "./openclaw-openclaw/scan-38.json";

const scanMap: Record<string, Record<number, RepoScanData>> = {
  "openclaw/openclaw": {
    38: openclawOpenclawScan38 as RepoScanData,
  },
};

export const repos: RepoScanIndex[] = [
  {
    repo: {
      owner: "openclaw",
      name: "openclaw",
      url: "https://github.com/openclaw/openclaw",
    },
    scans: [
      {
        id: 38,
        completedAt: "2026-02-22T14:01:28.499Z",
        prCount: 4421,
        dupeGroupCount: 409,
      },
    ],
  },
];

export function getRepoData(owner: string, name: string): RepoScanIndex | undefined {
  return repos.find((r) => r.repo.owner === owner && r.repo.name === name);
}

export function getScanData(owner: string, name: string, scanId: number): RepoScanData | undefined {
  return scanMap[`${owner}/${name}`]?.[scanId];
}

export function getLatestScan(owner: string, name: string): RepoScanData | undefined {
  const repo = getRepoData(owner, name);
  if (!repo || repo.scans.length === 0) return undefined;
  return getScanData(owner, name, repo.scans[0].id);
}
