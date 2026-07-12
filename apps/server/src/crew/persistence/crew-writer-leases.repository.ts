import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../db/database.service';

export interface CrewWriterLeaseDto {
  runId: string; memberSessionId: string; taskId: string | null; token: string;
  startingHead: string | null; acquiredAt: number;
}

@Injectable()
export class CrewWriterLeasesRepository {
  constructor(private readonly database: DatabaseService) {}
  acquire(input: Omit<CrewWriterLeaseDto, 'acquiredAt'>): CrewWriterLeaseDto {
    const lease = { ...input, acquiredAt: Date.now() };
    this.database.db.prepare(
      `INSERT INTO crew_writer_leases
       (run_id, member_session_id, task_id, token, starting_head, acquired_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(lease.runId, lease.memberSessionId, lease.taskId, lease.token, lease.startingHead, lease.acquiredAt);
    return lease;
  }
  get(runId: string): CrewWriterLeaseDto | null {
    const row = this.database.db.prepare<LeaseRow, [string]>(
      'SELECT * FROM crew_writer_leases WHERE run_id = ?',
    ).get(runId);
    return row ? {
      runId: row.run_id, memberSessionId: row.member_session_id, taskId: row.task_id,
      token: row.token, startingHead: row.starting_head, acquiredAt: row.acquired_at,
    } : null;
  }
  release(runId: string, token: string): boolean {
    return this.database.db.prepare(
      'DELETE FROM crew_writer_leases WHERE run_id = ? AND token = ?',
    ).run(runId, token).changes > 0;
  }
}
interface LeaseRow {
  run_id: string; member_session_id: string; task_id: string | null;
  token: string; starting_head: string | null; acquired_at: number;
}
