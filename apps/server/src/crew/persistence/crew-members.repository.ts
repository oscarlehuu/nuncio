import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../../db/database.service';

export interface CrewMemberSessionDto {
  id: string; runId: string; memberKey: string; provider: string; model: string;
  sessionId: string | null; priorMemberSessionId: string | null; isCurrent: boolean;
  lifecycle: string; contextHealth: string; lastSeenContextRevision: number;
  lastSeenWorkspaceHead: string | null; lastUsedAt: number; createdAt: number; updatedAt: number;
}

@Injectable()
export class CrewMembersRepository {
  constructor(private readonly database: DatabaseService) {}
  replaceCurrent(input: Omit<CrewMemberSessionDto, 'id' | 'isCurrent' | 'createdAt' | 'updatedAt'>): CrewMemberSessionDto {
    return this.database.transaction(() => {
      const now = Date.now();
      this.database.db.prepare(
        `UPDATE crew_member_sessions SET is_current = 0, lifecycle = 'dormant', updated_at = ?
         WHERE run_id = ? AND member_key = ? AND is_current = 1`,
      ).run(now, input.runId, input.memberKey);
      const id = uuidv4();
      this.database.db.prepare(
        `INSERT INTO crew_member_sessions
         (id, run_id, member_key, provider, model, session_id, prior_member_session_id, is_current,
          lifecycle, context_health, last_seen_context_revision, last_seen_workspace_head,
          last_used_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, input.runId, input.memberKey, input.provider, input.model, input.sessionId,
        input.priorMemberSessionId, input.lifecycle, input.contextHealth,
        input.lastSeenContextRevision, input.lastSeenWorkspaceHead, input.lastUsedAt, now, now,
      );
      return this.require(id);
    });
  }
  listByRun(runId: string): CrewMemberSessionDto[] {
    return this.database.db.prepare<MemberRow, [string]>(
      `SELECT * FROM crew_member_sessions WHERE run_id = ?
       ORDER BY member_key ASC, created_at ASC, rowid ASC`,
    ).all(runId).map(toDto);
  }
  findCurrent(runId: string, memberKey: string): CrewMemberSessionDto | null {
    const row = this.database.db.prepare<MemberRow, [string, string]>(
      'SELECT * FROM crew_member_sessions WHERE run_id = ? AND member_key = ? AND is_current = 1',
    ).get(runId, memberKey);
    return row ? toDto(row) : null;
  }
  findBySessionId(sessionId: string): CrewMemberSessionDto | null {
    const row = this.database.db.prepare<MemberRow, [string]>(
      `SELECT m.* FROM crew_member_sessions m
       JOIN crew_runs r ON r.id = m.run_id
       WHERE m.session_id = ?
       ORDER BY CASE WHEN r.status = 'TERMINAL' THEN 1 ELSE 0 END,
                m.is_current DESC, r.updated_at DESC, m.created_at DESC LIMIT 1`,
    ).get(sessionId);
    return row ? toDto(row) : null;
  }
  attachSession(id: string, sessionId: string): CrewMemberSessionDto {
    this.database.db.prepare(
      'UPDATE crew_member_sessions SET session_id = ?, updated_at = ? WHERE id = ?',
    ).run(sessionId, Date.now(), id);
    return this.require(id);
  }
  updateSeen(id: string, contextRevision: number, workspaceHead: string | null): CrewMemberSessionDto {
    this.database.db.prepare(
      `UPDATE crew_member_sessions
       SET last_seen_context_revision = ?, last_seen_workspace_head = ?, context_health = 'healthy',
           last_used_at = ?, updated_at = ? WHERE id = ?`,
    ).run(contextRevision, workspaceHead, Date.now(), Date.now(), id);
    return this.require(id);
  }
  private require(id: string): CrewMemberSessionDto {
    const row = this.database.db.prepare<MemberRow, [string]>(
      'SELECT * FROM crew_member_sessions WHERE id = ?',
    ).get(id);
    if (!row) throw new Error(`Crew member ${id} not found after insert`);
    return toDto(row);
  }
}

interface MemberRow {
  id: string; run_id: string; member_key: string; provider: string; model: string;
  session_id: string | null; prior_member_session_id: string | null; is_current: number;
  lifecycle: string; context_health: string; last_seen_context_revision: number;
  last_seen_workspace_head: string | null; last_used_at: number; created_at: number; updated_at: number;
}
function toDto(row: MemberRow): CrewMemberSessionDto {
  return {
    id: row.id, runId: row.run_id, memberKey: row.member_key, provider: row.provider, model: row.model,
    sessionId: row.session_id, priorMemberSessionId: row.prior_member_session_id,
    isCurrent: row.is_current === 1, lifecycle: row.lifecycle, contextHealth: row.context_health,
    lastSeenContextRevision: row.last_seen_context_revision,
    lastSeenWorkspaceHead: row.last_seen_workspace_head, lastUsedAt: row.last_used_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
