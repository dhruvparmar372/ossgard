import { v4 as uuidv4 } from "uuid";
import type BetterSqlite3 from "better-sqlite3";
import type { Job } from "@ossgard/shared";
import type { JobQueue, EnqueueOptions } from "./types.js";

interface JobRow {
  id: string;
  type: string;
  payload: string;
  status: string;
  result: string | null;
  error: string | null;
  attempts: number;
  max_retries: number;
  run_after: string | null;
  created_at: string;
  updated_at: string;
}

/** Convert an ISO-8601 string or SQLite datetime to SQLite datetime format (YYYY-MM-DD HH:MM:SS). */
function toSqliteDatetime(iso: string): string {
  // Parse with Date to normalize, then format as SQLite datetime
  const d = new Date(iso);
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

function mapJobRow(row: JobRow): Job {
  return {
    id: row.id,
    type: row.type as Job["type"],
    payload: JSON.parse(row.payload),
    status: row.status as Job["status"],
    result: row.result ? JSON.parse(row.result) : null,
    error: row.error,
    attempts: row.attempts,
    maxRetries: row.max_retries,
    runAfter: row.run_after,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class LocalJobQueue implements JobQueue {
  private db: BetterSqlite3.Database;

  constructor(db: BetterSqlite3.Database) {
    this.db = db;
  }

  async enqueue(opts: EnqueueOptions): Promise<string> {
    const id = uuidv4();
    const stmt = this.db.prepare(`
      INSERT INTO jobs (id, type, payload, status, max_retries, run_after)
      VALUES (?, ?, ?, 'queued', ?, ?)
    `);
    stmt.run(
      id,
      opts.type,
      JSON.stringify(opts.payload),
      opts.maxRetries ?? 3,
      opts.runAfter ? toSqliteDatetime(opts.runAfter) : null
    );
    return id;
  }

  async getStatus(jobId: string): Promise<Job | null> {
    const stmt = this.db.prepare("SELECT * FROM jobs WHERE id = ?");
    const row = stmt.get(jobId) as JobRow | undefined;
    return row ? mapJobRow(row) : null;
  }

  async dequeue(): Promise<Job | null> {
    const stmt = this.db.prepare(`
      UPDATE jobs
      SET status = 'running',
          attempts = attempts + 1,
          updated_at = datetime('now')
      WHERE id = (
        SELECT id FROM jobs
        WHERE status = 'queued'
          AND (run_after IS NULL OR run_after <= datetime('now'))
        ORDER BY created_at ASC
        LIMIT 1
      )
      RETURNING *
    `);
    const row = stmt.get() as JobRow | undefined;
    return row ? mapJobRow(row) : null;
  }

  async complete(
    jobId: string,
    result?: Record<string, unknown>
  ): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE jobs
      SET status = 'done',
          result = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `);
    stmt.run(result ? JSON.stringify(result) : null, jobId);
  }

  async fail(jobId: string, error: string): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE jobs
      SET status = 'failed',
          error = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `);
    stmt.run(error, jobId);
  }

  async pause(jobId: string, runAfter: Date): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE jobs
      SET status = 'queued',
          run_after = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `);
    stmt.run(toSqliteDatetime(runAfter.toISOString()), jobId);
  }
}
