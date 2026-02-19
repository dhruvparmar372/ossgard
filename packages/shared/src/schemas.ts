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

export const AccountConfigSchema = z.object({
  github: z.object({ token: z.string().min(1) }),
  llm: z.object({
    provider: z.string().min(1),
    url: z.string(),
    model: z.string().min(1),
    api_key: z.string(),
    batch: z.boolean().optional(),
  }),
  embedding: z.object({
    provider: z.string().min(1),
    url: z.string(),
    model: z.string().min(1),
    api_key: z.string(),
    batch: z.boolean().optional(),
  }),
  vector_store: z.object({
    url: z.string().min(1),
    api_key: z.string(),
  }),
  scan: z.object({
    concurrency: z.number().optional(),
    candidate_threshold: z.number().optional(),
    max_candidates_per_pr: z.number().optional(),
  }).optional(),
});
export type AccountConfigSchema = z.infer<typeof AccountConfigSchema>;

export const RegisterAccountRequest = z.object({
  label: z.string().optional(),
  config: AccountConfigSchema,
});
export type RegisterAccountRequest = z.infer<typeof RegisterAccountRequest>;

export const PatchAccountConfig = z.object({
  config: z.object({
    github: z.object({ token: z.string().min(1) }).partial().optional(),
    llm: z.object({
      provider: z.string().min(1),
      url: z.string(),
      model: z.string().min(1),
      api_key: z.string(),
      batch: z.boolean().optional(),
    }).partial().optional(),
    embedding: z.object({
      provider: z.string().min(1),
      url: z.string(),
      model: z.string().min(1),
      api_key: z.string(),
      batch: z.boolean().optional(),
    }).partial().optional(),
    vector_store: z.object({
      url: z.string().min(1),
      api_key: z.string(),
    }).partial().optional(),
    scan: z.object({
      concurrency: z.number().optional(),
      candidate_threshold: z.number().optional(),
      max_candidates_per_pr: z.number().optional(),
    }).partial().optional(),
  }),
});
export type PatchAccountConfig = z.infer<typeof PatchAccountConfig>;

export const ScanProgressResponse = z.object({
  scanId: z.number(),
  status: z.enum([
    "queued",
    "ingesting",
    "embedding",
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
