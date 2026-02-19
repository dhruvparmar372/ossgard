import type { RepoScanData } from "@/lib/types";
import openclawData from "./openclaw-openclaw.json";

export const repos: RepoScanData[] = [
  openclawData as RepoScanData,
];

export function getRepoData(owner: string, name: string): RepoScanData | undefined {
  return repos.find((r) => r.repo.owner === owner && r.repo.name === name);
}
