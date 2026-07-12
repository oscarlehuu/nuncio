import { describe, it, expect } from 'bun:test';
import {
  PI_EXTENSION_ALLOWLIST,
  piEngineExtensionPaths,
} from '../../../src/agents/pi-engine/extension-allowlist';

describe('pi-engine extension allowlist', () => {
  it('resolves every allowlisted name under agentDir/extensions', () => {
    const paths = piEngineExtensionPaths('/tmp/agent');
    expect(paths).toHaveLength(PI_EXTENSION_ALLOWLIST.length);
    for (const path of paths) {
      expect(path.startsWith('/tmp/agent/extensions/')).toBe(true);
    }
    expect(paths).toContain('/tmp/agent/extensions/foreman');
    expect(paths).toContain('/tmp/agent/extensions/subagent');
  });

  it('excludes TUI-only and core-rebinding extensions', () => {
    for (const denied of ['claude-studio', 'statusline', 'worktree-dash', 'session-namer', 'pocketpi', 'continual-learning']) {
      expect(PI_EXTENSION_ALLOWLIST).not.toContain(denied);
    }
  });
});
