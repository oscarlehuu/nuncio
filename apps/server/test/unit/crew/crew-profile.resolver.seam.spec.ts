import { CrewProfileResolver } from '../../../src/crew/crew-profile.resolver';
import type {
  CrewProfileDefinition, CrewProfilePolicy, CrewProviderCapability,
} from '../../../src/crew/domain/crew.types';

const catalog: CrewProviderCapability[] = [
  { provider: 'claude', models: ['fable', 'opus'], runtimePolicies: ['read-only', 'workspace-write'] },
  { provider: 'codex', models: ['sol'], runtimePolicies: ['read-only', 'workspace-write'] },
];

function profile(policy: Partial<CrewProfilePolicy> = {}): {
  id: string; revision: number; presetId: 'quality'; definition: CrewProfileDefinition;
} {
  return {
    id: 'p1', revision: 1, presetId: 'quality',
    definition: {
      bindings: {
        foreman: { provider: 'claude', model: 'fable' },
        builder: { provider: 'codex', model: 'sol' },
        reviewer: { provider: 'claude', model: 'opus' },
      },
      policy: {
        maxVerifyRetries: 2, maxReviewRetries: 2, strictFreshFinalReviewer: true,
        verifyCommand: null, ...policy,
      },
    },
  };
}

function resolve(policy: Partial<CrewProfilePolicy>, extra = {}) {
  return new CrewProfileResolver().resolve({
    savedProfile: profile(policy), catalog, resolvedVerifyCommand: 'bun test',
    verificationWorkspaceStrategies: ['git-snapshot', 'container'],
    sandboxBackends: ['host', 'container'],
    ...extra,
  });
}

describe('CrewProfileResolver verify-execution seam', () => {
  it('produces a byte-identical snapshot policy when no seam field is set', () => {
    const result = resolve({});
    expect(result.state).toBe('ready');
    // The frozen policy must carry exactly the historical keys — no new isolation keys leak in.
    expect(Object.keys(result.snapshot.policy).sort()).toEqual([
      'maxReviewRetries', 'maxVerifyRetries', 'strictFreshFinalReviewer', 'verifyCommand',
    ]);
  });

  it('accepts registered isolation strategies and freezes them into the snapshot', () => {
    const result = resolve({
      verificationWorkspace: 'container', sandboxBackend: 'container',
      verifyTimeoutMs: 30_000, verifyOutputCapBytes: 1024,
    });
    expect(result.state).toBe('ready');
    expect(result.snapshot.policy).toMatchObject({
      verificationWorkspace: 'container', sandboxBackend: 'container',
      verifyTimeoutMs: 30_000, verifyOutputCapBytes: 1024,
    });
    expect(Object.isFrozen(result.snapshot)).toBe(true);
  });

  it('flags an unknown verification workspace strategy', () => {
    const result = resolve({ verificationWorkspace: 'docker' });
    expect(result.state).toBe('needs_setup');
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'verification_workspace_unknown',
    }));
  });

  it('flags an unknown sandbox backend', () => {
    const result = resolve({ sandboxBackend: 'docker' });
    expect(result.state).toBe('needs_setup');
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'sandbox_backend_unknown' }));
  });

  it('defaults the accepted strategy sets to git-snapshot and host', () => {
    const workspace = new CrewProfileResolver().resolve({
      savedProfile: profile({ verificationWorkspace: 'git-snapshot' }),
      catalog, resolvedVerifyCommand: 'bun test',
    });
    const unknown = new CrewProfileResolver().resolve({
      savedProfile: profile({ verificationWorkspace: 'container' }),
      catalog, resolvedVerifyCommand: 'bun test',
    });
    expect(workspace.state).toBe('ready');
    expect(unknown.issues.map((issue) => issue.code)).toContain('verification_workspace_unknown');
  });

  it.each([
    [{ verifyTimeoutMs: 0 }],
    [{ verifyTimeoutMs: -1 }],
    [{ verifyTimeoutMs: 1.5 }],
    [{ verifyOutputCapBytes: 0 }],
    [{ verifyOutputCapBytes: -10 }],
    [{ verifyOutputCapBytes: 64 * 1024 * 1024 + 1 }],
    [{ verifyOutputCapBytes: 100.5 }],
  ])('flags an out-of-bounds resource limit %o', (policy) => {
    const result = resolve(policy);
    expect(result.state).toBe('needs_setup');
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'verify_limit_invalid' }));
  });

  it('accepts resource limits at the exact boundaries', () => {
    const result = resolve({ verifyTimeoutMs: 1, verifyOutputCapBytes: 64 * 1024 * 1024 });
    expect(result.state).toBe('ready');
  });
});
