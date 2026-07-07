import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../db/database.service';
import type {
  ContextFactProposalDto,
  ContextFactProposalRow,
  ProposalStatus,
} from './context-facts.types';

function toDto(row: ContextFactProposalRow): ContextFactProposalDto {
  const status: ProposalStatus =
    row.status === 'accepted' ? 'accepted' : row.status === 'dismissed' ? 'dismissed' : 'pending';
  return {
    id: row.id,
    projectPath: row.project_path,
    key: row.key,
    proposedValue: row.proposed_value,
    sourceSessionId: row.source_session_id ?? null,
    status,
    createdAt: row.created_at,
  };
}

@Injectable()
export class ContextFactProposalsRepository {
  constructor(private readonly database: DatabaseService) {}

  /** Create a pending proposal unless an identical pending one (same key+value) already exists. */
  propose(input: {
    projectPath: string;
    key: string;
    proposedValue: string;
    sourceSessionId?: string | null;
  }): ContextFactProposalDto {
    const existing = this.database.db
      .prepare<ContextFactProposalRow, [string, string, string]>(
        `SELECT * FROM context_fact_proposals
         WHERE project_path = ? AND key = ? AND proposed_value = ? AND status = 'pending'
         LIMIT 1`,
      )
      .get(input.projectPath, input.key, input.proposedValue);
    if (existing) return toDto(existing);

    const id = uuidv4().slice(0, 8);
    const now = Date.now();
    this.database.db
      .prepare(
        `INSERT INTO context_fact_proposals
           (id, project_path, key, proposed_value, source_session_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(id, input.projectPath, input.key, input.proposedValue, input.sourceSessionId ?? null, now);
    return this.get(id)!;
  }

  listPending(projectPath: string): ContextFactProposalDto[] {
    const rows = this.database.db
      .prepare<ContextFactProposalRow, [string]>(
        `SELECT * FROM context_fact_proposals
         WHERE project_path = ? AND status = 'pending' ORDER BY created_at DESC`,
      )
      .all(projectPath);
    return rows.map(toDto);
  }

  get(id: string): ContextFactProposalDto | null {
    const row = this.database.db
      .prepare<ContextFactProposalRow, [string]>('SELECT * FROM context_fact_proposals WHERE id = ?')
      .get(id);
    return row ? toDto(row) : null;
  }

  /** Flip a still-pending proposal to a terminal status; false when not pending / missing. */
  setStatus(id: string, status: 'accepted' | 'dismissed'): ContextFactProposalDto | null {
    const row = this.database.db
      .prepare<ContextFactProposalRow, [string, string]>(
        `UPDATE context_fact_proposals SET status = ?
         WHERE id = ? AND status = 'pending' RETURNING *`,
      )
      .get(status, id);
    return row ? toDto(row) : null;
  }
}
