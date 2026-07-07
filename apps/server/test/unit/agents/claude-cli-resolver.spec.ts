import { describe, it, expect } from 'bun:test';
import {
  parseAuthStatus,
  resolveClaudeCli,
  type ClaudeCliCommandRunner,
} from '../../../src/agents/providers/claude-cli-resolver';

function runnerReturning(
  status: number | null,
  stdout: string,
  seen?: (command: string) => void,
): ClaudeCliCommandRunner {
  return async (command) => {
    seen?.(command);
    return { status, stdout, stderr: '' };
  };
}

const LOGGED_IN = JSON.stringify({ loggedIn: true, subscriptionType: 'max', email: 'x@y.z' });
const LOGGED_OUT = JSON.stringify({ loggedIn: false });

describe('parseAuthStatus', () => {
  it('parses a clean JSON object', () => {
    expect(parseAuthStatus(LOGGED_IN)).toEqual({
      loggedIn: true,
      subscriptionType: 'max',
      email: 'x@y.z',
    });
  });

  it('extracts the JSON object even with surrounding log noise', () => {
    const noisy = `some log line\n${LOGGED_IN}\ntrailing`;
    expect(parseAuthStatus(noisy)?.loggedIn).toBe(true);
  });

  it('returns null for empty or unparseable output', () => {
    expect(parseAuthStatus('')).toBeNull();
    expect(parseAuthStatus('not json at all')).toBeNull();
  });

  it('treats a missing loggedIn field as not logged in', () => {
    expect(parseAuthStatus(JSON.stringify({ email: 'a@b.c' }))?.loggedIn).toBe(false);
  });
});

describe('resolveClaudeCli', () => {
  it('reports ready when the bundled binary is logged in', async () => {
    const resolution = await resolveClaudeCli({
      bundledBinaryPath: '/bundled/claude',
      commandRunner: runnerReturning(0, LOGGED_IN),
    });
    expect(resolution.status).toBe('ready');
    expect(resolution.loggedIn).toBe(true);
    expect(resolution.binaryPath).toBe('/bundled/claude');
    expect(resolution.explicit).toBe(false);
  });

  it('reports not-logged-in when auth status says so', async () => {
    const resolution = await resolveClaudeCli({
      bundledBinaryPath: '/bundled/claude',
      commandRunner: runnerReturning(0, LOGGED_OUT),
    });
    expect(resolution.status).toBe('not-logged-in');
    expect(resolution.loggedIn).toBe(false);
  });

  it('reports not-found when no binary is available', async () => {
    const resolution = await resolveClaudeCli({
      bundledBinaryPath: null,
      commandRunner: runnerReturning(0, LOGGED_IN),
    });
    expect(resolution.status).toBe('not-found');
    expect(resolution.loggedIn).toBe(false);
  });

  it('reports invalid when the probe output is not parseable JSON', async () => {
    const resolution = await resolveClaudeCli({
      bundledBinaryPath: '/bundled/claude',
      commandRunner: runnerReturning(1, 'command not found'),
    });
    expect(resolution.status).toBe('invalid');
  });

  it('NUNCIO_CLAUDE_BIN override wins over the bundled binary', async () => {
    let probed: string | undefined;
    const resolution = await resolveClaudeCli({
      configuredPath: '/custom/claude',
      bundledBinaryPath: '/bundled/claude',
      commandRunner: runnerReturning(0, LOGGED_IN, (command) => {
        probed = command;
      }),
    });
    expect(resolution.explicit).toBe(true);
    expect(resolution.binaryPath).toBe('/custom/claude');
    expect(probed).toBe('/custom/claude');
  });

  it('reports invalid when the command runner throws', async () => {
    const resolution = await resolveClaudeCli({
      bundledBinaryPath: '/bundled/claude',
      commandRunner: async () => {
        throw new Error('spawn EACCES');
      },
    });
    expect(resolution.status).toBe('invalid');
    expect(resolution.reason).toContain('spawn EACCES');
  });
});
