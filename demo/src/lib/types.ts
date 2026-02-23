export interface RepoScanData {
  repo: {
    owner: string;
    name: string;
    url: string;
  };
  scan: {
    id: number;
    completedAt: string;
    prCount: number;
    dupeGroupCount: number;
  };
  groups: Array<DupeGroup>;
}

export interface ScanSummary {
  id: number;
  completedAt: string;
  prCount: number;
  dupeGroupCount: number;
}

export interface RepoScanIndex {
  repo: {
    owner: string;
    name: string;
    url: string;
  };
  scans: ScanSummary[];
}

export interface DupeGroup {
  id: number;
  label: string;
  members: Array<DupeGroupMember>;
}

export interface DupeGroupMember {
  prNumber: number;
  title: string;
  author: string;
  state: "open" | "closed" | "merged";
  rank: number;
  score: number;
  rationale: string;
  url: string;
}

/** Count of PRs recommended to close (rank > 1) across all groups */
export function countDuplicatePrs(data: RepoScanData): number {
  return data.groups.reduce(
    (sum, g) => sum + g.members.filter((m) => m.rank > 1).length,
    0
  );
}

/** Percentage of scanned PRs that are duplicates */
export function duplicatePercentage(data: RepoScanData): number {
  const dupes = countDuplicatePrs(data);
  if (data.scan.prCount === 0) return 0;
  return Math.round((dupes / data.scan.prCount) * 100);
}
