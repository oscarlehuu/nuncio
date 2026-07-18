// Extraction integrity for the recorded-session → eval-task path. A real
// session's prompt/steers/verify data become an eval task JSON; the repo state
// is replayed via a { repo, baseSha } fixture the runner clones at a pinned
// SHA. Runs under `bun run test:scripts`.
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  buildTaskFromSession,
  buildRepoWorkspace,
  earliestRecordedHead,
  extractOriginalPrompt,
  promptWithSteers,
  taskSlug,
} = await import('./lib/eval-extract.mjs');
const { validateTask } = await import('./lib/eval-suite.mjs');

function git(cwd, ...args) {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

const cleanups = [];
afterEach(() => {
  while (cleanups.length) rmSync(cleanups.pop(), { recursive: true, force: true });
});

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

const baseSession = {
  id: 'sess-1',
  prompt: 'Fix the failing slugify test in src/slugify.ts',
  projectPath: '/tmp/some-repo',
  verifyOwner: 'session',
  provider: 'pi',
};

const verifyEvents = [
  { type: 'user_message', payload: { text: 'Fix the failing slugify test in src/slugify.ts' } },
  { type: 'verify_start', payload: { command: 'bun test' } },
  { type: 'verify_result', payload: { command: 'bun test', ok: true } },
];

describe('buildTaskFromSession', () => {
  test('extracts prompt, verify command, repo pin and human steers', () => {
    const events = [
      ...verifyEvents,
      { type: 'steer_message', payload: { text: 'also update the README' } },
      { type: 'steer_message', payload: { text: 'auto', origin: 'verify_retry' } },
    ];
    const task = buildTaskFromSession(baseSession, events, { baseSha: 'abc123', slug: 'fix-slugify' });
    expect(task).toMatchObject({
      id: 'fix-slugify',
      prompt: 'Fix the failing slugify test in src/slugify.ts',
      fixture: { repo: '/tmp/some-repo', baseSha: 'abc123' },
      verifyCommand: 'bun test',
      tags: ['recorded'],
      expect: { verifyPassed: true },
    });
    // Human steers are preserved for curation; tagged auto-steers are not.
    expect(task.followUpSteers).toEqual(['also update the README']);
    expect(Number.isInteger(task.timeoutMs)).toBe(true);
  });

  test('the generated task passes the suite validator', () => {
    const task = buildTaskFromSession(baseSession, verifyEvents, { baseSha: 'abc123' });
    expect(() => validateTask(task, `${task.id}.json`)).not.toThrow();
  });

  test('rejects a crew-owned session', () => {
    expect(() =>
      buildTaskFromSession({ ...baseSession, verifyOwner: 'crew' }, verifyEvents, { baseSha: 'a' }),
    ).toThrow(/crew/i);
  });

  test('rejects a session without a workspace', () => {
    expect(() =>
      buildTaskFromSession({ ...baseSession, projectPath: null }, verifyEvents, { baseSha: 'a' }),
    ).toThrow(/workspace|project/i);
  });

  test('requires a verify command when the log has none (forces curation)', () => {
    const noVerify = [{ type: 'user_message', payload: { text: 'hi' } }];
    expect(() => buildTaskFromSession(baseSession, noVerify, { baseSha: 'a' })).toThrow(
      /verify/i,
    );
    const task = buildTaskFromSession(baseSession, noVerify, {
      baseSha: 'a',
      verifyCommand: 'bun test',
    });
    expect(task.verifyCommand).toBe('bun test');
  });

  test('normalizes the .nuncio/verify display form into a runnable command', () => {
    const events = [
      { type: 'verify_start', payload: { command: '.nuncio/verify' } },
      { type: 'verify_result', payload: { command: '.nuncio/verify', ok: true } },
    ];
    const task = buildTaskFromSession(baseSession, events, { baseSha: 'a' });
    expect(task.verifyCommand).toBe('sh .nuncio/verify');
  });
});

describe('extractOriginalPrompt', () => {
  test('returns a raw prompt untouched', () => {
    expect(extractOriginalPrompt('Fix the bug')).toEqual({ prompt: 'Fix the bug', stripped: false });
  });

  test('strips a composed preamble (brief/facts) down to the final user prompt', () => {
    const stored = ['## Handoff brief\ngoal…', '## Project facts\n- key: value', 'Fix the bug'].join(
      '\n\n---\n\n',
    );
    expect(extractOriginalPrompt(stored)).toEqual({ prompt: 'Fix the bug', stripped: true });
  });
});

describe('buildTaskFromSession preamble stripping', () => {
  test('the extracted task prompt never carries the composed brief/facts', () => {
    const stored = ['## Project facts\n- build: bun test', 'Fix the slugify bug'].join('\n\n---\n\n');
    const task = buildTaskFromSession({ ...baseSession, prompt: stored }, verifyEvents, {
      baseSha: 'abc123',
    });
    expect(task.prompt).toBe('Fix the slugify bug');
  });
});

describe('earliestRecordedHead', () => {
  test('returns the first verify head in the log', () => {
    expect(
      earliestRecordedHead([
        { type: 'verify_start', payload: { command: 'bun test' } },
        { type: 'verify_result', payload: { ok: true, head: 'aaa111' } },
        { type: 'verify_result', payload: { ok: true, head: 'bbb222' } },
      ]),
    ).toBe('aaa111');
  });

  test('ignores placeholder and missing heads', () => {
    expect(
      earliestRecordedHead([{ type: 'verify_result', payload: { ok: true, head: '(no-head)' } }]),
    ).toBeNull();
    expect(earliestRecordedHead([{ type: 'verify_result', payload: { ok: true } }])).toBeNull();
    expect(earliestRecordedHead([])).toBeNull();
  });
});

describe('promptWithSteers', () => {
  test('returns the bare prompt when there are no steers', () => {
    expect(promptWithSteers({ prompt: 'do it' })).toBe('do it');
    expect(promptWithSteers({ prompt: 'do it', followUpSteers: [] })).toBe('do it');
  });

  test('folds recorded human steers into one deterministic brief', () => {
    const combined = promptWithSteers({
      prompt: 'do it',
      followUpSteers: ['also update the README', '  and add a test '],
    });
    expect(combined).toContain('do it');
    expect(combined).toContain('- also update the README');
    expect(combined).toContain('- and add a test');
    expect(combined).toContain('Follow-up requirements');
  });
});

describe('taskSlug', () => {
  test('derives a kebab slug from the prompt head', () => {
    expect(taskSlug('Fix the failing slugify test in src/slugify.ts')).toBe(
      'fix-the-failing-slugify-test-in-src-slugify-ts',
    );
    expect(taskSlug('  Đổi   UI!!  ')).toBe('i-ui');
  });
});

describe('buildRepoWorkspace', () => {
  test('clones the repo at the pinned SHA regardless of later commits', async () => {
    const repo = tmp('eval-extract-repo-');
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'v1\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'v1');
    const pinned = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'a.txt'), 'v2\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'v2');

    const dir = tmp('eval-extract-ws-');
    await buildRepoWorkspace({ repo, baseSha: pinned }, dir);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(pinned);
    expect(Bun.file(join(dir, 'a.txt')).text()).resolves.toBe('v1\n');
  });

  test('fails loudly for a SHA the repo does not contain', async () => {
    const repo = tmp('eval-extract-repo2-');
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'v1\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'v1');

    const dir = tmp('eval-extract-ws2-');
    await expect(
      buildRepoWorkspace({ repo, baseSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }, dir),
    ).rejects.toThrow();
  });
});

describe('validateTask with repo fixtures', () => {
  test('accepts a { repo, baseSha } fixture object', () => {
    const task = {
      id: 'recorded-x',
      title: 'Recorded task',
      fixture: { repo: '/tmp/r', baseSha: 'abc' },
      prompt: 'do it',
      verifyCommand: 'bun test',
      timeoutMs: 60000,
    };
    expect(() => validateTask(task, 'recorded-x.json')).not.toThrow();
  });

  test('rejects a fixture object missing repo or baseSha', () => {
    const bad = {
      id: 'recorded-y',
      title: 'Recorded task',
      fixture: { repo: '/tmp/r' },
      prompt: 'do it',
      verifyCommand: 'bun test',
      timeoutMs: 60000,
    };
    expect(() => validateTask(bad, 'recorded-y.json')).toThrow(/baseSha/);
  });
});
