import { describe, expect, it } from 'bun:test';
import {
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
});
