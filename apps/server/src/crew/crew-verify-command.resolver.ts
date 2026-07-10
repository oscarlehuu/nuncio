import { Injectable } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectDefaultsResolver } from '../projects/project-defaults-resolver';
import { ProjectsRepository } from '../projects/projects.repository';
import { CrewValidationError } from './domain/crew-errors';
import type { CrewProfileOverride } from './domain/crew.types';

/** Resolves and freezes the verifier before a CrewRun is created. */
@Injectable()
export class CrewVerifyCommandResolver {
  constructor(
    private readonly projects: ProjectsRepository,
    private readonly defaults: ProjectDefaultsResolver,
  ) {}

  resolve(
    projectPath: string | null,
    profileCommand: string | null | undefined,
    explicitCommand?: string | null,
    projectScriptAtHead?: boolean,
  ): string | null {
    const explicit = validateCommand(explicitCommand);
    if (explicit) return explicit;
    if (projectPath) {
      const projectCommand = this.projectCommand(projectPath);
      if (projectCommand) return validateCommand(projectCommand);
      const script = join(projectPath, '.nuncio', 'verify');
      if (projectScriptAtHead ?? existsSync(script)) return 'sh ./.nuncio/verify';
    }
    const saved = validateCommand(profileCommand);
    if (saved) return saved;
    return validateCommand(this.defaults.resolveVerifyCommand(null));
  }

  private projectCommand(projectPath: string): string | null {
    try { return this.projects.findByPath(projectPath)?.verifyCommand?.trim() || null; }
    catch { return null; }
  }
}

export function pickExplicitVerifyCommand(
  projectOverride?: CrewProfileOverride, runOverride?: CrewProfileOverride,
): string | null {
  for (const override of [runOverride, projectOverride]) {
    if (!override?.policy || !Object.hasOwn(override.policy, 'verifyCommand')) continue;
    const command = override.policy.verifyCommand?.trim();
    if (command) return command;
  }
  return null;
}

function validateCommand(value: string | null | undefined): string | null {
  const command = value?.trim();
  if (!command) return null;
  if (command.includes('\0')) throw new CrewValidationError('verifyCommand must not contain NUL');
  if (Buffer.byteLength(command, 'utf8') > 4096) {
    throw new CrewValidationError('verifyCommand must be at most 4096 UTF-8 bytes');
  }
  return command;
}
