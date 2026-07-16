import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../db/database.service';
import type {
  HeartbeatHealthDto,
  HeartbeatHealthOutcome,
  HeartbeatHealthRow,
  HeartbeatJob,
} from './heartbeat.types';

function rowToDto(row: HeartbeatHealthRow): HeartbeatHealthDto {
  return {
    job: row.job as HeartbeatJob,
    lastRunAt: row.last_run_at,
    outcome: row.outcome as HeartbeatHealthOutcome,
    detail: row.detail,
  };
}

/**
 * Durable last-run health per system job (infra / reconcile / digest). One row
 * per job (job is the PRIMARY KEY), upserted on every dispatch — so a swallowed
 * layer failure leaves an `error`/`timeout` fact instead of vanishing. Read-only
 * observability for the Settings health block; it never feeds the attention
 * queue. Closed-guarded like every repo.
 */
@Injectable()
export class HeartbeatHealthRepository {
  constructor(private readonly database: DatabaseService) {}

  /** Upsert the last-run record for a job. Detail is truncated to keep the row small. */
  record(job: string, outcome: HeartbeatHealthOutcome, detail: string | null, at: number): void {
    if (this.database.closed) return;
    this.database.db
      .prepare(
        `INSERT INTO heartbeat_health (job, last_run_at, outcome, detail, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(job) DO UPDATE SET
           last_run_at = excluded.last_run_at,
           outcome = excluded.outcome,
           detail = excluded.detail,
           updated_at = excluded.updated_at`,
      )
      .run(job, at, outcome, detail ? detail.slice(0, 500) : null, at);
  }

  /** All job health rows, ordered by job for a stable read. */
  list(): HeartbeatHealthDto[] {
    if (this.database.closed) return [];
    return this.database.db
      .prepare<HeartbeatHealthRow, []>('SELECT * FROM heartbeat_health ORDER BY job ASC')
      .all()
      .map(rowToDto);
  }

  findByJob(job: string): HeartbeatHealthDto | null {
    if (this.database.closed) return null;
    const row = this.database.db
      .prepare<HeartbeatHealthRow, [string]>('SELECT * FROM heartbeat_health WHERE job = ?')
      .get(job);
    return row ? rowToDto(row) : null;
  }
}
