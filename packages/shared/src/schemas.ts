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
  minScore: z.coerce.number().min(0).max(100).optional(),
});
export type DupesQuery = z.infer<typeof DupesQuery>;

export const ScanProgressResponse = z.object({
  scanId: z.number(),
  status: z.enum([
    "queued",
    "ingesting",
    "embedding",
    "clustering",
    "verifying",
    "ranking",
    "done",
    "failed",
    "paused",
  ]),
  phase: z.string(),
  progress: z
    .object({
      current: z.number(),
      total: z.number(),
    })
    .nullable(),
  dupeGroupCount: z.number(),
});
export type ScanProgressResponse = z.infer<typeof ScanProgressResponse>;
