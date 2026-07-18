import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  evaluateGateIntegrity,
  isGateProtectedPath,
} from '../../../src/agents/pi-engine/gate-integrity';

describe('isGateProtectedPath', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'nuncio-gate-')));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('blocks direct paths inside the gate directory', () => {
    expect(isGateProtectedPath(workspace, '.nuncio/verify')).toBe(true);
    expect(isGateProtectedPath(workspace, join(workspace, '.nuncio', 'verify'))).toBe(true);
    expect(isGateProtectedPath(workspace, '.nuncio')).toBe(true);
  });

  it('blocks nested gate directories at any depth', () => {
    expect(isGateProtectedPath(workspace, 'packages/app/.nuncio/verify')).toBe(true);
  });

  it('blocks dot-dot traversal that lands inside a gate directory', () => {
    expect(isGateProtectedPath(workspace, 'src/../.nuncio/verify')).toBe(true);
  });

  it('allows sibling names that merely contain the token', () => {
    expect(isGateProtectedPath(workspace, 'nuncio-x/file.ts')).toBe(false);
    expect(isGateProtectedPath(workspace, 'src/.nuncio.bak/file')).toBe(false);
    expect(isGateProtectedPath(workspace, 'src/service.ts')).toBe(false);
  });

  it('blocks a symlink escape into the gate directory', () => {
    mkdirSync(join(workspace, '.nuncio'), { recursive: true });
    writeFileSync(join(workspace, '.nuncio', 'verify'), 'exit 0\n');
    symlinkSync(join(workspace, '.nuncio'), join(workspace, 'harmless'));
    expect(isGateProtectedPath(workspace, 'harmless/verify')).toBe(true);
  });

  it('allows a symlink that points somewhere harmless', () => {
    mkdirSync(join(workspace, 'real-src'), { recursive: true });
    symlinkSync(join(workspace, 'real-src'), join(workspace, 'linked-src'));
    expect(isGateProtectedPath(workspace, 'linked-src/file.ts')).toBe(false);
  });
});

describe('evaluateGateIntegrity', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'nuncio-gate-eval-')));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  function verdict(toolName: string, input: Record<string, unknown>) {
    return evaluateGateIntegrity(workspace, { toolName, input });
  }

  it('blocks edit and write targeting the gate directory', () => {
    expect(verdict('edit', { path: '.nuncio/verify' })).toMatchObject({ block: true });
    expect(verdict('write', { path: '.nuncio/verify' })).toMatchObject({ block: true });
    expect(verdict('write', { path: join(workspace, '.nuncio', 'verify') })).toMatchObject({
      block: true,
    });
  });

  it('allows edit and write elsewhere', () => {
    expect(verdict('edit', { path: 'src/app.ts' })).toBeUndefined();
    expect(verdict('write', { path: 'nuncio-notes.md' })).toBeUndefined();
  });

  it('allows reads of the gate directory', () => {
    expect(verdict('read', { path: '.nuncio/verify' })).toBeUndefined();
    expect(verdict('ls', { path: '.nuncio' })).toBeUndefined();
    expect(verdict('grep', { pattern: 'x', path: '.nuncio' })).toBeUndefined();
  });

  it('advisory-blocks bash commands that mutate the gate directory', () => {
    expect(verdict('bash', { command: 'echo hacked > .nuncio/verify' })).toMatchObject({
      block: true,
    });
    expect(verdict('bash', { command: 'rm -rf .nuncio' })).toMatchObject({ block: true });
    expect(verdict('bash', { command: "sed -i '' -e s/a/b/ .nuncio/verify" })).toMatchObject({
      block: true,
    });
    expect(verdict('bash', { command: 'chmod +x .nuncio/verify' })).toMatchObject({ block: true });
  });

  it('advisory-blocks absolute-path and git-restore mutations of the gate directory', () => {
    expect(
      verdict('bash', { command: `echo hacked > ${workspace}/.nuncio/verify` }),
    ).toMatchObject({ block: true });
    expect(verdict('bash', { command: 'git checkout -- .nuncio/verify' })).toMatchObject({
      block: true,
    });
    expect(verdict('bash', { command: 'git restore .nuncio/verify' })).toMatchObject({
      block: true,
    });
  });

  it('allows bash commands that only read the gate directory', () => {
    expect(verdict('bash', { command: 'cat .nuncio/verify' })).toBeUndefined();
    expect(verdict('bash', { command: 'ls .nuncio' })).toBeUndefined();
    expect(verdict('bash', { command: 'sh .nuncio/verify' })).toBeUndefined();
  });

  it('ignores unrelated bash commands and malformed inputs', () => {
    expect(verdict('bash', { command: 'bun test > out.log' })).toBeUndefined();
    expect(verdict('bash', {})).toBeUndefined();
    expect(verdict('edit', {})).toBeUndefined();
    expect(verdict('write', { path: 42 })).toBeUndefined();
  });

  it('explains the block so the agent can relay it to the user', () => {
    const result = verdict('write', { path: '.nuncio/verify' });
    expect(result?.reason).toContain('.nuncio');
    expect(result?.reason?.toLowerCase()).toContain('harness');
  });
});
