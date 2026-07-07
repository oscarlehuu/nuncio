import { Injectable, Optional } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SettingsService } from '../settings/settings.service';
import {
  parseAutoSteerEnabled,
  parseMaxRounds,
} from '../sessions/verify-feedback';
import { resolveVerifyCommand, type VerifyCommand } from '../sessions/session-verifier';
import { ProjectsRepository } from './projects.repository';
import type { ProjectDto, WorktreePolicy } from './projects.types';

/**
 * Layers a project's config ABOVE the global chain, preserving today's behavior
 * when no project row exists:
 *   project override → global setting (DB → env → default) → registry default.
 * Pure over (project row | null, settings) so it is identical live and after
 * restart, and testable without a running provider. No engine branch (ADR-004).
 */
@Injectable()
export class ProjectDefaultsResolver {
  constructor(
    private readonly projects: ProjectsRepository,
    @Optional() private readonly settings?: SettingsService,
  ) {}

  private project(projectPath: string | null): ProjectDto | null {
    if (!projectPath) return null;
    try {
      return this.projects.findByPath(projectPath);
    } catch {
      return null;
    }
  }

  /**
   * Verify command string: project override → `.nuncio/verify` script → global
   * setting. Returns the command/path string, or null when nothing configures one.
   */
  resolveVerifyCommand(projectPath: string | null): string | null {
    const project = this.project(projectPath);
    if (project?.verifyCommand) return project.verifyCommand;
    if (projectPath && existsSync(join(projectPath, '.nuncio', 'verify'))) {
      return join(projectPath, '.nuncio', 'verify');
    }
    const global = this.settings?.resolve('NUNCIO_VERIFY_COMMAND')?.trim();
    return global && global.length > 0 ? global : null;
  }

  /**
   * Runnable verify command for a session, with the SAME precedence as above but
   * returning an executable {@link VerifyCommand}: the project override wins over
   * the workdir's `.nuncio/verify` and the global setting. `cwd` is the session
   * working directory (worktree/workspace) where `.nuncio/verify` lives; the
   * project override runs via `sh -c` in that cwd. Returns null when nothing is
   * configured.
   */
  resolveVerifyCommandFor(projectPath: string | null, cwd: string): VerifyCommand | null {
    const override = this.project(projectPath)?.verifyCommand;
    if (override) {
      return { argv: ['sh', '-c', override], display: override, source: 'project-config' };
    }
    // No project override → today's chain: .nuncio/verify → global setting.
    return resolveVerifyCommand(cwd, this.settings?.resolve('NUNCIO_VERIFY_COMMAND'));
  }

  /**
   * Worktree policy: project override → 'optional' (today's implicit default —
   * worktree-per-task is opt-in). There is no global worktree-policy setting yet;
   * when one lands it slots between these two layers.
   */
  resolveWorktreePolicy(projectPath: string | null): WorktreePolicy {
    return this.project(projectPath)?.worktreePolicy ?? 'optional';
  }

  /** Default engine id: project override → null (caller falls back to the registry default). */
  resolveDefaultEngine(projectPath: string | null): string | null {
    return this.project(projectPath)?.defaultEngine ?? null;
  }

  /**
   * Auto-steer enabled: the project tri-state wins over the global setting.
   * 'on'/'off' are decisive; 'inherit' (or no row) defers to the global chain.
   */
  resolveAutoSteerEnabled(projectPath: string | null): boolean {
    const project = this.project(projectPath);
    if (project && project.verifyAutoSteer !== 'inherit') {
      return project.verifyAutoSteer === 'on';
    }
    return parseAutoSteerEnabled(this.settings?.resolve('NUNCIO_VERIFY_AUTO_STEER'));
  }

  /** Max auto-steer rounds: project override → global setting → default. */
  resolveMaxRounds(projectPath: string | null): number {
    const project = this.project(projectPath);
    if (project && project.verifyMaxRounds !== null) return project.verifyMaxRounds;
    return parseMaxRounds(this.settings?.resolve('NUNCIO_VERIFY_MAX_ROUNDS'));
  }
}
