import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import {
  CrewNotFoundError, CrewProfileNeedsSetupError, CrewProfileRevisionConflictError,
  CrewRevisionConflictError, CrewValidationError,
} from './domain/crew-errors';
import type {
  CrewProfileDefinition, CrewProfileOverride, CrewRunDto,
} from './domain/crew.types';
import { CrewProfileResolver, QUALITY_CREW_PRESET, savedProfileFromSnapshot } from './crew-profile.resolver';
import { CrewProviderCatalogService } from './crew-provider-catalog.service';
import { CrewSandboxBackendRegistry, DEFAULT_CREW_SANDBOX_BACKEND } from './crew-sandbox-backend';
import { CrewVerificationWorkspaceRegistry } from './crew-verification-workspace-registry';
import { CrewVerifyCommandResolver, pickExplicitVerifyCommand } from './crew-verify-command.resolver';
import { CrewRunnerService } from './crew-runner.service';
import { CrewRunQueryService } from './crew-run-query.service';
import { CrewRunControlService } from './crew-run-control.service';
import { CrewSuccessorService } from './crew-successor.service';
import { CREW_WORKSPACE_PORT, type CrewWorkspacePort } from './crew-execution.ports';
import { CrewProfilesRepository } from './persistence/crew-profiles.repository';
import { CrewRunsRepository } from './persistence/crew-runs.repository';
import { CrewTasksRepository } from './persistence/crew-tasks.repository';

@Injectable()
export class CrewService {
  constructor(
    private readonly database: DatabaseService,
    private readonly profiles: CrewProfilesRepository,
    private readonly tasks: CrewTasksRepository,
    private readonly runs: CrewRunsRepository,
    private readonly resolver: CrewProfileResolver,
    private readonly catalog: CrewProviderCatalogService,
    private readonly verifyCommands: CrewVerifyCommandResolver,
    private readonly runner: CrewRunnerService,
    private readonly queries: CrewRunQueryService,
    private readonly controls: CrewRunControlService,
    private readonly successors: CrewSuccessorService,
    private readonly sandboxBackends: CrewSandboxBackendRegistry,
    private readonly verificationWorkspaces: CrewVerificationWorkspaceRegistry,
    @Inject(CREW_WORKSPACE_PORT) private readonly workspace: CrewWorkspacePort,
  ) {}

  presets() { return [QUALITY_CREW_PRESET]; }
  listProfiles() { return this.profiles.list(); }
  getProfile(id: string) { return this.requireProfile(id); }
  async createProfile(input: { name: string; presetId: 'quality'; definition: CrewProfileDefinition }) {
    await this.assertTestBindings(input.definition);
    return this.profiles.create(input);
  }
  async updateProfile(id: string, expectedRevision: number, input: { name?: string; definition?: CrewProfileDefinition }) {
    const current = this.requireProfile(id);
    if (current.revision !== expectedRevision) {
      throw new CrewProfileRevisionConflictError(id, expectedRevision, current);
    }
    if (input.definition) await this.assertTestBindings(input.definition);
    return this.profiles.update(id, expectedRevision, input);
  }
  deleteProfile(id: string) {
    if (!this.profiles.delete(id)) throw new CrewNotFoundError('CrewProfile', id);
  }
  async resolveProfile(id: string, input: {
    projectPath?: string | null; baseBranch?: string | null; baseHead?: string | null;
    projectOverride?: CrewProfileOverride; runOverride?: CrewProfileOverride;
  } = {}) {
    return this.resolveSavedProfile(this.requireProfile(id), input);
  }

  private async resolveSavedProfile(profile: {
    id: string; revision: number; presetId: 'quality'; definition: CrewProfileDefinition;
  }, input: {
    projectPath?: string | null; baseBranch?: string | null; baseHead?: string | null;
    projectOverride?: CrewProfileOverride; runOverride?: CrewProfileOverride;
  }) {
    const explicitVerifyCommand = pickExplicitVerifyCommand(input.projectOverride, input.runOverride);
    let baseHead = input.baseHead?.trim() || null;
    if (input.projectPath && !baseHead) {
      baseHead = (await this.workspace.resolveBase(input.projectPath, input.baseBranch)).baseHead;
    }
    const projectScriptAtHead = input.projectPath && baseHead
      ? await this.workspace.fileExistsAtRevision(
          input.projectPath, baseHead, '.nuncio/verify',
        )
      : undefined;
    return this.resolver.resolve({
      savedProfile: profile, catalog: await this.catalog.list(),
      resolvedVerifyCommand: this.verifyCommands.resolve(
        input.projectPath ?? null,
        profile.definition.policy.verifyCommand,
        explicitVerifyCommand,
        projectScriptAtHead,
      ),
      verificationWorkspaceStrategies: this.verificationWorkspaces?.names(),
      sandboxBackends: this.sandboxBackends?.names(),
      ...this.selectedSandboxAvailability(profile.definition.policy, input),
      ...(input.projectOverride ? { projectOverride: input.projectOverride } : {}),
      ...(input.runOverride ? { runOverride: input.runOverride } : {}),
    });
  }

  // Readiness gates on the availability of the *selected* confinement backend, not always the host
  // sandbox: a `container` profile needs a reachable Docker/Podman daemon, a `host` profile needs
  // Seatbelt/bubblewrap. An unknown backend name is left to the resolver (it emits its own issue).
  private selectedSandboxAvailability(
    policy: CrewProfileDefinition['policy'],
    input: { projectOverride?: CrewProfileOverride; runOverride?: CrewProfileOverride },
  ): { verifierSandboxAvailable?: boolean } {
    const selected = input.runOverride?.policy?.sandboxBackend
      ?? input.projectOverride?.policy?.sandboxBackend
      ?? policy?.sandboxBackend
      ?? DEFAULT_CREW_SANDBOX_BACKEND;
    if (!this.sandboxBackends?.has(selected)) return {};
    return { verifierSandboxAvailable: this.sandboxBackends.resolve(selected).isAvailable() };
  }

  async createTask(input: {
    objective: string; projectPath: string; baseBranch?: string | null; profileId: string;
    override?: CrewProfileOverride;
  }) {
    const frozenBase = await this.workspace.resolveBase(input.projectPath, input.baseBranch);
    const resolution = await this.resolveProfile(input.profileId, {
      projectPath: input.projectPath, baseHead: frozenBase.baseHead, runOverride: input.override,
    });
    if (resolution.state !== 'ready') throw new CrewProfileNeedsSetupError(resolution.issues);
    const created = this.database.transaction(() => {
      const task = this.tasks.create({ ...input, baseBranch: frozenBase.baseBranch });
      const run = this.runs.create({
        taskId: task.id, profileSnapshot: resolution.snapshot, projectPath: task.projectPath,
        baseBranch: frozenBase.baseBranch, baseHead: frozenBase.baseHead,
        context: { objective: task.objective },
      });
      return { task, run };
    });
    return { task: created.task, run: await this.runner.start(created.run.id) };
  }
  getTask(id: string) {
    const task = this.tasks.findById(id);
    if (!task) throw new CrewNotFoundError('CrewTask', id);
    return { task, runs: this.runs.listByTask(id) };
  }
  async createSuccessor(taskId: string, input: {
    priorRunId: string; expectedRevision: number; expectedBaseHead: string;
    changeRequest: string; profileId?: string; override?: CrewProfileOverride;
  }) {
    const { task } = this.getTask(taskId);
    const prior = this.requireRun(input.priorRunId);
    if (prior.taskId !== taskId || prior.status !== 'TERMINAL') {
      throw new CrewValidationError('successor requires a terminal prior run for this task');
    }
    if (prior.revision !== input.expectedRevision) {
      throw new CrewRevisionConflictError(prior.id, input.expectedRevision, prior);
    }
    if (!prior.workspaceHead || prior.workspaceHead !== input.expectedBaseHead) {
      throw new CrewValidationError('expectedBaseHead does not match the prior run');
    }
    const profileId = input.profileId ?? prior.profileSnapshot.sourceProfileId;
    if (!profileId) throw new CrewValidationError('profileId is required for successor');
    const savedProfile = this.profiles.findById(profileId);
    if (!savedProfile && profileId !== prior.profileSnapshot.sourceProfileId) {
      throw new CrewNotFoundError('CrewProfile', profileId);
    }
    const resolution = await this.resolveSavedProfile(
      savedProfile ?? savedProfileFromSnapshot(prior.profileSnapshot), {
        projectPath: task.projectPath, baseHead: prior.workspaceHead, runOverride: input.override,
      },
    );
    if (resolution.state !== 'ready') throw new CrewProfileNeedsSetupError(resolution.issues);
    const run = await this.successors.create({
      task, prior, profileSnapshot: resolution.snapshot, changeRequest: input.changeRequest,
    });
    return { task, run };
  }

  listRunSummaries(filters: {
    status?: string; projectPath?: string; limit: number; offset: number;
  }) { return this.runs.listSummaries(filters); }
  getRunDetail(id: string) { return this.queries.detail(id); }
  listEvents(id: string, since = 0, limit = 200) { return this.queries.listEvents(id, since, limit); }
  readArtifactRange(runId: string, artifactId: string, offset: number, limit: number) {
    return this.queries.readArtifactRange(runId, artifactId, offset, limit);
  }
  pause(id: string, expectedRevision: number) { return this.controls.pause(id, expectedRevision); }
  resume(id: string, expectedRevision: number) { return this.controls.resume(id, expectedRevision); }
  cancel(id: string, expectedRevision: number) { return this.controls.cancel(id, expectedRevision); }
  clarification(id: string, expectedRevision: number, message: string) {
    return this.controls.clarification(id, expectedRevision, message);
  }
  extraRound(id: string, expectedRevision: number, gate: 'verify' | 'review') {
    return this.controls.extraRound(id, expectedRevision, gate);
  }
  private requireProfile(id: string) {
    const profile = this.profiles.findById(id);
    if (!profile) throw new CrewNotFoundError('CrewProfile', id);
    return profile;
  }
  private requireRun(id: string): CrewRunDto {
    const run = this.runs.findById(id);
    if (!run) throw new CrewNotFoundError('CrewRun', id);
    return run;
  }
  private async assertTestBindings(definition: CrewProfileDefinition): Promise<void> {
    if (!Object.values(definition.bindings).some((binding) => binding.provider === 'mock')) return;
    const catalog = await this.catalog.list();
    if (!catalog.some((entry) => entry.provider === 'mock' && entry.testOnly === true)) {
      throw new CrewValidationError('mock Crew bindings are available only from an injected test-only catalog');
    }
  }
}
