import { describe, expect, it } from 'bun:test';
import {
  NUNCIO_ENGINE_PROVIDER_ID,
  resolveDefaultRuntimePolicy,
} from '../../../src/agents/default-runtime-policy';

const WORKSPACE_WRITE_CAPABLE = {
  runtimePolicies: [
    { filesystem: 'read-only' as const, network: 'disabled' as const },
    { filesystem: 'workspace-write' as const, network: 'disabled' as const },
  ],
};

function input(overrides: Record<string, unknown> = {}) {
  return {
    providerId: NUNCIO_ENGINE_PROVIDER_ID,
    capabilities: WORKSPACE_WRITE_CAPABLE,
    hasExplicitPolicy: false,
    workspace: '/tmp/project',
    confinementEnabled: true,
    ...overrides,
  } as Parameters<typeof resolveDefaultRuntimePolicy>[0];
}

describe('resolveDefaultRuntimePolicy', () => {
  it('assigns a workspace-write policy rooted at the workspace for a Nuncio Engine session', () => {
    expect(resolveDefaultRuntimePolicy(input())).toEqual({
      filesystem: 'workspace-write',
      workspaceRoot: '/tmp/project',
      network: 'disabled',
    });
  });

  it('returns null for an ad-hoc session with no workspace', () => {
    expect(resolveDefaultRuntimePolicy(input({ workspace: undefined }))).toBeNull();
    expect(resolveDefaultRuntimePolicy(input({ workspace: null }))).toBeNull();
    expect(resolveDefaultRuntimePolicy(input({ workspace: '   ' }))).toBeNull();
  });

  it('defers to an explicit policy — the operator asked for a specific one', () => {
    expect(resolveDefaultRuntimePolicy(input({ hasExplicitPolicy: true }))).toBeNull();
  });

  it('returns null when confinement is globally disabled (opt-out)', () => {
    expect(resolveDefaultRuntimePolicy(input({ confinementEnabled: false }))).toBeNull();
  });

  it('does not confine legacy vendor engines', () => {
    for (const providerId of ['cursor', 'codex', 'claude']) {
      expect(resolveDefaultRuntimePolicy(input({ providerId }))).toBeNull();
    }
  });

  it('falls back to none when the engine cannot enforce workspace-write', () => {
    expect(
      resolveDefaultRuntimePolicy(
        input({ capabilities: { runtimePolicies: [{ filesystem: 'read-only', network: 'disabled' }] } }),
      ),
    ).toBeNull();
    expect(
      resolveDefaultRuntimePolicy(input({ capabilities: { runtimePolicies: undefined } })),
    ).toBeNull();
    expect(resolveDefaultRuntimePolicy(input({ capabilities: {} }))).toBeNull();
  });
});
