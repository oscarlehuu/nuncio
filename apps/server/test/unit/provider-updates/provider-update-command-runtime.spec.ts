import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import {
  fetchNpmLatestVersion,
  providerUpdateEnv,
  providerUpdatePath,
  resolveRealCommandPath,
  runCommand,
} from '../../../src/provider-updates/provider-update-command-runtime';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('provider update command runtime', () => {
  it('fetchNpmLatestVersion returns the latest version from npm metadata', async () => {
    globalThis.fetch = (async () =>
      Response.json({ version: '1.2.3' })) as typeof fetch;

    await expect(fetchNpmLatestVersion('@openai/codex')).resolves.toBe('1.2.3');
  });

  it('fetchNpmLatestVersion returns null on non-ok responses', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
    await expect(fetchNpmLatestVersion('@openai/codex')).resolves.toBeNull();
  });

  it('fetchNpmLatestVersion returns null when fetch throws', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    await expect(fetchNpmLatestVersion('@openai/codex')).resolves.toBeNull();
  });

  it('providerUpdatePath appends fallback directories without duplicates', () => {
    const merged = providerUpdatePath('/opt/homebrew/bin:/usr/bin');
    expect(merged.startsWith('/opt/homebrew/bin:/usr/bin')).toBe(true);
    expect(merged).toContain(`${process.env.HOME ?? ''}/.bun/bin`);
    expect(providerUpdatePath('/opt/homebrew/bin:/usr/bin').split(':')).toEqual(
      providerUpdatePath('/opt/homebrew/bin:/usr/bin').split(':'),
    );
  });

  it('providerUpdateEnv injects the merged PATH', () => {
    const env = providerUpdateEnv({ PATH: '/custom/bin', FOO: 'bar' });
    expect(env.FOO).toBe('bar');
    expect(env.PATH).toContain('/custom/bin');
    expect(env.PATH).toContain('/usr/bin');
  });

  it('resolveRealCommandPath resolves an absolute binary when it exists', () => {
    const nodePath = process.execPath;
    expect(resolveRealCommandPath(nodePath)).toBeTruthy();
    expect(existsSync(resolveRealCommandPath(nodePath)!)).toBe(true);
  });

  it('resolveRealCommandPath returns null for unknown commands', () => {
    expect(resolveRealCommandPath('definitely-not-a-real-binary-xyz')).toBeNull();
  });

  it('runCommand executes a process and captures stdout', async () => {
    const result = await runCommand(process.execPath, ['-e', "process.stdout.write('hello')"], {
      timeoutMs: 5_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('hello');
    expect(result.timedOut).toBeUndefined();
  });
});
