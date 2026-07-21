import { Injectable } from '@nestjs/common';
import type {
  CrewProfileDefinition, CrewProfileIssue, CrewProfileOverride, CrewProfilePolicy,
  CrewProfileResolution, CrewProfileSnapshot,
  CrewProviderCapability, CrewRole, CrewRoleBinding, CrewRuntimePolicy,
} from './domain/crew.types';
import { CrewValidationError } from './domain/crew-errors';
import { isCrewVerifierSandboxAvailable } from './crew-command-sandbox';
import { DEFAULT_CREW_SANDBOX_BACKEND } from './crew-sandbox-backend';
import { CONTAINER_CREW_SANDBOX_BACKEND } from './crew-container-sandbox';
import { DEFAULT_CREW_VERIFICATION_WORKSPACE } from './crew-verification-workspace-registry';

const MAX_VERIFY_OUTPUT_CAP_BYTES = 64 * 1024 * 1024;

export const QUALITY_CREW_PRESET = {
  id: 'quality' as const,
  phases: ['PLAN', 'BUILD', 'VERIFY', 'REVIEW', 'SYNTHESIZE', 'DONE'] as const,
  policy: { maxVerifyRetries: 2, maxReviewRetries: 2, strictFreshFinalReviewer: true, verifyCommand: null },
};

export interface ResolveCrewProfileInput {
  savedProfile: { id: string; revision: number; presetId: 'quality'; definition: CrewProfileDefinition };
  projectOverride?: CrewProfileOverride;
  runOverride?: CrewProfileOverride;
  catalog: CrewProviderCapability[];
  resolvedVerifyCommand: string | null;
  verifierSandboxAvailable?: boolean;
  // Registered isolation strategy names. Defaults keep the resolver a pure function usable in
  // isolation; the service passes the live registry names so a newly registered backend is
  // accepted without editing the resolver.
  verificationWorkspaceStrategies?: string[];
  sandboxBackends?: string[];
}

@Injectable()
export class CrewProfileResolver {
  resolve(input: ResolveCrewProfileInput): CrewProfileResolution {
    const binding = (role: CrewRole): CrewRoleBinding => ({
      ...(input.savedProfile.definition.bindings?.[role] ?? {}),
      ...(input.projectOverride?.bindings?.[role] ?? {}),
      ...(input.runOverride?.bindings?.[role] ?? {}),
    }) as CrewRoleBinding;
    const bindings = { foreman: binding('foreman'), builder: binding('builder'), reviewer: binding('reviewer') };
    const policy = {
      ...QUALITY_CREW_PRESET.policy,
      ...(input.savedProfile.definition.policy ?? {}),
      ...(input.projectOverride?.policy ?? {}),
      ...(input.runOverride?.policy ?? {}),
    };
    const issues: CrewProfileIssue[] = [];
    this.validateBinding('foreman', bindings.foreman, 'read-only', input.catalog, issues);
    this.validateBinding('builder', bindings.builder, 'workspace-write', input.catalog, issues);
    this.validateBinding('reviewer', bindings.reviewer, 'read-only', input.catalog, issues);
    if (bindings.builder.provider === bindings.reviewer.provider
      && bindings.builder.model === bindings.reviewer.model) {
      issues.push({ code: 'reviewer_not_independent', role: 'reviewer', message: 'reviewer must differ from builder' });
    }
    this.validatePolicySeam(policy, input, issues);
    const verifyCommand = input.resolvedVerifyCommand?.trim() || null;
    if (!verifyCommand) {
      issues.push({
        code: 'verify_command_missing',
        message: 'Crew requires a project, profile, or global verify command',
      });
    }
    if (!(input.verifierSandboxAvailable ?? isCrewVerifierSandboxAvailable())) {
      issues.push({
        code: 'verifier_sandbox_unavailable',
        message: policy.sandboxBackend?.trim() === CONTAINER_CREW_SANDBOX_BACKEND
          ? 'Crew requires a reachable Docker or Podman daemon for container-backed verification'
          : 'Crew requires Seatbelt on macOS or bubblewrap on Linux for deterministic verification',
      });
    }
    const snapshot = deepFreeze({
      presetId: 'quality' as const,
      sourceProfileId: input.savedProfile.id,
      sourceProfileRevision: input.savedProfile.revision,
      resolvedAt: Date.now(),
      bindings: {
        foreman: { ...bindings.foreman, runtimePolicy: 'read-only' as const },
        builder: { ...bindings.builder, runtimePolicy: 'workspace-write' as const },
        reviewer: { ...bindings.reviewer, runtimePolicy: 'read-only' as const },
      },
      tester: { kind: 'nuncio' as const, runtimePolicy: 'read-only' as const },
      policy: { ...policy, verifyCommand },
    });
    return { state: issues.length ? 'needs_setup' : 'ready', issues, snapshot };
  }

  // Validates the additive verify-execution seam fields, but only when a profile actually sets
  // them. An untouched profile produces no new issues and an unchanged snapshot.
  private validatePolicySeam(
    policy: CrewProfilePolicy, input: ResolveCrewProfileInput, issues: CrewProfileIssue[],
  ): void {
    const workspaceStrategies = input.verificationWorkspaceStrategies
      ?? [DEFAULT_CREW_VERIFICATION_WORKSPACE];
    const sandboxBackends = input.sandboxBackends ?? [DEFAULT_CREW_SANDBOX_BACKEND];
    const workspace = policy.verificationWorkspace?.trim();
    if (workspace && !workspaceStrategies.includes(workspace)) {
      issues.push({
        code: 'verification_workspace_unknown',
        message: `Unknown Crew verification workspace strategy: ${workspace}`,
      });
    }
    const backend = policy.sandboxBackend?.trim();
    if (backend && !sandboxBackends.includes(backend)) {
      issues.push({
        code: 'sandbox_backend_unknown',
        message: `Unknown Crew sandbox backend: ${backend}`,
      });
    }
    if (policy.verifyTimeoutMs !== undefined
      && (!Number.isInteger(policy.verifyTimeoutMs) || policy.verifyTimeoutMs < 1)) {
      issues.push({
        code: 'verify_limit_invalid',
        message: 'Crew verify timeout must be a positive integer number of milliseconds',
      });
    }
    if (policy.verifyOutputCapBytes !== undefined
      && (!Number.isInteger(policy.verifyOutputCapBytes) || policy.verifyOutputCapBytes < 1
        || policy.verifyOutputCapBytes > MAX_VERIFY_OUTPUT_CAP_BYTES)) {
      issues.push({
        code: 'verify_limit_invalid',
        message: 'Crew verify output cap must be from 1 byte to 64 MiB',
      });
    }
    this.validateContainerPolicy(policy, issues);
  }

  // The container config is inert unless the container backend is selected, but an invalid value is
  // still a configuration error worth surfacing at resolve time rather than mid-run.
  private validateContainerPolicy(policy: CrewProfilePolicy, issues: CrewProfileIssue[]): void {
    const container = policy.container;
    if (!container) return;
    if (container.image !== undefined && !container.image.trim()) {
      issues.push({
        code: 'container_image_invalid',
        message: 'Crew container image must be a non-empty string when set',
      });
    }
    if (container.cpus !== undefined && (!Number.isFinite(container.cpus) || container.cpus <= 0)) {
      issues.push({ code: 'container_resource_invalid', message: 'Crew container cpus must be a positive number' });
    }
    for (const field of ['memoryMb', 'pidsLimit'] as const) {
      const value = container[field];
      if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
        issues.push({
          code: 'container_resource_invalid',
          message: `Crew container ${field} must be a positive integer`,
        });
      }
    }
  }

  private validateBinding(
    role: CrewRole,
    binding: CrewRoleBinding,
    runtimePolicy: CrewRuntimePolicy,
    catalog: CrewProviderCapability[],
    issues: CrewProfileIssue[],
  ): void {
    if (!binding?.provider || !binding?.model?.trim()) {
      issues.push({ code: 'missing_binding', role, message: `${role} binding is required` });
      return;
    }
    const catalogProvider = catalog.find((entry) => entry.provider === binding.provider);
    const allowedMock = binding.provider === 'mock' && catalogProvider?.testOnly === true;
    if (!['pi', 'codex', 'claude', 'devin'].includes(binding.provider) && !allowedMock) {
      issues.push({ code: 'unsupported_provider', role, message: `${binding.provider} is outside Crew MVP` });
      return;
    }
    const provider = catalogProvider;
    if (!provider) {
      issues.push({ code: 'provider_unavailable', role, message: `${binding.provider} is unavailable` });
      return;
    }
    if (!provider.models.includes(binding.model)) {
      issues.push({ code: 'model_unavailable', role, message: `${binding.model} is unavailable` });
    }
    if (!provider.runtimePolicies.includes(runtimePolicy)) {
      issues.push({
        code: 'runtime_policy_unsupported', role,
        message: `${binding.provider} cannot enforce ${runtimePolicy}`,
      });
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function savedProfileFromSnapshot(snapshot: CrewProfileSnapshot): ResolveCrewProfileInput['savedProfile'] {
  if (!snapshot.sourceProfileId || snapshot.sourceProfileRevision === null) {
    throw new CrewValidationError('Crew snapshot has no saved profile identity');
  }
  const binding = (role: CrewRole): CrewRoleBinding => ({
    provider: snapshot.bindings[role].provider,
    model: snapshot.bindings[role].model,
  });
  return {
    id: snapshot.sourceProfileId,
    revision: snapshot.sourceProfileRevision,
    presetId: snapshot.presetId,
    definition: {
      bindings: { foreman: binding('foreman'), builder: binding('builder'), reviewer: binding('reviewer') },
      policy: { ...snapshot.policy },
    },
  };
}
