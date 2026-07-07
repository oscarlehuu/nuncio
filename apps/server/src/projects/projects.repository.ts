import { BadRequestException, Injectable } from '@nestjs/common';
import { basename } from 'node:path';
import { DatabaseService } from '../db/database.service';
import {
  VERIFY_AUTO_STEER_VALUES,
  WORKTREE_POLICIES,
  type ProjectDto,
  type ProjectRow,
  type UpsertProjectDto,
  type VerifyAutoSteer,
  type WorktreePolicy,
} from './projects.types';

/** Normalize a project path to its identity: trim, drop a single trailing slash. */
export function normalizeProjectPath(path: string): string {
  const trimmed = (path ?? '').trim();
  if (trimmed.length === 0) {
    throw new BadRequestException('project path is required');
  }
  return trimmed.length > 1 && trimmed.endsWith('/') ? trimmed.replace(/\/+$/, '') : trimmed;
}

function rowToDto(row: ProjectRow): ProjectDto {
  return {
    path: row.path,
    name: row.name,
    defaultEngine: row.default_engine,
    worktreePolicy: (row.worktree_policy as WorktreePolicy | null) ?? null,
    verifyCommand: row.verify_command,
    verifyAutoSteer: row.verify_auto_steer as VerifyAutoSteer,
    verifyMaxRounds: row.verify_max_rounds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Durable per-project config, keyed by normalized path (rung 2 sub-phase A). */
@Injectable()
export class ProjectsRepository {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Create-or-patch by path. PATCH semantics: a field omitted from `input` is
   * left unchanged on an existing row; on a new row it takes the inherit-default
   * (null / basename name / 'inherit'). An explicit empty-string clears a text
   * override (stored as NULL). Validation rejects bad enum / rounds values.
   */
  upsert(input: UpsertProjectDto): ProjectDto {
    const path = normalizeProjectPath(input.path);
    const existing = this.findByPath(path);
    const now = Date.now();

    const name = this.resolveName(input, existing, path);
    const defaultEngine = this.patchText(input, 'defaultEngine', existing?.defaultEngine ?? null);
    const worktreePolicy = this.patchWorktreePolicy(input, existing?.worktreePolicy ?? null);
    const verifyCommand = this.patchText(input, 'verifyCommand', existing?.verifyCommand ?? null);
    const verifyAutoSteer = this.patchAutoSteer(input, existing?.verifyAutoSteer ?? 'inherit');
    const verifyMaxRounds = this.patchMaxRounds(input, existing?.verifyMaxRounds ?? null);
    const createdAt = existing?.createdAt ?? now;

    this.database.db
      .prepare(
        `INSERT INTO projects
           (path, name, default_engine, worktree_policy, verify_command,
            verify_auto_steer, verify_max_rounds, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           name = excluded.name,
           default_engine = excluded.default_engine,
           worktree_policy = excluded.worktree_policy,
           verify_command = excluded.verify_command,
           verify_auto_steer = excluded.verify_auto_steer,
           verify_max_rounds = excluded.verify_max_rounds,
           updated_at = excluded.updated_at`,
      )
      .run(
        path,
        name,
        defaultEngine,
        worktreePolicy,
        verifyCommand,
        verifyAutoSteer,
        verifyMaxRounds,
        createdAt,
        now,
      );

    return this.findByPath(path)!;
  }

  findByPath(path: string): ProjectDto | null {
    if (this.database.closed) return null;
    const normalized = normalizeProjectPath(path);
    const row = this.database.db
      .prepare<ProjectRow, [string]>('SELECT * FROM projects WHERE path = ?')
      .get(normalized);
    return row ? rowToDto(row) : null;
  }

  list(): ProjectDto[] {
    if (this.database.closed) return [];
    const rows = this.database.db
      .prepare<ProjectRow, []>('SELECT * FROM projects ORDER BY path ASC')
      .all();
    return rows.map(rowToDto);
  }

  delete(path: string): void {
    if (this.database.closed) return;
    this.database.db.prepare('DELETE FROM projects WHERE path = ?').run(normalizeProjectPath(path));
  }

  private resolveName(input: UpsertProjectDto, existing: ProjectDto | null, path: string): string {
    const derived = basename(path) || path;
    if (input.name !== undefined) {
      const trimmed = input.name.trim();
      // Explicit '' (or whitespace) clears the override → revert to basename;
      // a non-empty name sets it.
      return trimmed.length > 0 ? trimmed : derived;
    }
    // Omitted: keep the existing name (patch), else derive.
    return existing?.name ?? derived;
  }

  /** Patch a text override: undefined = unchanged; '' = clear (null); else the value. */
  private patchText(
    input: UpsertProjectDto,
    key: 'defaultEngine' | 'verifyCommand',
    current: string | null,
  ): string | null {
    const value = input[key];
    if (value === undefined) return current;
    if (value === null) return null;
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
  }

  private patchWorktreePolicy(
    input: UpsertProjectDto,
    current: WorktreePolicy | null,
  ): WorktreePolicy | null {
    if (input.worktreePolicy === undefined) return current;
    if (input.worktreePolicy === null) return null;
    if (!WORKTREE_POLICIES.includes(input.worktreePolicy)) {
      throw new BadRequestException(
        `worktree policy must be one of ${WORKTREE_POLICIES.join(', ')}`,
      );
    }
    return input.worktreePolicy;
  }

  private patchAutoSteer(input: UpsertProjectDto, current: VerifyAutoSteer): VerifyAutoSteer {
    if (input.verifyAutoSteer === undefined) return current;
    if (!VERIFY_AUTO_STEER_VALUES.includes(input.verifyAutoSteer)) {
      throw new BadRequestException(
        `verify auto-steer must be one of ${VERIFY_AUTO_STEER_VALUES.join(', ')}`,
      );
    }
    return input.verifyAutoSteer;
  }

  private patchMaxRounds(input: UpsertProjectDto, current: number | null): number | null {
    if (input.verifyMaxRounds === undefined) return current;
    if (input.verifyMaxRounds === null) return null;
    const n = input.verifyMaxRounds;
    if (!Number.isInteger(n) || n < 0) {
      throw new BadRequestException('verify max rounds must be a non-negative integer');
    }
    return n;
  }
}
