import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../db/database.service';
import type {
  ContextFactProposalDto,
  ContextFactProposalRow,
  ProposalStatus,
} from './context-facts.types';

/** Max pending proposals kept per (project, key); the oldest is evicted past this. */
const PENDING_PER_KEY_CAP = 3;

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
  }): { proposal: ContextFactProposalDto; replaced: boolean } {
    // Exact dedupe: an identical pending proposal is not re-created.
    const duplicate = this.database.db
      .prepare<ContextFactProposalRow, [string, string, string]>(
        `SELECT * FROM context_fact_proposals
         WHERE project_path = ? AND key = ? AND proposed_value = ? AND status = 'pending'
         LIMIT 1`,
      )
      .get(input.projectPath, input.key, input.proposedValue);
    if (duplicate) return { proposal: toDto(duplicate), replaced: false };

    // Bound the pending proposals per (project,key) at the cap: when full, the
    // OLDEST pending proposal for this key is evicted so the newest intent wins
    // and the count never grows unbounded from distinct spammed values.
    const pending = this.database.db
      .prepare<ContextFactProposalRow, [string, string]>(
        `SELECT * FROM context_fact_proposals
         WHERE project_path = ? AND key = ? AND status = 'pending'
         ORDER BY created_at ASC`,
      )
      .all(input.projectPath, input.key);
    let replaced = false;
    if (pending.length >= PENDING_PER_KEY_CAP) {
      const oldest = pending[0]!;
      this.database.db.prepare('DELETE FROM context_fact_proposals WHERE id = ?').run(oldest.id);
      replaced = true;
    }

    const id = uuidv4().slice(0, 8);
    const now = Date.now();
    this.database.db
      .prepare(
        `INSERT INTO context_fact_proposals
           (id, project_path, key, proposed_value, source_session_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(id, input.projectPath, input.key, input.proposedValue, input.sourceSessionId ?? null, now);
    return { proposal: this.get(id)!, replaced };
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
