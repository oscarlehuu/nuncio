import { Inject, Injectable, Optional } from '@nestjs/common';
import { CrewArtifactStore } from './crew-artifact.store';
import { CrewCommandRunner, type CrewCommandResult } from './crew-command.runner';
import { CREW_WORKSPACE_PORT, type CrewWorkspacePort } from './crew-execution.ports';
import type { CrewContainerPolicy } from './domain/crew.types';
import { CrewValidationError } from './domain/crew-errors';
import {
  CREW_VERIFICATION_WORKSPACE_FACTORY,
  CrewVerificationPreparationStopped,
  defaultCrewVerificationWorkspaceFactory,
  type CrewPreparedVerificationWorkspace,
  type CrewVerificationWorkspaceFactory,
} from './crew-verification-workspace';
import {
  CrewVerificationWorkspaceRegistry,
  DEFAULT_CREW_VERIFICATION_WORKSPACE,
} from './crew-verification-workspace-registry';

export interface CrewVerifyResult extends CrewCommandResult {
  passed: boolean; workspaceHead: string; artifactId: string; preview: string; previewTruncated: boolean;
}

@Injectable()
export class CrewVerifierService {
  private readonly verificationWorkspaces: CrewVerificationWorkspaceFactory;

  constructor(
    @Inject(CREW_WORKSPACE_PORT) private readonly workspace: CrewWorkspacePort,
    private readonly runner: CrewCommandRunner,
    private readonly artifacts: CrewArtifactStore,
    @Optional() @Inject(CREW_VERIFICATION_WORKSPACE_FACTORY)
    verificationWorkspaces?: CrewVerificationWorkspaceFactory,
    @Optional() @Inject(CrewVerificationWorkspaceRegistry)
    private readonly workspaceRegistry?: CrewVerificationWorkspaceRegistry,
  ) {
    this.verificationWorkspaces = verificationWorkspaces ?? defaultCrewVerificationWorkspaceFactory;
  }
  async verify(input: {
    runId: string; command: string; cwd: string; expectedHead: string;
    expectedBranch?: string | null; timeoutMs?: number; previewBytes?: number; signal?: AbortSignal;
    verificationWorkspace?: string; sandboxBackend?: string; outputCapBytes?: number;
    container?: CrewContainerPolicy;
  }): Promise<CrewVerifyResult> {
    const command = input.command.trim();
    if (!command) throw new Error('Crew verify command is required');
    const timeoutMs = input.timeoutMs ?? 120_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('Crew verify timeout must be positive');
    const workspaceFactory = this.resolveWorkspaceFactory(input.verificationWorkspace);
    const boundary = await this.workspace.inspectBoundary(input.cwd, input.expectedBranch ?? undefined);
    if (boundary.ok === false) throw new Error(`Crew verify workspace boundary failed: ${boundary.reason ?? 'unknown'}`);
    if (!boundary.exists) throw new Error('Crew verify workspace does not exist');
    if (boundary.symlink) throw new Error('Crew verify workspace cannot be a symlink');
    if (!boundary.clean) throw new Error('Crew verify requires a clean workspace');
    if (!boundary.reachable) throw new Error('Crew verify workspace is not reachable from its base');
    if (!boundary.fullHead || boundary.fullHead !== input.expectedHead) {
      throw new Error('Crew verify workspace head changed');
    }
    if (input.expectedBranch && boundary.branch !== input.expectedBranch) {
      throw new Error('Crew verify workspace branch changed');
    }
    const startedAt = Date.now();
    const deadlineAt = startedAt + timeoutMs;
    let verification: CrewPreparedVerificationWorkspace | null = null;
    let result: CrewCommandResult | null = null;
    try {
      try {
        verification = await workspaceFactory.prepare({
          sourcePath: boundary.canonicalPath,
          expectedHead: input.expectedHead,
          signal: input.signal,
          deadlineAt,
        });
      } catch (error) {
        if (!(error instanceof CrewVerificationPreparationStopped)) throw error;
        result = stoppedResult(error, Date.now() - startedAt);
      }
      if (!result && verification) {
        const stopped = input.signal?.aborted
          ? new CrewVerificationPreparationStopped('aborted')
          : Date.now() >= deadlineAt ? new CrewVerificationPreparationStopped('timed_out') : null;
        if (stopped) result = stoppedResult(stopped, Date.now() - startedAt);
        else {
          const commandResult = await this.runner.run(
            command, verification.path, Math.max(1, deadlineAt - Date.now()),
            input.outputCapBytes, input.signal,
            {
              dependencyRoot: verification.dependencyRoot, sourceRoot: boundary.canonicalPath,
              backend: input.sandboxBackend, container: input.container,
            },
          );
          result = { ...commandResult, durationMs: Date.now() - startedAt };
        }
      }
    } finally {
      await verification?.cleanup();
    }
    if (!result) throw new Error('Crew verification did not produce a command result');
    const postBoundary = await this.inspectAfter(input, boundary.canonicalPath);
    const postBoundaryOk = postBoundary.ok !== false && postBoundary.exists && !postBoundary.symlink
      && postBoundary.canonicalPath === boundary.canonicalPath
      && postBoundary.branch === boundary.branch
      && postBoundary.fullHead === input.expectedHead
      && postBoundary.clean && postBoundary.reachable;
    const passed = result.exitCode === 0 && !result.timedOut && !result.aborted
      && result.spawnError === null && !result.outputOverflow && postBoundaryOk;
    const log = [
      '[stdout]', result.stdout,
      '[stderr]', result.stderr,
      ...(result.spawnError ? ['[spawn-error]', result.spawnError] : []),
    ].join('\n');
    const stored = this.artifacts.writeLog({
      runId: input.runId, kind: 'verify-log', content: log, previewBytes: input.previewBytes,
      metadata: {
        command, cwd: boundary.canonicalPath, exitCode: result.exitCode,
        durationMs: result.durationMs, timedOut: result.timedOut, aborted: result.aborted,
        spawnError: result.spawnError, outputOverflow: result.outputOverflow,
        workspaceHead: boundary.fullHead,
        passed,
        postBoundaryOk, postWorkspaceHead: postBoundary.fullHead,
        postBranch: postBoundary.branch, postClean: postBoundary.clean,
        postReachable: postBoundary.reachable, postReason: postBoundary.reason,
      },
    });
    return {
      ...result,
      passed,
      workspaceHead: input.expectedHead, artifactId: stored.artifact.id,
      preview: stored.preview, previewTruncated: stored.truncated,
    };
  }

  // Absent strategy keeps the injected default factory (byte-identical to prior behavior). A named
  // strategy is resolved through the registry, which throws a clean validation error for an unknown
  // name. The profile resolver already gates unknown names, so this is a defensive backstop.
  private resolveWorkspaceFactory(strategy?: string): CrewVerificationWorkspaceFactory {
    const name = strategy?.trim();
    if (!name) return this.verificationWorkspaces;
    if (this.workspaceRegistry) return this.workspaceRegistry.resolve(name);
    if (name === DEFAULT_CREW_VERIFICATION_WORKSPACE) return this.verificationWorkspaces;
    throw new CrewValidationError(`Unknown Crew verification workspace strategy: ${name}`);
  }

  private async inspectAfter(
    input: { cwd: string; expectedHead: string; expectedBranch?: string | null },
    canonicalPath: string,
  ) {
    try {
      return await this.workspace.inspectBoundary(input.cwd, {
        expectedBranch: input.expectedBranch ?? undefined,
        expectedCanonicalPath: canonicalPath,
      });
    } catch (error) {
      return {
        ok: false, canonicalPath, exists: false, symlink: false, branch: null,
        fullHead: null, clean: false, reachable: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function stoppedResult(
  error: CrewVerificationPreparationStopped,
  durationMs: number,
): CrewCommandResult {
  return {
    exitCode: null,
    stdout: '',
    stderr: error.message,
    durationMs,
    timedOut: error.reason === 'timed_out',
    aborted: error.reason === 'aborted',
    spawnError: error.reason === 'timed_out' ? error.message : null,
    outputOverflow: false,
  };
}
