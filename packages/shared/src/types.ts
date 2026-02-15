export interface Repo {
  id: number;
  owner: string;
  name: string;
  last_scan_at: string | null;
  created_at: string;
}

export interface PR {
  id: number;
  repo_id: number;
  number: number;
  title: string;
  body: string | null;
  author: string;
  diff_hash: string | null;
  file_paths: string | null;
  state: string;
  github_etag: string | null;
  created_at: string;
  updated_at: string;
}

export type ScanStatus =
  | "ingesting"
  | "embedding"
  | "clustering"
  | "verifying"
  | "ranking"
  | "done"
  | "failed"
  | "paused";

export interface Scan {
  id: number;
  repo_id: number;
  status: ScanStatus;
  phase_cursor: string | null;
  pr_count: number;
  dupe_group_count: number;
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

export interface DupeGroup {
  id: number;
  scan_id: number;
  repo_id: number;
  label: string | null;
  pr_count: number;
}

export interface DupeGroupMember {
  id: number;
  group_id: number;
  pr_id: number;
  rank: number;
  score: number;
  rationale: string | null;
}

export type JobType =
  | "scan"
  | "ingest"
  | "embed"
  | "cluster"
  | "verify"
  | "rank";

export type JobStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "paused";

export interface Job {
  id: string;
  type: JobType;
  payload: string;
  status: JobStatus;
  result: string | null;
  error: string | null;
  attempts: number;
  max_retries: number;
  run_after: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScanProgress {
  scan_id: number;
  status: ScanStatus;
  pr_count: number;
  dupe_group_count: number;
  started_at: string;
  completed_at: string | null;
  error: string | null;
}
