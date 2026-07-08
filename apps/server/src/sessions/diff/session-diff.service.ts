import { BadRequestException, Injectable, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { GitService } from '../../git/git.service';
import { SessionsService } from '../sessions.service';
import { buildDiffCommentSteer } from './diff-comment';
import { capDiff, parseUnifiedDiff } from './diff-parse';
import type { DiffCommentInput, SessionDiff } from './session-diff.types';

/** The git dir + base a session's diff is computed against. */
export interface SessionGitTarget {
  /** Absolute git working directory (worktreePath → workspace → projectPath). */
  gitDir: string;
  /** Base ref for a worktree session (its branch-point), or null for the plain-cwd floor. */
  base: string | null;
}

/**
 * Session diff review (rung 3, sub-phase D) — v1 WORKTREE diffs only. Resolves a
 * session's git dir + base (baseBranch for a worktree session, else the
 * uncommitted-HEAD floor for a plain cwd session), runs the raw git diff, and
 * folds it into the structured + capped {@link SessionDiff}. A hunk comment
 * becomes a steer through the EXISTING rung-1 path.
 *
 * RED until implemented — neutral TODO throws, no false greens.
 */
@Injectable()
export class SessionDiffService implements OnModuleInit {
  /**
   * Seam: resolve a session id → its git dir + base. Bound in onModuleInit to read
   * the SessionDto (worktreePath/baseBranch); tests drive it over a fixture repo.
   * Throws if the session has no git working directory.
   */
  resolveTarget: (sessionId: string) => SessionGitTarget = () => {
    throw new Error('TODO: SessionDiffService.resolveTarget seam not bound');
  };

  /** Seam: hand the built steer message to the rung-1 steer path (running→queued). */
  steer: (sessionId: string, message: string) => Promise<unknown> = async () => {
    throw new Error('TODO: SessionDiffService.steer seam not bound');
  };

  constructor(
    @Optional() private readonly git?: GitService,
    @Optional() private readonly sessions?: SessionsService,
  ) {}

  onModuleInit(): void {
    if (this.sessions) {
      this.resolveTarget = (sessionId) => {
        const session = this.sessions!.get(sessionId);
        if (!session) throw new NotFoundException('Session not found');
        const gitDir = session.worktreePath ?? session.workspace ?? session.projectPath;
        if (!gitDir) throw new BadRequestException('Session has no git working directory');
        return { gitDir, base: session.baseBranch?.trim() || null };
      };
      this.steer = (sessionId, message) => this.sessions!.steer(sessionId, message);
    }
  }

  /** Structured, capped worktree diff for a session (base derived per type). */
  async diff(sessionId: string): Promise<SessionDiff> {
    if (!this.git) throw new Error('GitService is not available');
    const target = this.resolveTarget(sessionId);
    try {
      const raw = await this.git.diff(target.gitDir, { base: target.base ?? undefined });
      return capDiff(parseUnifiedDiff(raw.diff));
    } catch (error) {
      if (error instanceof BadRequestException && String(error.message).startsWith('Not a git repository')) {
        return { files: [], truncated: false, omittedFiles: 0 };
      }
      throw error;
    }
  }

  /**
   * Turn a hunk comment into a steer: validate the path is inside the session cwd,
   * build the delimited steer text, and hand it to SessionsService.steer (running
   * → queued, rung-1 semantics). Returns the updated session.
   */
  async comment(sessionId: string, input: DiffCommentInput): Promise<unknown> {
    const target = this.resolveTarget(sessionId);
    validateRelativePath(target.gitDir, input.path);
    return this.steer(sessionId, buildDiffCommentSteer(input));
  }
}

function validateRelativePath(root: string, path: string): void {
  const trimmed = path.trim();
  if (
    !trimmed ||
    trimmed.startsWith('-') ||
    trimmed.startsWith('/') ||
    trimmed.includes('\0') ||
    trimmed.split('/').includes('..')
  ) {
    throw new BadRequestException('Invalid path');
  }

  const repoRoot = realpathSync.native(root);
  const candidate = resolve(repoRoot, trimmed);
  if (candidate !== repoRoot && !candidate.startsWith(`${repoRoot}${sep}`)) {
    throw new BadRequestException('Invalid path');
  }
}
