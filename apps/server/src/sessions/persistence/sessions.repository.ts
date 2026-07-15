import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../../db/database.service';
import {
  parseAgentRuntimePolicy,
  stringifyAgentRuntimePolicy,
} from '../../agents/agent-runtime-policy';
import {
  parseModelOptionsJson,
  stringifyModelOptions,
  type ModelOptionsMap,
} from '../../models/model-options.types';
import { assertTransition } from '../domain/sessions.fsm';
import type { CreateSessionDto, SessionDto, SessionRow, SessionStatus } from '../domain/sessions.types';

export const PULL_REQUEST_ADOPTION_LEASE_MS = 30_000;

function parseProviderStateJson(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringifyProviderState(state: Record<string, unknown> | null | undefined): string | null {
  if (!state || Object.keys(state).length === 0) return null;
  return JSON.stringify(state);
}

function parsePullRequestNumber(raw: number | string | null): number | null {
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseVerifyOwner(raw: string): 'session' | 'crew' {
  if (raw === 'session' || raw === 'crew') return raw;
  throw new Error(`Stored session verify owner is invalid: ${raw}`);
}

function toDto(row: SessionRow): SessionDto {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    provider: row.provider,
    model: row.model,
    modelOptions: parseModelOptionsJson(row.model_options),
    workspace: row.workspace ?? null,
    prompt: row.prompt,
    preview: row.preview,
    projectPath: row.project_path,
    baseBranch: row.base_branch,
    worktreePath: row.worktree_path,
    branch: row.branch,
    providerThreadId: row.provider_thread_id ?? null,
    providerActiveTurnId: row.provider_active_turn_id ?? null,
    providerState: parseProviderStateJson(row.provider_state_json),
    runtimePolicy: parseAgentRuntimePolicy(row.runtime_policy_json),
    verifyOwner: parseVerifyOwner(row.verify_owner),
    cursorBackend: row.cursor_backend === 'cli' ? 'cli' : row.cursor_backend === 'sdk' ? 'sdk' : null,
    cursorChatId: row.cursor_chat_id ?? null,
    forgeProvider: row.forge_provider ?? null,
    pullRequestUrl: row.pull_request_url ?? null,
    pullRequestNumber: parsePullRequestNumber(row.pull_request_number),
    pullRequestState: row.pull_request_state ?? null,
    forgeStatus: row.forge_status ?? 'none',
    supportsInteraction: false,
    supportsInterrupt: false,
    supportsSteerWhileRunning: false,
    supportsImages: false,
    pendingInput: false,
    parentSessionId: row.parent_session_id ?? null,
    originTaskId: row.origin_task_id ?? null,
    priorSessionId: row.prior_session_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function titleFromPrompt(prompt: string): string {
  const line = (prompt.split('\n')[0] ?? '').trim();
  return line || 'Untitled session';
}

@Injectable()
export class SessionsRepository {
  constructor(private readonly database: DatabaseService) {}

  list(includeArchived = false): SessionDto[] {
    const sql = includeArchived
      ? 'SELECT * FROM sessions ORDER BY updated_at DESC'
      : "SELECT * FROM sessions WHERE status != 'ARCHIVED' ORDER BY updated_at DESC";
    const rows = this.database.db.prepare<SessionRow, []>(sql).all();
    return rows.map(toDto);
  }

  /** Public projections omit internal Crew member sessions by construction. */
  listUserFacing(includeArchived = false): SessionDto[] {
    const sql = includeArchived
      ? "SELECT * FROM sessions WHERE verify_owner = 'session' ORDER BY updated_at DESC"
      : "SELECT * FROM sessions WHERE verify_owner = 'session' AND status != 'ARCHIVED' ORDER BY updated_at DESC";
    const rows = this.database.db.prepare<SessionRow, []>(sql).all();
    return rows.map(toDto);
  }

  findById(id: string): SessionDto | null {
    // Once the DB is closing, an in-flight agent turn that outlived shutdown must
    // not touch the handle. Returning null makes the provider's runOrSteer
    // continuation bail cleanly (it treats "session gone" as a no-op) instead of
    // hitting SQLITE_MISUSE on a closed connection.
    if (this.database.closed) return null;
    const row = this.database.db
      .prepare<SessionRow, [string]>('SELECT * FROM sessions WHERE id = ?')
      .get(id);
    return row ? toDto(row) : null;
  }

  findByCursorChatId(chatId: string, backend: 'cli' | 'sdk' = 'cli'): SessionDto | null {
    const row = this.database.db
      .prepare<SessionRow, [string, string]>(
        'SELECT * FROM sessions WHERE cursor_chat_id = ? AND cursor_backend = ? LIMIT 1',
      )
      .get(chatId, backend);
    return row ? toDto(row) : null;
  }

  findByProviderThreadId(providerThreadId: string): SessionDto | null {
    const row = this.database.db
      .prepare<SessionRow, [string]>(
        'SELECT * FROM sessions WHERE provider_thread_id = ? LIMIT 1',
      )
      .get(providerThreadId);
    return row ? toDto(row) : null;
  }

  findByProjectPullRequest(
    projectPath: string,
    pullRequestNumber: number,
    options: { includeArchived?: boolean } = {},
  ): SessionDto | null {
    const archivedFilter = options.includeArchived ? '' : "AND status != 'ARCHIVED'";
    const row = this.database.db
      .prepare<SessionRow, [string, number]>(
        `SELECT * FROM sessions
         WHERE project_path = ? AND pull_request_number = ?
           ${archivedFilter} AND verify_owner = 'session'
         ORDER BY (status = 'ARCHIVED') ASC, updated_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(projectPath, pullRequestNumber);
    return row ? toDto(row) : null;
  }

  claimPullRequestAdoption(
    projectPath: string,
    pullRequestNumber: number,
    claimToken: string,
  ):
    | { status: 'claimed' }
    | { status: 'existing'; sessionId: string }
    | { status: 'pending' } {
    return this.database.immediateTransaction(() => {
      const active = this.database.db
        .prepare<{ id: string }, [string, number]>(
          `SELECT id FROM sessions
           WHERE project_path = ? AND pull_request_number = ?
             AND status != 'ARCHIVED' AND verify_owner = 'session'
           ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
        )
        .get(projectPath, pullRequestNumber);
      if (active) return { status: 'existing' as const, sessionId: active.id };

      const now = Date.now();
      const leaseExpiresAt = now + PULL_REQUEST_ADOPTION_LEASE_MS;
      const inserted = this.database.db
        .prepare(
          `INSERT OR IGNORE INTO forge_pr_session_claims
           (project_path, pull_request_number, claim_token, session_id, created_at, lease_expires_at)
           VALUES (?, ?, ?, NULL, ?, ?)`,
        )
        .run(projectPath, pullRequestNumber, claimToken, now, leaseExpiresAt);
      if (inserted.changes > 0) return { status: 'claimed' as const };

      const claim = this.database.db
        .prepare<
          { claim_token: string; session_id: string | null; lease_expires_at: number | null },
          [string, number]
        >(
          `SELECT claim_token, session_id, lease_expires_at FROM forge_pr_session_claims
           WHERE project_path = ? AND pull_request_number = ?`,
        )
        .get(projectPath, pullRequestNumber)!;
      if (claim.session_id) {
        const owner = this.database.db
          .prepare<{ status: SessionStatus }, [string, string, number]>(
            `SELECT status FROM sessions
             WHERE id = ? AND project_path = ? AND pull_request_number = ?
               AND verify_owner = 'session'`,
          )
          .get(claim.session_id, projectPath, pullRequestNumber);
        if (owner && owner.status !== 'ARCHIVED') {
          return { status: 'existing' as const, sessionId: claim.session_id };
        }
      }
      if (claim.session_id) {
        this.database.db
          .prepare(
            `UPDATE forge_pr_session_claims
             SET claim_token = ?, session_id = NULL, created_at = ?, lease_expires_at = ?
             WHERE project_path = ? AND pull_request_number = ?`,
          )
          .run(claimToken, now, leaseExpiresAt, projectPath, pullRequestNumber);
        return { status: 'claimed' as const };
      }
      if ((claim.lease_expires_at ?? 0) <= now) {
        this.database.db
          .prepare(
            `UPDATE forge_pr_session_claims
             SET claim_token = ?, created_at = ?, lease_expires_at = ?
             WHERE project_path = ? AND pull_request_number = ? AND session_id IS NULL`,
          )
          .run(claimToken, now, leaseExpiresAt, projectPath, pullRequestNumber);
        return { status: 'claimed' as const };
      }
      return { status: 'pending' as const };
    });
  }

  renewPullRequestAdoption(
    projectPath: string,
    pullRequestNumber: number,
    claimToken: string,
  ): boolean {
    const renewed = this.database.db
      .prepare(
        `UPDATE forge_pr_session_claims SET lease_expires_at = ?
         WHERE project_path = ? AND pull_request_number = ?
           AND claim_token = ? AND session_id IS NULL`,
      )
      .run(
        Date.now() + PULL_REQUEST_ADOPTION_LEASE_MS,
        projectPath,
        pullRequestNumber,
        claimToken,
      );
    return renewed.changes === 1;
  }

  completePullRequestAdoption(
    projectPath: string,
    pullRequestNumber: number,
    claimToken: string,
    sessionId: string,
    state: {
      forgeProvider: string;
      pullRequestUrl: string;
      pullRequestState: string;
      forgeStatus: string;
    },
  ): void {
    this.database.transaction(() => {
      const claim = this.database.db
        .prepare<{ claim_token: string; session_id: string | null }, [string, number]>(
          `SELECT claim_token, session_id FROM forge_pr_session_claims
           WHERE project_path = ? AND pull_request_number = ?`,
        )
        .get(projectPath, pullRequestNumber);
      if (!claim || claim.claim_token !== claimToken || claim.session_id !== null) {
        throw new Error('Pull request adoption claim is no longer owned by this request');
      }
      const updated = this.database.db
        .prepare(
          `UPDATE sessions SET forge_provider = ?, pull_request_url = ?,
           pull_request_number = ?, pull_request_state = ?, forge_status = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          state.forgeProvider,
          state.pullRequestUrl,
          pullRequestNumber,
          state.pullRequestState,
          state.forgeStatus,
          Date.now(),
          sessionId,
        );
      if (updated.changes !== 1) throw new Error(`Session ${sessionId} not found`);
      this.database.db
        .prepare(
          `UPDATE forge_pr_session_claims SET session_id = ?
           WHERE project_path = ? AND pull_request_number = ? AND claim_token = ?`,
        )
        .run(sessionId, projectPath, pullRequestNumber, claimToken);
    });
  }

  releasePullRequestAdoption(
    projectPath: string,
    pullRequestNumber: number,
    claimToken: string,
  ): void {
    this.database.db
      .prepare(
        `DELETE FROM forge_pr_session_claims
         WHERE project_path = ? AND pull_request_number = ?
           AND claim_token = ? AND session_id IS NULL`,
      )
      .run(projectPath, pullRequestNumber, claimToken);
  }

  /** Direct tree children of a session, oldest first (insertion order on a created_at tie). */
  childrenOf(parentSessionId: string): SessionDto[] {
    const rows = this.database.db
      .prepare<SessionRow, [string]>(
        'SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY created_at ASC, rowid ASC',
      )
      .all(parentSessionId);
    return rows.map(toDto);
  }

  create(input: CreateSessionDto): SessionDto {
    const now = Date.now();
    const id = input.id ?? uuidv4().slice(0, 8);
    const row: SessionRow = {
      id,
      title: titleFromPrompt(input.prompt),
      status: 'CREATED',
      provider: input.provider ?? 'pi',
      model: input.model ?? null,
      model_options: stringifyModelOptions(input.modelOptions),
      workspace: input.workspace?.trim() || null,
      prompt: input.prompt,
      preview: null,
      project_path: input.projectPath ?? null,
      base_branch: input.baseBranch ?? null,
      worktree_path: input.worktreePath ?? null,
      branch: input.branch ?? null,
      provider_thread_id: input.providerThreadId ?? null,
      provider_active_turn_id: input.providerActiveTurnId ?? null,
      provider_state_json: stringifyProviderState(input.providerState),
      runtime_policy_json: stringifyAgentRuntimePolicy(input.runtimePolicy),
      verify_owner: input.verifyOwner ?? 'session',
      cursor_backend: input.cursorBackend ?? null,
      cursor_chat_id: input.cursorChatId ?? null,
      forge_provider: input.forgeProvider ?? null,
      pull_request_url: input.pullRequestUrl ?? null,
      pull_request_number: input.pullRequestNumber ?? null,
      pull_request_state: input.pullRequestState ?? null,
      forge_status: input.forgeStatus ?? 'none',
      parent_session_id: input.parentSessionId ?? null,
      origin_task_id: input.originTaskId ?? null,
      prior_session_id: null,
      created_at: now,
      updated_at: now,
    };
    this.insertRow(row);
    return toDto(row);
  }

  createHandoff(input:
    | {
        id?: string;
        provider?: 'cursor';
        title: string;
        workspace: string;
        cursorChatId: string;
        prompt: string;
        model?: string | null;
        modelOptions?: ModelOptionsMap | null;
        projectPath?: string | null;
        branch?: string | null;
        priorSessionId?: string | null;
      }
    | {
        id?: string;
        provider: 'pi';
        title: string;
        workspace: string;
        providerThreadId: string;
        prompt: string;
        model?: string | null;
        modelOptions?: ModelOptionsMap | null;
        projectPath?: string | null;
        branch?: string | null;
        priorSessionId?: string | null;
      }): SessionDto {
    const now = Date.now();
    const id = input.id ?? uuidv4().slice(0, 8);
    const isPi = input.provider === 'pi';
    const row: SessionRow = {
      id,
      title: input.title,
      status: 'IDLE',
      provider: isPi ? 'pi' : 'cursor',
      model: input.model ?? null,
      model_options: stringifyModelOptions(input.modelOptions),
      workspace: input.workspace.trim(),
      prompt: input.prompt,
      preview: null,
      project_path: input.projectPath ?? null,
      base_branch: null,
      worktree_path: null,
      branch: input.branch ?? null,
      provider_thread_id: isPi ? input.providerThreadId : null,
      provider_active_turn_id: null,
      provider_state_json: null,
      runtime_policy_json: null,
      verify_owner: 'session',
      cursor_backend: isPi ? null : 'cli',
      cursor_chat_id: isPi ? null : 'cursorChatId' in input ? input.cursorChatId : null,
      forge_provider: null,
      pull_request_url: null,
      pull_request_number: null,
      pull_request_state: null,
      forge_status: 'none',
      parent_session_id: null,
      origin_task_id: null,
      prior_session_id: input.priorSessionId ?? null,
      created_at: now,
      updated_at: now,
    };
    this.insertRow(row);
    return toDto(row);
  }

  updateStatus(id: string, status: SessionStatus): SessionDto {
    if (this.database.closed) return { id, status } as SessionDto;
    const current = this.database.db
      .prepare<{ status: SessionStatus }, [string]>('SELECT status FROM sessions WHERE id = ?')
      .get(id);
    if (!current) throw new Error(`Session ${id} not found`);
    assertTransition(current.status, status);
    const now = Date.now();
    this.database.db
      .prepare('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now, id);
    return this.findById(id)!;
  }

  updateTitle(id: string, title: string): SessionDto | null {
    const now = Date.now();
    this.database.db
      .prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, now, id);
    return this.findById(id);
  }

  updateModel(id: string, model: string, modelOptions?: ModelOptionsMap | null): SessionDto | null {
    const now = Date.now();
    this.database.db
      .prepare('UPDATE sessions SET model = ?, model_options = ?, updated_at = ? WHERE id = ?')
      .run(model, stringifyModelOptions(modelOptions), now, id);
    return this.findById(id);
  }

  touchPreview(id: string, preview: string): void {
    if (this.database.closed) return;
    const now = Date.now();
    this.database.db
      .prepare('UPDATE sessions SET preview = ?, updated_at = ? WHERE id = ?')
      .run(preview.slice(0, 200), now, id);
  }

  updateProviderRuntimeState(
    id: string,
    state: {
      providerThreadId?: string | null;
      providerActiveTurnId?: string | null;
      providerState?: Record<string, unknown> | null;
    },
  ): SessionDto {
    const current = this.findById(id);
    if (!current) throw new Error(`Session ${id} not found`);
    const now = Date.now();
    const providerThreadId =
      state.providerThreadId !== undefined ? state.providerThreadId : current.providerThreadId;
    const providerActiveTurnId =
      state.providerActiveTurnId !== undefined
        ? state.providerActiveTurnId
        : current.providerActiveTurnId;
    const providerState =
      state.providerState !== undefined ? state.providerState : current.providerState;

    this.database.db
      .prepare(
        `UPDATE sessions
         SET provider_thread_id = ?, provider_active_turn_id = ?, provider_state_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        providerThreadId,
        providerActiveTurnId,
        stringifyProviderState(providerState),
        now,
        id,
      );
    return this.findById(id)!;
  }

  updateForgeState(
    id: string,
    state: {
      forgeProvider?: string | null;
      pullRequestUrl?: string | null;
      pullRequestNumber?: number | null;
      pullRequestState?: string | null;
      forgeStatus?: string;
    },
  ): SessionDto {
    const current = this.findById(id);
    if (!current) throw new Error(`Session ${id} not found`);
    const now = Date.now();
    const forgeProvider = state.forgeProvider !== undefined ? state.forgeProvider : current.forgeProvider;
    const pullRequestUrl =
      state.pullRequestUrl !== undefined ? state.pullRequestUrl : current.pullRequestUrl;
    const pullRequestNumber =
      state.pullRequestNumber !== undefined ? state.pullRequestNumber : current.pullRequestNumber;
    const pullRequestState =
      state.pullRequestState !== undefined ? state.pullRequestState : current.pullRequestState;
    const forgeStatus = state.forgeStatus !== undefined ? state.forgeStatus : current.forgeStatus;

    this.database.db
      .prepare(
        `UPDATE sessions
         SET forge_provider = ?, pull_request_url = ?, pull_request_number = ?,
             pull_request_state = ?, forge_status = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        forgeProvider ?? null,
        pullRequestUrl ?? null,
        pullRequestNumber ?? null,
        pullRequestState ?? null,
        forgeStatus ?? 'none',
        now,
        id,
      );
    return this.findById(id)!;
  }

  /** Detach an archived PR mapping only when another live session owns it. */
  detachForgeOwnershipIfReplaced(id: string): boolean {
    const current = this.database.db
      .prepare<
        { status: SessionStatus; project_path: string | null; pull_request_number: number | null },
        [string]
      >(
        `SELECT status, project_path, pull_request_number FROM sessions WHERE id = ?`,
      )
      .get(id);
    if (
      !current || current.status !== 'ARCHIVED' ||
      !current.project_path || current.pull_request_number === null
    ) return false;
    const replacement = this.database.db
      .prepare<{ id: string }, [string, number, string]>(
        `SELECT id FROM sessions
         WHERE project_path = ? AND pull_request_number = ?
           AND id != ? AND status != 'ARCHIVED' AND verify_owner = 'session'
         LIMIT 1`,
      )
      .get(current.project_path, current.pull_request_number, id);
    if (!replacement) return false;
    this.database.db
      .prepare(
        `UPDATE sessions
         SET forge_provider = NULL, pull_request_url = NULL,
             pull_request_number = NULL, pull_request_state = NULL,
             forge_status = 'none', updated_at = ?
         WHERE id = ? AND status = 'ARCHIVED'`,
      )
      .run(Date.now(), id);
    return true;
  }

  clearWorktreeMetadata(id: string): SessionDto {
    const current = this.findById(id);
    if (!current) throw new Error(`Session ${id} not found`);
    const runtimePolicy = current.runtimePolicy && current.projectPath
      ? { ...current.runtimePolicy, workspaceRoot: current.projectPath }
      : current.runtimePolicy;
    this.database.db
      .prepare(
        `UPDATE sessions
         SET workspace = project_path, base_branch = NULL, worktree_path = NULL,
             branch = NULL, runtime_policy_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(stringifyAgentRuntimePolicy(runtimePolicy), Date.now(), id);
    return this.findById(id)!;
  }

  delete(id: string): void {
    const deleteProviderRequests = this.database.db.prepare(
      'DELETE FROM provider_requests WHERE session_id = ?',
    );
    const deleteEvents = this.database.db.prepare('DELETE FROM events WHERE session_id = ?');
    const deleteSession = this.database.db.prepare('DELETE FROM sessions WHERE id = ?');
    const tx = this.database.db.transaction(() => {
      deleteProviderRequests.run(id);
      deleteEvents.run(id);
      deleteSession.run(id);
    });
    tx();
  }

  private insertRow(row: SessionRow): void {
    this.database.db
      .prepare(
        `INSERT INTO sessions (
          id, title, status, provider, model, model_options, workspace, prompt, preview,
          project_path, base_branch, worktree_path, branch,
          provider_thread_id, provider_active_turn_id, provider_state_json,
          runtime_policy_json, verify_owner,
          cursor_backend, cursor_chat_id,
          forge_provider, pull_request_url, pull_request_number, pull_request_state, forge_status,
          parent_session_id, origin_task_id, prior_session_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.title,
        row.status,
        row.provider,
        row.model,
        row.model_options,
        row.workspace,
        row.prompt,
        row.preview,
        row.project_path,
        row.base_branch,
        row.worktree_path,
        row.branch,
        row.provider_thread_id,
        row.provider_active_turn_id,
        row.provider_state_json,
        row.runtime_policy_json,
        row.verify_owner,
        row.cursor_backend,
        row.cursor_chat_id,
        row.forge_provider,
        row.pull_request_url,
        row.pull_request_number,
        row.pull_request_state,
        row.forge_status,
        row.parent_session_id,
        row.origin_task_id,
        row.prior_session_id,
        row.created_at,
        row.updated_at,
      );
  }
}
