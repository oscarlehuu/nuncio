import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../db/database.service';
import type {
  CreateScheduleDto,
  FireResult,
  ScheduleDto,
  ScheduleRow,
  ScheduleTarget,
} from './scheduler.types';

function rowToDto(row: ScheduleRow): ScheduleDto {
  return {
    id: row.id,
    kind: row.kind as ScheduleDto['kind'],
    spec: row.spec,
    target: JSON.parse(row.target_json) as ScheduleTarget,
    enabled: row.enabled === 1,
    nextFireAt: row.next_fire_at,
    lastFireAt: row.last_fire_at,
    lastResult: (row.last_result as FireResult | null) ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Durable schedule state (ADR-006). Guarded against a closing DB like the rest. */
@Injectable()
export class SchedulesRepository {
  constructor(private readonly database: DatabaseService) {}

  create(input: CreateScheduleDto & { nextFireAt: number | null }): ScheduleDto {
    const now = Date.now();
    const id = uuidv4().slice(0, 8);
    this.database.db
      .prepare(
        `INSERT INTO schedules
           (id, kind, spec, target_json, enabled, next_fire_at, last_fire_at,
            last_result, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.kind,
        input.spec,
        JSON.stringify(input.target),
        input.enabled === false ? 0 : 1,
        input.nextFireAt,
        null,
        null,
        now,
        now,
      );
    return this.findById(id)!;
  }

  findById(id: string): ScheduleDto | null {
    if (this.database.closed) return null;
    const row = this.database.db
      .prepare<ScheduleRow, [string]>('SELECT * FROM schedules WHERE id = ?')
      .get(id);
    return row ? rowToDto(row) : null;
  }

  list(): ScheduleDto[] {
    if (this.database.closed) return [];
    return this.database.db
      .prepare<ScheduleRow, []>('SELECT * FROM schedules ORDER BY created_at ASC')
      .all()
      .map(rowToDto);
  }

  /** Enabled cron/heartbeat schedules with next_fire_at set and <= now. */
  listDue(now: number): ScheduleDto[] {
    if (this.database.closed) return [];
    return this.database.db
      .prepare<ScheduleRow, [number]>(
        `SELECT * FROM schedules
         WHERE enabled = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= ?
         ORDER BY next_fire_at ASC`,
      )
      .all(now)
      .map(rowToDto);
  }

  /** Enabled event schedules (fired by the webhook path, not the clock). */
  listEnabledEvents(): ScheduleDto[] {
    if (this.database.closed) return [];
    return this.database.db
      .prepare<ScheduleRow, []>(
        "SELECT * FROM schedules WHERE enabled = 1 AND kind = 'event' ORDER BY created_at ASC",
      )
      .all()
      .map(rowToDto);
  }

  setEnabled(id: string, enabled: boolean, nextFireAt: number | null): ScheduleDto {
    if (!this.database.closed) {
      this.database.db
        .prepare('UPDATE schedules SET enabled = ?, next_fire_at = ?, updated_at = ? WHERE id = ?')
        .run(enabled ? 1 : 0, nextFireAt, Date.now(), id);
    }
    return this.findById(id)!;
  }

  recordFire(id: string, at: number, result: FireResult, nextFireAt: number | null): void {
    if (this.database.closed) return;
    this.database.db
      .prepare(
        `UPDATE schedules SET last_fire_at = ?, last_result = ?, next_fire_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(at, result, nextFireAt, Date.now(), id);
  }

  setNextFire(id: string, nextFireAt: number | null): void {
    if (this.database.closed) return;
    this.database.db
      .prepare('UPDATE schedules SET next_fire_at = ?, updated_at = ? WHERE id = ?')
      .run(nextFireAt, Date.now(), id);
  }

  /** Change a schedule's kind + spec (used when a heartbeat cadence setting changes). */
  setSpec(id: string, kind: string, spec: string, nextFireAt: number | null): void {
    if (this.database.closed) return;
    this.database.db
      .prepare('UPDATE schedules SET kind = ?, spec = ?, next_fire_at = ?, updated_at = ? WHERE id = ?')
      .run(kind, spec, nextFireAt, Date.now(), id);
  }

  delete(id: string): void {
    if (this.database.closed) return;
    this.database.db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
  }
}
