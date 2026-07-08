import { Injectable, Optional } from '@nestjs/common';
import { GitService } from '../../git/git.service';
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
export class SessionDiffService {
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

  constructor(@Optional() private readonly git?: GitService) {}

  /** Structured, capped worktree diff for a session (base derived per type). */
  async diff(sessionId: string): Promise<SessionDiff> {
    throw new Error('TODO: SessionDiffService.diff not implemented');
    void sessionId;
  }

  /**
   * Turn a hunk comment into a steer: validate the path is inside the session cwd,
   * build the delimited steer text, and hand it to SessionsService.steer (running
   * → queued, rung-1 semantics). Returns the updated session.
   */
  async comment(sessionId: string, input: DiffCommentInput): Promise<unknown> {
    throw new Error('TODO: SessionDiffService.comment not implemented');
    void sessionId;
    void input;
  }
}
