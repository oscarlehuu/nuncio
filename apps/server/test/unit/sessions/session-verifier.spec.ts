import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveVerifyCommand,
  runVerifyCommand,
} from '../../../src/sessions/session-verifier';

describe('resolveVerifyCommand', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'nuncio-verify-resolve-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('prefers the project .nuncio/verify script over the setting', () => {
    mkdirSync(join(workspace, '.nuncio'));
    writeFileSync(join(workspace, '.nuncio', 'verify'), 'exit 0\n');

    const command = resolveVerifyCommand(workspace, 'bun test');
    expect(command?.source).toBe('project-file');
    expect(command?.argv).toEqual(['sh', join(workspace, '.nuncio', 'verify')]);
  });

  it('falls back to the setting command when no project script exists', () => {
    const command = resolveVerifyCommand(workspace, '  bun test  ');
    expect(command?.source).toBe('setting');
    expect(command?.argv).toEqual(['sh', '-c', 'bun test']);
    expect(command?.display).toBe('bun test');
  });

  it('returns null when neither source provides a command', () => {
    expect(resolveVerifyCommand(workspace, undefined)).toBeNull();
    expect(resolveVerifyCommand(workspace, '   ')).toBeNull();
  });
});

describe('runVerifyCommand', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'nuncio-verify-run-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('reports a passing command with its output tail', async () => {
    const result = await runVerifyCommand(
      { argv: ['sh', '-c', 'echo all-good'], display: 'echo all-good', source: 'setting' },
      workspace,
    );
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.outputTail).toContain('all-good');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a failing command with stderr in the tail', async () => {
    const result = await runVerifyCommand(
      { argv: ['sh', '-c', 'echo broken >&2; exit 3'], display: 'fail', source: 'setting' },
      workspace,
    );
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.outputTail).toContain('broken');
  });

  it('kills and flags a command that exceeds the timeout', async () => {
    const result = await runVerifyCommand(
      { argv: ['sh', '-c', 'sleep 5'], display: 'sleep', source: 'setting' },
      workspace,
      200,
    );
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  it('keeps only the tail of a long output', async () => {
    const result = await runVerifyCommand(
      {
        argv: ['sh', '-c', 'yes long-line | head -n 2000; echo THE-END'],
        display: 'long',
        source: 'setting',
      },
      workspace,
    );
    expect(result.outputTail.length).toBeLessThanOrEqual(4000);
    expect(result.outputTail).toContain('THE-END');
  });
});
