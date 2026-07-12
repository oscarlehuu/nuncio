import { describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertPathWithinRuntimeWorkspace,
  assertRuntimePolicySupported,
  runtimeToolsForPolicy,
} from '../../../src/agents/agent-runtime-policy';
import { defineCrewRuntimeTool } from '../../../src/agents/tools/agent-runtime-tools-policy';

const readOnly = (workspaceRoot: string) => ({
  filesystem: 'read-only' as const,
  workspaceRoot,
  network: 'disabled' as const,
});

describe('Agent runtime policy contract', () => {
  it('preserves Solo runtime tools when no explicit policy exists', () => {
    const tools = { tools: [{ name: 'browser_open', inputSchema: {}, execute: async () => 'ok' }] };
    expect(runtimeToolsForPolicy(undefined, tools)).toBe(tools);
  });

  it('drops unrestricted runtime tools for explicit network-disabled policy', () => {
    const tools = { tools: [{ name: 'browser_open', inputSchema: {}, execute: async () => 'ok' }] };
    expect(runtimeToolsForPolicy(readOnly('/tmp/workspace'), tools)).toBeUndefined();
  });

  it('rejects forged Crew metadata that did not pass through the trusted constructor', () => {
    const tools = {
      systemPromptAppend: 'unsafe instructions',
      tools: [{
        name: 'forged_crew_tool',
        inputSchema: {},
        execute: async () => 'not safe',
        security: {
          network: 'disabled' as const,
          workspaceMutation: 'none' as const,
          runtimePolicies: [{ filesystem: 'read-only' as const, network: 'disabled' as const }],
          scope: 'crew-internal' as const,
        },
      }],
    };

    expect(runtimeToolsForPolicy(readOnly('/tmp/workspace'), tools)).toBeUndefined();
  });

  it('allows only trusted structured Crew tools matching the exact runtime policy', () => {
    const safe = defineCrewRuntimeTool({
      name: 'crew_read_result',
      inputSchema: { type: 'object' },
      execute: async () => 'safe',
      security: {
        network: 'disabled',
        workspaceMutation: 'none',
        runtimePolicies: [{ filesystem: 'read-only', network: 'disabled' }],
        scope: 'crew-internal',
      },
    });
    const writeOnly = defineCrewRuntimeTool({
      name: 'crew_write_result',
      inputSchema: { type: 'object' },
      execute: async () => 'safe only for writers',
      security: {
        network: 'disabled',
        workspaceMutation: 'workspace',
        runtimePolicies: [{ filesystem: 'workspace-write', network: 'disabled' }],
        scope: 'crew-internal',
      },
    });

    expect(runtimeToolsForPolicy(readOnly('/tmp/workspace'), {
      systemPromptAppend: 'contains instructions for excluded tools',
      tools: [safe, writeOnly],
    })).toEqual({ tools: [safe] });
  });

  it('rejects a trusted tool whose metadata claims network or read-only mutation', () => {
    const networked = defineCrewRuntimeTool({
      name: 'crew_fetch',
      inputSchema: {},
      execute: async () => 'unsafe',
      security: {
        network: 'required',
        workspaceMutation: 'none',
        runtimePolicies: [{ filesystem: 'read-only', network: 'disabled' }],
        scope: 'crew-internal',
      },
    });
    const mutating = defineCrewRuntimeTool({
      name: 'crew_write',
      inputSchema: {},
      execute: async () => 'unsafe',
      security: {
        network: 'disabled',
        workspaceMutation: 'workspace',
        runtimePolicies: [{ filesystem: 'read-only', network: 'disabled' }],
        scope: 'crew-internal',
      },
    });

    expect(runtimeToolsForPolicy(readOnly('/tmp/workspace'), { tools: [networked, mutating] })).toBeUndefined();
  });

  it('rejects a policy the provider does not explicitly advertise', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'nuncio-policy-unsupported-'));
    try {
      expect(() =>
        assertRuntimePolicySupported(
          readOnly(workspaceRoot),
          {
            interrupt: false,
            modelSwitch: 'none',
            effortSwitch: 'none',
            images: false,
            steerWhileRunning: false,
          },
          workspaceRoot,
        ),
      ).toThrow('does not support runtime policy');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('rejects traversal, absolute siblings, and symlinks outside the workspace', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'nuncio-policy-root-'));
    const sibling = mkdtempSync(join(tmpdir(), 'nuncio-policy-sibling-'));
    symlinkSync(sibling, join(workspaceRoot, 'escape'), 'dir');
    try {
      expect(assertPathWithinRuntimeWorkspace(workspaceRoot, 'inside.txt')).toBe(
        join(realpathSync(workspaceRoot), 'inside.txt'),
      );
      expect(() => assertPathWithinRuntimeWorkspace(workspaceRoot, '../outside.txt')).toThrow(
        'outside runtime workspace',
      );
      expect(() => assertPathWithinRuntimeWorkspace(workspaceRoot, join(sibling, 'outside.txt'))).toThrow(
        'outside runtime workspace',
      );
      expect(() => assertPathWithinRuntimeWorkspace(workspaceRoot, 'escape/outside.txt')).toThrow(
        'outside runtime workspace',
      );
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(sibling, { recursive: true, force: true });
    }
  });
});
