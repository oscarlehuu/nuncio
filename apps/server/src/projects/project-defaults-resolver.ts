import { Injectable, Optional } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { ProjectsRepository } from './projects.repository';
import type { WorktreePolicy } from './projects.types';

/**
 * Layers a project's config ABOVE the existing global chain, preserving today's
 * behavior when no project row exists:
 *   project override → global setting (DB → env → default) → registry default.
 * Pure over (project row | null, settings) so it is identical live and after
 * restart, and testable without a running provider. SKELETON — red suite drives
 * the contract; methods throw until implemented.
 */
@Injectable()
export class ProjectDefaultsResolver {
  constructor(
    private readonly projects: ProjectsRepository,
    @Optional() private readonly settings?: SettingsService,
  ) {
    void this.projects;
    void this.settings;
  }

  /** Resolve the verify command override for a project path (null = inherit). */
  resolveVerifyCommand(_projectPath: string | null): string | null {
    throw new Error('ProjectDefaultsResolver.resolveVerifyCommand not implemented');
  }

  /** Resolve the worktree policy for a project path. */
  resolveWorktreePolicy(_projectPath: string | null): WorktreePolicy {
    throw new Error('ProjectDefaultsResolver.resolveWorktreePolicy not implemented');
  }

  /** Resolve the default engine id for a project path (null = inherit global). */
  resolveDefaultEngine(_projectPath: string | null): string | null {
    throw new Error('ProjectDefaultsResolver.resolveDefaultEngine not implemented');
  }
}
