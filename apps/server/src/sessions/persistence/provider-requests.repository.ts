import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../db/database.service';
import type {
  ProviderRequestDecision,
  ProviderRequestRecord,
  ProviderRequestRow,
} from '../domain/sessions.types';

function parseParams(raw: string | null): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function stringifyParams(params: unknown): string | null {
  return params === undefined ? null : JSON.stringify(params);
}

function toRecord(row: ProviderRequestRow): ProviderRequestRecord {
  const params = parseParams(row.params_json);
  return {
    requestId: row.request_id,
    sessionId: row.session_id,
    provider: row.provider,
    method: row.method,
    ...(params !== undefined ? { params } : {}),
    status: row.status === 'resolved' ? 'resolved' : 'pending',
    decision:
      row.decision === 'approve' || row.decision === 'deny' ? row.decision : null,
    reason: row.reason,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

@Injectable()
export class ProviderRequestsRepository {
  constructor(private readonly database: DatabaseService) {}

  create(input: {
    requestId: string;
    sessionId: string;
    provider: string;
    method: string;
    params?: unknown;
  }): ProviderRequestRecord {
    const now = Date.now();
    this.database.db
      .prepare(
        `INSERT INTO provider_requests (
          request_id, session_id, provider, method, params_json,
          status, decision, reason, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL)`,
      )
      .run(
        input.requestId,
        input.sessionId,
        input.provider,
        input.method,
        stringifyParams(input.params),
        now,
      );
    return this.findById(input.requestId)!;
  }

  findById(requestId: string): ProviderRequestRecord | null {
    const row = this.database.db
      .prepare<ProviderRequestRow, [string]>(
        'SELECT * FROM provider_requests WHERE request_id = ?',
      )
      .get(requestId);
    return row ? toRecord(row) : null;
  }

  findPending(sessionId: string, requestId: string): ProviderRequestRecord | null {
    const row = this.database.db
      .prepare<ProviderRequestRow, [string, string]>(
        `SELECT * FROM provider_requests
         WHERE session_id = ? AND request_id = ? AND status = 'pending'`,
      )
      .get(sessionId, requestId);
    return row ? toRecord(row) : null;
  }

  listPending(): ProviderRequestRecord[] {
    const rows = this.database.db
      .prepare<ProviderRequestRow, []>(
        "SELECT * FROM provider_requests WHERE status = 'pending' ORDER BY created_at ASC",
      )
      .all();
    return rows.map(toRecord);
  }

  listPendingForSession(sessionId: string): ProviderRequestRecord[] {
    const rows = this.database.db
      .prepare<ProviderRequestRow, [string]>(
        `SELECT * FROM provider_requests
         WHERE session_id = ? AND status = 'pending'
         ORDER BY created_at ASC`,
      )
      .all(sessionId);
    return rows.map(toRecord);
  }

  resolve(
    requestId: string,
    decision: ProviderRequestDecision,
    reason?: string,
  ): ProviderRequestRecord | null {
    const current = this.findById(requestId);
    if (!current || current.status !== 'pending') return null;
    const now = Date.now();
    this.database.db
      .prepare(
        `UPDATE provider_requests
         SET status = 'resolved', decision = ?, reason = ?, resolved_at = ?
         WHERE request_id = ? AND status = 'pending'`,
      )
      .run(decision, reason ?? null, now, requestId);
    return this.findById(requestId);
  }

  resolvePendingForSession(
    sessionId: string,
    decision: ProviderRequestDecision,
    reason: string,
  ): ProviderRequestRecord[] {
    const pending = this.listPendingForSession(sessionId);
    return this.resolveBatch(pending, decision, reason);
  }

  resolveAllPending(
    decision: ProviderRequestDecision,
    reason: string,
  ): ProviderRequestRecord[] {
    return this.resolveBatch(this.listPending(), decision, reason);
  }

  deleteForSession(sessionId: string): void {
    this.database.db
      .prepare('DELETE FROM provider_requests WHERE session_id = ?')
      .run(sessionId);
  }

  private resolveBatch(
    pending: ProviderRequestRecord[],
    decision: ProviderRequestDecision,
    reason: string,
  ): ProviderRequestRecord[] {
    if (pending.length === 0) return [];
    const now = Date.now();
    const update = this.database.db.prepare(
      `UPDATE provider_requests
       SET status = 'resolved', decision = ?, reason = ?, resolved_at = ?
       WHERE request_id = ? AND status = 'pending'`,
    );
    const tx = this.database.db.transaction(() => {
      for (const request of pending) {
        update.run(decision, reason, now, request.requestId);
      }
    });
    tx();
    return pending
      .map((request) => this.findById(request.requestId))
      .filter((request): request is ProviderRequestRecord => request !== null);
  }
}
