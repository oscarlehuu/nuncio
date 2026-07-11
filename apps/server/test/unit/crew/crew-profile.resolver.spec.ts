import {
  CrewProfileResolver,
  QUALITY_CREW_PRESET,
} from '../../../src/crew/crew-profile.resolver';
import type {
  CrewProfileDefinition,
  CrewProviderCapability,
} from '../../../src/crew/domain/crew.types';

const definition: CrewProfileDefinition = {
  bindings: {
    foreman: { provider: 'claude', model: 'fable' },
    builder: { provider: 'codex', model: 'sol' },
    reviewer: { provider: 'claude', model: 'opus' },
  },
  policy: { maxVerifyRetries: 2, maxReviewRetries: 2, strictFreshFinalReviewer: true, verifyCommand: null },
};

const catalog: CrewProviderCapability[] = [
  { provider: 'claude', models: ['fable', 'opus'], runtimePolicies: ['read-only', 'workspace-write'] },
  { provider: 'codex', models: ['sol'], runtimePolicies: ['read-only', 'workspace-write'] },
  { provider: 'pi', models: ['pi-pro'], runtimePolicies: ['read-only', 'workspace-write'] },
];

describe('CrewProfileResolver', () => {
  it('resolves a fixed Quality snapshot with deterministic Nuncio tester', () => {
    const result = new CrewProfileResolver().resolve({
      savedProfile: { id: 'quality-1', revision: 3, presetId: 'quality', definition },
      catalog, resolvedVerifyCommand: 'bun run gate',
    });
    expect(result.state).toBe('ready');
    expect(result.snapshot).toMatchObject({
      presetId: 'quality', sourceProfileId: 'quality-1', sourceProfileRevision: 3,
      bindings: {
        foreman: { provider: 'claude', model: 'fable', runtimePolicy: 'read-only' },
        builder: { provider: 'codex', model: 'sol', runtimePolicy: 'workspace-write' },
        reviewer: { provider: 'claude', model: 'opus', runtimePolicy: 'read-only' },
      },
      tester: { kind: 'nuncio', runtimePolicy: 'read-only' },
      policy: {
        maxVerifyRetries: 2, maxReviewRetries: 2, strictFreshFinalReviewer: true,
        verifyCommand: 'bun run gate',
      },
    });
    expect(result.issues).toEqual([]);
  });

  it('uses run override before project override before saved profile', () => {
    const result = new CrewProfileResolver().resolve({
      savedProfile: { id: 'p1', revision: 1, presetId: 'quality', definition },
      projectOverride: { bindings: { builder: { provider: 'pi', model: 'pi-pro' } } },
      runOverride: { bindings: { builder: { provider: 'codex', model: 'sol' } }, policy: { maxVerifyRetries: 4 } },
      catalog, resolvedVerifyCommand: 'bun test',
    });
    expect(result.snapshot.bindings.builder).toMatchObject({ provider: 'codex', model: 'sol' });
    expect(result.snapshot.policy.maxVerifyRetries).toBe(4);
    expect(result.snapshot.policy.maxReviewRetries).toBe(2);
  });

  it('fails closed for unavailable model or runtime-policy support without switching provider', () => {
    const result = new CrewProfileResolver().resolve({
      savedProfile: { id: 'p1', revision: 1, presetId: 'quality', definition },
      catalog: [{ provider: 'claude', models: ['fable'], runtimePolicies: ['read-only'] }],
      resolvedVerifyCommand: 'bun test',
    });
    expect(result.state).toBe('needs_setup');
    expect(result.snapshot.bindings.builder.provider).toBe('codex');
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'provider_unavailable', 'model_unavailable',
    ]));
  });

  it('rejects non-MVP providers and non-independent reviewer bindings', () => {
    const unsupported = structuredClone(definition);
    unsupported.bindings.builder = { provider: 'cursor' as never, model: 'composer' };
    const sameReviewer = structuredClone(definition);
    sameReviewer.bindings.reviewer = { ...sameReviewer.bindings.builder };

    expect(new CrewProfileResolver().resolve({
      savedProfile: { id: 'p1', revision: 1, presetId: 'quality', definition: unsupported }, catalog,
      resolvedVerifyCommand: 'bun test',
    }).issues.map((issue) => issue.code)).toContain('unsupported_provider');
    expect(new CrewProfileResolver().resolve({
      savedProfile: { id: 'p2', revision: 1, presetId: 'quality', definition: sameReviewer }, catalog,
      resolvedVerifyCommand: 'bun test',
    }).issues.map((issue) => issue.code)).toContain('reviewer_not_independent');
  });

  it('returns an immutable snapshot unaffected by later saved-profile edits', () => {
    const mutable = structuredClone(definition);
    const result = new CrewProfileResolver().resolve({
      savedProfile: { id: 'p1', revision: 1, presetId: 'quality', definition: mutable }, catalog,
      resolvedVerifyCommand: 'bun test',
    });
    mutable.bindings.builder.model = 'changed';
    expect(result.snapshot.bindings.builder.model).toBe('sol');
    expect(Object.isFrozen(result.snapshot)).toBe(true);
  });

  it('exposes only the fixed PLAN-BUILD-VERIFY-REVIEW-SYNTHESIZE-DONE preset', () => {
    expect(QUALITY_CREW_PRESET.phases).toEqual(['PLAN', 'BUILD', 'VERIFY', 'REVIEW', 'SYNTHESIZE', 'DONE']);
    expect(JSON.stringify(QUALITY_CREW_PRESET)).not.toMatch(/APPROVAL|PUBLISH/);
  });

  it('allows mock bindings only through an explicitly test-only injected catalog', () => {
    const mockDefinition = structuredClone(definition);
    mockDefinition.bindings = {
      foreman: { provider: 'mock', model: 'foreman' },
      builder: { provider: 'mock', model: 'builder' },
      reviewer: { provider: 'mock', model: 'reviewer' },
    };
    const resolver = new CrewProfileResolver();
    const unavailable = resolver.resolve({
      savedProfile: { id: 'mock', revision: 1, presetId: 'quality', definition: mockDefinition },
      catalog: [{
        provider: 'mock', models: ['foreman', 'builder', 'reviewer'],
        runtimePolicies: ['read-only', 'workspace-write'],
      }],
      resolvedVerifyCommand: 'true',
    });
    const enabled = resolver.resolve({
      savedProfile: { id: 'mock', revision: 1, presetId: 'quality', definition: mockDefinition },
      catalog: [{
        provider: 'mock', models: ['foreman', 'builder', 'reviewer'],
        runtimePolicies: ['read-only', 'workspace-write'], testOnly: true,
      }],
      resolvedVerifyCommand: 'true',
    });
    expect(unavailable.state).toBe('needs_setup');
    expect(unavailable.issues.map((issue) => issue.code)).toContain('unsupported_provider');
    expect(enabled.state).toBe('ready');
  });

  it('fails closed when no deterministic verifier can be frozen into the snapshot', () => {
    const result = new CrewProfileResolver().resolve({
      savedProfile: { id: 'p1', revision: 1, presetId: 'quality', definition }, catalog,
      resolvedVerifyCommand: null,
    });
    expect(result.state).toBe('needs_setup');
    expect(result.snapshot.policy.verifyCommand).toBeNull();
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'verify_command_missing' }));
  });

  it('returns needs_setup before run creation when the verifier sandbox is unavailable', () => {
    const result = new CrewProfileResolver().resolve({
      savedProfile: { id: 'p1', revision: 1, presetId: 'quality', definition }, catalog,
      resolvedVerifyCommand: 'bun test', verifierSandboxAvailable: false,
    });
    expect(result.state).toBe('needs_setup');
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'verifier_sandbox_unavailable' }));
  });
});
