import { Injectable } from '@nestjs/common';
import type {
  CrewProfileDefinition, CrewProfileIssue, CrewProfileOverride, CrewProfileResolution,
  CrewProviderCapability, CrewRole, CrewRoleBinding, CrewRuntimePolicy,
} from './domain/crew.types';
import { isCrewVerifierSandboxAvailable } from './crew-command-sandbox';

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
        message: 'Crew requires Seatbelt on macOS or bubblewrap on Linux for deterministic verification',
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
    if (!['pi', 'codex', 'claude'].includes(binding.provider) && !allowedMock) {
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
