export interface Repo {
  id: number;
  owner: string;
  name: string;
  lastScanAt: string | null;
  createdAt: string;
}

export interface PR {
  id: number;
  repoId: number;
  number: number;
  title: string;
  body: string | null;
  author: string;
  diffHash: string | null;
  filePaths: string[];
  state: "open" | "closed" | "merged";
  githubEtag: string | null;
  embedHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ScanStatus =
  | "queued"
  | "ingesting"
  | "embedding"
  | "verifying"
  | "ranking"
  | "done"
  | "failed"
  | "paused";

export type DuplicateStrategyName = "pairwise-llm";

export interface Scan {
  id: number;
  repoId: number;
  status: ScanStatus;
  strategy: DuplicateStrategyName;
  phaseCursor: Record<string, unknown> | null;
  prCount: number;
  dupeGroupCount: number;
  inputTokens: number;
  outputTokens: number;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface DupeGroup {
  id: number;
  scanId: number;
  repoId: number;
  label: string | null;
  prCount: number;
}

export interface DupeGroupMember {
  id: number;
  groupId: number;
  prId: number;
  rank: number;
  score: number;
  rationale: string | null;
}

export type JobType =
  | "scan"
  | "ingest"
  | "detect";

export type JobStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "paused";

export interface Job {
  id: string;
  type: JobType;
  payload: Record<string, unknown>;
  status: JobStatus;
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  maxRetries: number;
  runAfter: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountConfig {
  github: { token: string };
  llm: { provider: string; url: string; model: string; api_key: string; batch?: boolean };
  embedding: { provider: string; url: string; model: string; api_key: string; batch?: boolean };
  vector_store: { url: string; api_key: string };
  scan?: { concurrency?: number; candidate_threshold?: number; max_candidates_per_pr?: number };
}

export interface Account {
  id: number;
  apiKey: string;
  label: string | null;
  config: AccountConfig;
  createdAt: string;
  updatedAt: string;
}

export interface ScanProgress {
  scanId: number;
  status: ScanStatus;
  phase: string;
  progress: { current: number; total: number } | null;
  dupeGroupCount: number;
}
