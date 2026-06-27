import { describe, it, expect } from 'bun:test';
import { buildPiCwdOptions, buildPiCustomTools } from '../../../src/agents/providers/pi-agent.provider';

// Pure unit tests for the Pi cwd wiring. These exercise the option-building
// helpers with stub factories — no real Pi SDK, no auth, no module mocking — so
// they are deterministic in CI (the previous mock.module approach raced with the
// SDK dynamic import in CI). End-to-end behavior with real Pi is covered by
// pi-agent.integration.spec.ts (gated on ~/.pi/agent/auth.json).

describe('buildPiCwdOptions', () => {
  it('passes cwd + inMemory(cwd) when cwd is set', () => {
    const calls: Array<string | undefined> = [];
    const inMemory = (cwd?: string) => {
      calls.push(cwd);
      return { kind: 'inMemory', cwd };
    };

    const opts = buildPiCwdOptions('/tmp/workspaces/abc', inMemory);

    expect(opts.cwd).toBe('/tmp/workspaces/abc');
    expect(opts.sessionManager).toEqual({ kind: 'inMemory', cwd: '/tmp/workspaces/abc' });
    expect(calls).toEqual(['/tmp/workspaces/abc']);
  });

  it('omits cwd and calls inMemory() with no argument when cwd is absent', () => {
    const calls: Array<string | undefined> = [];
    const inMemory = (cwd?: string) => {
      calls.push(cwd);
      return { kind: 'inMemory' };
    };

    const opts = buildPiCwdOptions(undefined, inMemory);

    expect(opts.cwd).toBeUndefined();
    expect(calls).toEqual([undefined]);
  });
});

describe('buildPiCustomTools', () => {
  const makeFactories = (log: Array<{ kind: string; cwd: string }>) => ({
    createReadTool: (cwd: string) => { log.push({ kind: 'read', cwd }); return { name: 'read' }; },
    createBashTool: (cwd: string) => { log.push({ kind: 'bash', cwd }); return { name: 'bash' }; },
    createEditTool: (cwd: string) => { log.push({ kind: 'edit', cwd }); return { name: 'edit' }; },
    createWriteTool: (cwd: string) => { log.push({ kind: 'write', cwd }); return { name: 'write' }; },
    createGrepTool: (cwd: string) => { log.push({ kind: 'grep', cwd }); return { name: 'grep' }; },
    createFindTool: (cwd: string) => { log.push({ kind: 'find', cwd }); return { name: 'find' }; },
    createLsTool: (cwd: string) => { log.push({ kind: 'ls', cwd }); return { name: 'ls' }; },
  });

  it('returns all 7 built-in tools bound to the worktree cwd when cwd is set', () => {
    const log: Array<{ kind: string; cwd: string }> = [];
    const tools = buildPiCustomTools('/tmp/workspaces/abc', makeFactories(log));

    expect(tools).toBeDefined();
    expect(tools?.length).toBe(7);
    expect(log.length).toBe(7);
    for (const { cwd } of log) {
      expect(cwd).toBe('/tmp/workspaces/abc');
    }
    expect(log.map((e) => e.kind).sort()).toEqual(
      ['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write'].sort(),
    );
  });

  it('returns undefined and calls no factories when cwd is absent', () => {
    const log: Array<{ kind: string; cwd: string }> = [];
    const tools = buildPiCustomTools(undefined, makeFactories(log));

    expect(tools).toBeUndefined();
    expect(log).toHaveLength(0);
  });
});
