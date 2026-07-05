import { describe, expect, it } from 'bun:test';
import {
  discoverCodexCliCandidates,
  resolveCodexCli,
  type CodexCliCommandRunner,
} from '../../../src/agents/providers/codex-cli-resolver';

const okRunner: CodexCliCommandRunner = async (command, args) => {
  if (args[0] === '--version') {
    return { status: 0, stdout: `${command} codex-cli 0.142.5`, stderr: '' };
  }
  if (args.join(' ') === 'login status') {
    return { status: 0, stdout: 'Logged in using ChatGPT', stderr: '' };
  }
  return { status: 1, stdout: '', stderr: 'unexpected' };
};

describe('codex-cli-resolver', () => {
  it('uses an explicit Codex binary without scanning other candidates', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const resolution = await resolveCodexCli({
      configuredPath: '~/bin/codex-canary',
      env: { HOME: '/Users/test' },
      candidatePaths: ['/other/codex'],
      commandRunner: async (command, args) => {
        calls.push({ command, args });
        return okRunner(command, args, { env: {} });
      },
    });

    expect(resolution.status).toBe('ready');
    expect(resolution.binaryPath).toBe('/Users/test/bin/codex-canary');
    expect(resolution.explicit).toBe(true);
    expect(calls.map((call) => call.command)).toEqual([
      '/Users/test/bin/codex-canary',
      '/Users/test/bin/codex-canary',
    ]);
  });

  it('auto-selects the only logged-in discovered Codex CLI', async () => {
    const resolution = await resolveCodexCli({
      configuredPath: 'codex',
      env: {},
      candidatePaths: ['/opt/codex/bin/codex'],
      commandRunner: okRunner,
    });

    expect(resolution.status).toBe('ready');
    expect(resolution.binaryPath).toBe('/opt/codex/bin/codex');
    expect(resolution.explicit).toBe(false);
  });

  it('requires an explicit selection when multiple logged-in Codex CLIs are discovered', async () => {
    const resolution = await resolveCodexCli({
      configuredPath: 'codex',
      env: {},
      candidatePaths: [
        '/Users/test/.local/bin/codex',
        '/opt/homebrew/bin/codex',
        '/tmp/codex-nightly/bin/codex',
      ],
      commandRunner: okRunner,
    });

    expect(resolution.status).toBe('ambiguous');
    expect(resolution.binaryPath).toBeUndefined();
    expect(resolution.reason).toContain('Multiple logged-in Codex CLIs found');
    expect(resolution.reason).toContain('/Users/test/.local/bin/codex');
    expect(resolution.reason).toContain('/opt/homebrew/bin/codex');
    expect(resolution.reason).toContain('/tmp/codex-nightly/bin/codex');
  });

  it('deduplicates discovered candidates by real path while keeping the preferred entrypoint', () => {
    const candidates = discoverCodexCliCandidates({
      env: {
        HOME: '/Users/test',
        PATH: '/Users/test/.local/bin:/opt/homebrew/bin',
      },
      pathExists: (path) =>
        path === '/Users/test/.local/bin/codex' || path === '/opt/homebrew/bin/codex',
      realpath: (path) =>
        path === '/opt/homebrew/bin/codex'
          ? '/Users/test/.codex/packages/standalone/releases/0.142.5/bin/codex'
          : '/Users/test/.codex/packages/standalone/releases/0.142.5/bin/codex',
      listReleaseBins: () => [
        '/Users/test/.codex/packages/standalone/releases/0.142.5/bin/codex',
      ],
    });

    expect(candidates).toEqual(['/Users/test/.local/bin/codex']);
  });
});
