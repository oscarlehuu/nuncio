import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../db/database.service';
import type {
  LoopDto,
  LoopRow,
  LoopRunDto,
  LoopRunOutcome,
  LoopRunRow,
  LoopRunVerify,
  LoopStatus,
  StopCondition,
} from './loops.types';

function loopRowToDto(row: LoopRow): LoopDto {
  return {
    id: row.id,
    name: row.name ?? null,
    goal: row.goal,
    scheduleId: row.schedule_id,
    maxRunsPerDay: row.max_runs_per_day,
    maxConsecutiveFailures: row.max_consecutive_failures,
    stop: row.stop_json ? (JSON.parse(row.stop_json) as StopCondition) : null,
    escalation: row.escalation,
    projectPath: row.project_path,
    engine: row.engine ?? null,
    status: row.status as LoopStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function runRowToDto(row: LoopRunRow): LoopRunDto {
  return {
    id: row.id,
    loopId: row.loop_id,
    taskId: row.task_id,
    outcome: row.outcome as LoopRunOutcome,
    verify: row.verify as LoopRunVerify,
    dayBucket: row.day_bucket,
    createdAt: row.created_at,
  };
}

/** Durable loops + loop_runs (ADR-006). Guarded against a closing DB like the rest. */
@Injectable()
export class LoopsRepository {
  constructor(private readonly database: DatabaseService) {}

  create(input: {
    name?: string | null;
    goal: string;
    scheduleId: string;
    maxRunsPerDay: number;
    maxConsecutiveFailures: number;
    stopJson: string | null;
    escalation: string;
    projectPath: string | null;
    engine?: string | null;
  }): LoopDto {
    const now = Date.now();
    const id = uuidv4().slice(0, 8);
    this.database.db
      .prepare(
        `INSERT INTO loops
           (id, name, goal, schedule_id, max_runs_per_day, max_consecutive_failures,
            stop_json, escalation, project_path, engine, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        id,
        input.name ?? null,
        input.goal,
        input.scheduleId,
        input.maxRunsPerDay,
        input.maxConsecutiveFailures,
        input.stopJson,
        input.escalation,
        input.projectPath,
        input.engine ?? null,
        now,
        now,
      );
    return this.findById(id)!;
  }

  /** Patch a subset of loop fields (v1.1). Only provided keys are updated. */
  update(id: string, patch: {
    name?: string | null;
    goal?: string;
    maxRunsPerDay?: number;
    maxConsecutiveFailures?: number;
    stopJson?: string | null;
    engine?: string | null;
  }): LoopDto | null {
    if (this.database.closed) return this.findById(id);
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.name !== undefined) { sets.push('name = ?'); args.push(patch.name); }
    if (patch.goal !== undefined) { sets.push('goal = ?'); args.push(patch.goal); }
    if (patch.maxRunsPerDay !== undefined) { sets.push('max_runs_per_day = ?'); args.push(patch.maxRunsPerDay); }
    if (patch.maxConsecutiveFailures !== undefined) { sets.push('max_consecutive_failures = ?'); args.push(patch.maxConsecutiveFailures); }
    if (patch.stopJson !== undefined) { sets.push('stop_json = ?'); args.push(patch.stopJson); }
    if (patch.engine !== undefined) { sets.push('engine = ?'); args.push(patch.engine); }
    if (sets.length === 0) return this.findById(id);
    sets.push('updated_at = ?');
    args.push(Date.now(), id);
    this.database.db.prepare(`UPDATE loops SET ${sets.join(', ')} WHERE id = ?`).run(...(args as never[]));
    return this.findById(id);
  }

  findById(id: string): LoopDto | null {
    if (this.database.closed) return null;
    const row = this.database.db
      .prepare<LoopRow, [string]>('SELECT * FROM loops WHERE id = ?')
      .get(id);
    return row ? loopRowToDto(row) : null;
  }

  list(): LoopDto[] {
    if (this.database.closed) return [];
    return this.database.db
      .prepare<LoopRow, []>('SELECT * FROM loops ORDER BY created_at ASC')
      .all()
      .map(loopRowToDto);
  }

  setStatus(id: string, status: LoopStatus): LoopDto {
    if (!this.database.closed) {
      this.database.db
        .prepare('UPDATE loops SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, Date.now(), id);
    }
    return this.findById(id)!;
  }

  setScheduleId(id: string, scheduleId: string): void {
    if (this.database.closed) return;
    this.database.db
      .prepare('UPDATE loops SET schedule_id = ?, updated_at = ? WHERE id = ?')
      .run(scheduleId, Date.now(), id);
  }

  delete(id: string): void {
    if (this.database.closed) return;
    // Run history is KEPT (founder-locked): only the loop row is removed.
    this.database.db.prepare('DELETE FROM loops WHERE id = ?').run(id);
  }

  appendRun(input: {
    loopId: string;
    taskId: string | null;
    outcome: LoopRunOutcome;
    verify?: LoopRunVerify;
    dayBucket: string;
  }): LoopRunDto {
    const id = uuidv4().slice(0, 8);
    const now = Date.now();
    this.database.db
      .prepare(
        `INSERT INTO loop_runs (id, loop_id, task_id, outcome, verify, day_bucket, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.loopId, input.taskId, input.outcome, input.verify ?? 'none', input.dayBucket, now);
    return this.getRun(id)!;
  }

  /** Update a run's terminal outcome/verify once its task settles. */
  updateRunOutcome(runId: string, outcome: LoopRunOutcome, verify: LoopRunVerify): void {
    if (this.database.closed) return;
    this.database.db
      .prepare('UPDATE loop_runs SET outcome = ?, verify = ? WHERE id = ?')
      .run(outcome, verify, runId);
  }

  getRun(id: string): LoopRunDto | null {
    if (this.database.closed) return null;
    const row = this.database.db
      .prepare<LoopRunRow, [string]>('SELECT * FROM loop_runs WHERE id = ?')
      .get(id);
    return row ? runRowToDto(row) : null;
  }

  listRuns(loopId: string): LoopRunDto[] {
    if (this.database.closed) return [];
    return this.database.db
      .prepare<LoopRunRow, [string]>('SELECT * FROM loop_runs WHERE loop_id = ? ORDER BY created_at ASC')
      .all(loopId)
      .map(runRowToDto);
  }
}
