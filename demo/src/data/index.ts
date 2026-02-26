import type { RepoScanData, RepoScanIndex } from "@/lib/types";

import openclawOpenclawScan43 from "./openclaw-openclaw/scan-43.json";
import openclawOpenclawScan42 from "./openclaw-openclaw/scan-42.json";

const scanMap: Record<string, Record<number, RepoScanData>> = {
  "openclaw/openclaw": {
    43: openclawOpenclawScan43 as RepoScanData,
    42: openclawOpenclawScan42 as RepoScanData,
  },
};

export const repos: RepoScanIndex[] = [
  {
    "repo": {
      "owner": "openclaw",
      "name": "openclaw",
      "url": "https://github.com/openclaw/openclaw"
    },
    "scans": [
      {
        "id": 43,
        "completedAt": "2026-02-25T18:53:15.596Z",
        "prCount": 4010,
        "dupeGroupCount": 323
      },
      {
        "id": 42,
        "completedAt": "2026-02-25T09:48:41.524Z",
        "prCount": 3761,
        "dupeGroupCount": 272
      }
    ]
  }
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
