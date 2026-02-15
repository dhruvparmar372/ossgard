import { z } from "zod";

export const TrackRepoRequest = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
});
export type TrackRepoRequest = z.infer<typeof TrackRepoRequest>;

export const ScanRequest = z.object({
  full: z.boolean().optional().default(false),
});
export type ScanRequest = z.infer<typeof ScanRequest>;

export const DupesQuery = z.object({
  min_score: z.coerce.number().min(0).max(100).optional(),
});
export type DupesQuery = z.infer<typeof DupesQuery>;

export const ScanProgressResponse = z.object({
  scan_id: z.number(),
  status: z.enum([
    "ingesting",
    "embedding",
    "clustering",
    "verifying",
    "ranking",
    "done",
    "failed",
    "paused",
  ]),
  pr_count: z.number(),
  dupe_group_count: z.number(),
  started_at: z.string(),
  completed_at: z.string().nullable(),
  error: z.string().nullable(),
});
export type ScanProgressResponse = z.infer<typeof ScanProgressResponse>;
