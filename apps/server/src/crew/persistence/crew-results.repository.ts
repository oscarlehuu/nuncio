import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../../db/database.service';
import type { CrewMemberResult } from '../domain/crew-results';
import type { CrewRunPhase } from '../domain/crew.types';

export interface CrewMemberResultDto {
  id: string; runId: string; memberSessionId: string; phase: CrewRunPhase; attempt: number;
  result: CrewMemberResult; basedOnContextRevision: number; workspaceHead: string | null; createdAt: number;
}

@Injectable()
export class CrewResultsRepository {
  constructor(private readonly database: DatabaseService) {}
  create(input: Omit<CrewMemberResultDto, 'id' | 'createdAt'>): CrewMemberResultDto {
    return this.insert({ ...input, id: uuidv4(), createdAt: Date.now() });
  }
  createIdempotent(
    input: Omit<CrewMemberResultDto, 'id' | 'createdAt'>,
    idempotencyKey: string,
  ): { result: CrewMemberResultDto; created: boolean } {
    const id = idempotentResultId(input.runId, idempotencyKey);
    const existing = this.findById(id);
    if (existing) return { result: existing, created: false };
    try {
      return { result: this.insert({ ...input, id, createdAt: Date.now() }), created: true };
    } catch (error) {
      const raced = this.findById(id);
      if (raced) return { result: raced, created: false };
      throw error;
    }
  }
  findById(id: string): CrewMemberResultDto | null {
    const row = this.database.db.prepare<ResultRow, [string]>(
      'SELECT * FROM crew_member_results WHERE id = ?',
    ).get(id);
    return row ? toDto(row) : null;
  }
  findIdempotent(runId: string, idempotencyKey: string): CrewMemberResultDto | null {
    return this.findById(idempotentResultId(runId, idempotencyKey));
  }
  private insert(dto: CrewMemberResultDto): CrewMemberResultDto {
    this.database.db.prepare(
      `INSERT INTO crew_member_results
       (id, run_id, member_session_id, phase, attempt, result_json,
        based_on_context_revision, workspace_head, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      dto.id, dto.runId, dto.memberSessionId, dto.phase, dto.attempt, JSON.stringify(dto.result),
      dto.basedOnContextRevision, dto.workspaceHead, dto.createdAt,
    );
    return dto;
  }
  listByRun(runId: string): CrewMemberResultDto[] {
    return this.database.db.prepare<ResultRow, [string]>(
      'SELECT * FROM crew_member_results WHERE run_id = ? ORDER BY created_at, rowid',
    ).all(runId).map(toDto);
  }
}

interface ResultRow {
  id: string; run_id: string; member_session_id: string; phase: CrewRunPhase; attempt: number;
  result_json: string; based_on_context_revision: number; workspace_head: string | null; created_at: number;
}
function toDto(row: ResultRow): CrewMemberResultDto {
  return {
    id: row.id, runId: row.run_id, memberSessionId: row.member_session_id, phase: row.phase,
    attempt: row.attempt, result: JSON.parse(row.result_json) as CrewMemberResult,
    basedOnContextRevision: row.based_on_context_revision, workspaceHead: row.workspace_head,
    createdAt: row.created_at,
  };
}
function idempotentResultId(runId: string, key: string): string {
  return `idem-${createHash('sha256').update(`${runId}\0${key}`).digest('hex')}`;
}
