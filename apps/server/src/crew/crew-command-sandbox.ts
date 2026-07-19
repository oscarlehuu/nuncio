import {
  buildRuntimeCommandSandboxLaunch,
  isRuntimeCommandSandboxAvailable,
  type RuntimeDependencyMount,
  type RuntimeSandboxLaunch,
  type RuntimeSandboxOptions,
} from '../agents/runtime-command-sandbox';
import type { CrewContainerPolicy } from './domain/crew.types';

/**
 * Crew verifier wrapper over the shared runtime command sandbox
 * (`agents/runtime-command-sandbox.ts`). The confinement core is generic —
 * the Pi policy shell tool rides the same builder — while the Crew-only
 * concerns stay here: the verifier temp-dir prefix and the backend/container
 * selection fields consumed by `crew-sandbox-backend.ts`, not by the builder.
 */

export type CrewSandboxLaunch = RuntimeSandboxLaunch;
export type CrewDependencyMount = RuntimeDependencyMount;

export interface CrewSandboxOptions extends RuntimeSandboxOptions {
  // Selects the confinement backend (default 'host'). Selection happens in the runner; the chosen
  // backend receives these same options, so an unrecognized value here is inert for the host build.
  backend?: string;
  // Container-backend configuration; consumed only by the 'container' backend and inert elsewhere.
  container?: CrewContainerPolicy;
}

export const isCrewVerifierSandboxAvailable = isRuntimeCommandSandboxAvailable;

export function buildCrewSandboxLaunch(
  command: string,
  cwd: string,
  platform = process.platform,
  sandboxExecutable = platform === 'darwin' ? '/usr/bin/sandbox-exec' : '/usr/bin/bwrap',
  options: CrewSandboxOptions = {},
): CrewSandboxLaunch {
  return buildRuntimeCommandSandboxLaunch(command, cwd, platform, sandboxExecutable, {
    ...options,
    tempDirPrefix: 'nuncio-crew-verify-',
  });
}
