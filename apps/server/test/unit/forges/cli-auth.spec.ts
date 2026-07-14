import { afterEach, describe, expect, it } from 'bun:test';
import {
  cliAuthPath,
  githubCliToken,
  gitlabCliToken,
  type CliAuthRunner,
} from '../../../src/forges/cli-auth';

function runner(result: Awaited<ReturnType<CliAuthRunner>>): CliAuthRunner {
  return async () => result;
}

function throwingRunner(): CliAuthRunner {
  return async () => {
    throw new Error('missing binary');
  };
}

describe('forge CLI auth helpers', () => {
  describe('githubCliToken', () => {
    it('returns the trimmed gh token on a successful token-like response', async () => {
      const token = await githubCliToken(runner({ exitCode: 0, stdout: 'ghp_abc123\n', stderr: '' }));
      expect(token).toBe('ghp_abc123');
    });

    it('returns null on non-zero exit', async () => {
      const token = await githubCliToken(runner({ exitCode: 1, stdout: 'ghp_abc123\n', stderr: 'no auth' }));
      expect(token).toBeNull();
    });

    it('returns null when the command cannot be spawned', async () => {
      const token = await githubCliToken(throwingRunner());
      expect(token).toBeNull();
    });

    it('returns null when stdout is empty or contains whitespace inside the token', async () => {
      await expect(githubCliToken(runner({ exitCode: 0, stdout: '  \n', stderr: '' }))).resolves.toBeNull();
      await expect(githubCliToken(runner({ exitCode: 0, stdout: 'ghp abc\n', stderr: '' }))).resolves.toBeNull();
    });
  });

  describe('cliAuthPath', () => {
    it('appends common CLI install dirs so Finder-launched apps can find gh/glab', () => {
      const path = cliAuthPath('/usr/bin:/bin');
      const dirs = path.split(':');
      expect(dirs).toContain('/usr/bin');
      expect(dirs).toContain('/opt/homebrew/bin');
      expect(dirs).toContain('/usr/local/bin');
    });

    it('keeps the existing PATH ahead of the fallbacks', () => {
      const path = cliAuthPath('/custom/bin:/usr/bin');
      expect(path.startsWith('/custom/bin:/usr/bin')).toBe(true);
    });

    it('does not duplicate a fallback dir already on PATH', () => {
      const path = cliAuthPath('/opt/homebrew/bin:/usr/bin');
      const occurrences = path.split(':').filter((dir) => dir === '/opt/homebrew/bin');
      expect(occurrences).toHaveLength(1);
    });

    it('handles an empty or undefined PATH', () => {
      expect(cliAuthPath('').split(':')).toContain('/opt/homebrew/bin');
      expect(cliAuthPath(undefined).split(':')).toContain('/opt/homebrew/bin');
    });
  });

  describe('gitlabCliToken', () => {
    it('parses Token found from glab auth status stderr', async () => {
      const stderr = [
        'gitlab.com',
        '  ✓ Logged in to gitlab.com as oscar.lehuu (/Users/oscar/.config/glab-cli/config.yml)',
        '  ✓ Token found: glpat-abc123',
      ].join('\n');
      const token = await gitlabCliToken(runner({ exitCode: 0, stdout: '', stderr }));
      expect(token).toBe('glpat-abc123');
    });

    it('also parses Token found from stdout', async () => {
      const token = await gitlabCliToken(
        runner({ exitCode: 0, stdout: '✓ Token found: glpat-from-stdout\n', stderr: '' }),
      );
      expect(token).toBe('glpat-from-stdout');
    });

    it('returns null when no token line is present', async () => {
      const token = await gitlabCliToken(
        runner({ exitCode: 0, stdout: '', stderr: '✓ Logged in to gitlab.com as tanuki' }),
      );
      expect(token).toBeNull();
    });

    it('returns null on command failure or missing binary', async () => {
      await expect(gitlabCliToken(runner({ exitCode: 1, stdout: '', stderr: 'no auth' }))).resolves.toBeNull();
      await expect(gitlabCliToken(throwingRunner())).resolves.toBeNull();
    });
  });

  describe('runCli integration via default runner', () => {
    const originalSpawn = Bun.spawn;

    afterEach(() => {
      Bun.spawn = originalSpawn;
    });

    it('githubCliToken reads a token from a mocked gh spawn', async () => {
      Bun.spawn = ((_cmd: string[], _opts?: object) => ({
        stdout: new Response('ghp_spawned_token\n').body,
        stderr: new Response('').body,
        exited: Promise.resolve(0),
        kill() {},
      })) as typeof Bun.spawn;
      await expect(githubCliToken()).resolves.toBe('ghp_spawned_token');
    });

    it('githubCliToken returns null when the mocked spawn times out', async () => {
      Bun.spawn = ((_cmd: string[], _opts?: object) => ({
        stdout: new Response('').body,
        stderr: new Response('').body,
        exited: new Promise(() => {}),
        kill() {},
      })) as typeof Bun.spawn;
      await expect(githubCliToken()).resolves.toBeNull();
    }, 10_000);

    it('gitlabCliToken reads stderr from a mocked glab spawn', async () => {
      Bun.spawn = ((_cmd: string[], _opts?: object) => ({
        stdout: new Response('').body,
        stderr: new Response('✓ Token found: glpat_spawned\n').body,
        exited: Promise.resolve(0),
        kill() {},
      })) as typeof Bun.spawn;
      await expect(gitlabCliToken()).resolves.toBe('glpat_spawned');
    });
  });
});
