import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { materializeContextFile, CONTEXT_FILE_POINTER } from '../../../src/context/context-file.materializer';

describe('materializeContextFile', () => {
  let worktree: string;

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), 'nuncio-ctxfile-'));
    mkdirSync(join(worktree, '.git', 'info'), { recursive: true });
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  it('writes the file + exclude entry under worktree-local', () => {
    const result = materializeContextFile(worktree, {
      policy: 'worktree-local',
      contextFileName: 'CLAUDE.local.md',
      factsBlock: '## Project facts\n- **k**: v',
    });
    expect(result.written).toBe(true);
    expect(result.skipped).toBe(false);

    const content = readFileSync(join(worktree, 'CLAUDE.local.md'), 'utf8');
    expect(content).toContain('## Project facts');
    expect(content).toContain(CONTEXT_FILE_POINTER);

    const exclude = readFileSync(join(worktree, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('CLAUDE.local.md');
  });

  it('writes nothing under the none policy', () => {
    const result = materializeContextFile(worktree, {
      policy: 'none',
      contextFileName: 'CLAUDE.local.md',
      factsBlock: 'x',
    });
    expect(result.written).toBe(false);
    expect(existsSync(join(worktree, 'CLAUDE.local.md'))).toBe(false);
  });

  it('writes nothing when the profile has no contextFileName', () => {
    const result = materializeContextFile(worktree, {
      policy: 'worktree-local',
      contextFileName: undefined,
      factsBlock: 'x',
    });
    expect(result.written).toBe(false);
  });

  it('skips (writes nothing) when the target file already exists', () => {
    writeFileSync(join(worktree, 'CLAUDE.local.md'), 'existing override');
    const result = materializeContextFile(worktree, {
      policy: 'worktree-local',
      contextFileName: 'CLAUDE.local.md',
      factsBlock: '## Project facts\n- **k**: v',
    });
    expect(result.written).toBe(false);
    expect(result.skipped).toBe(true);
    // The existing file is untouched.
    expect(readFileSync(join(worktree, 'CLAUDE.local.md'), 'utf8')).toBe('existing override');
  });

  it('does not double-add the exclude entry on a rerun (dedupe)', () => {
    const opts = { policy: 'worktree-local' as const, contextFileName: 'CLAUDE.local.md', factsBlock: 'x' };
    materializeContextFile(worktree, opts);
    // Remove the written file so the second call writes again, but the exclude
    // entry must not be duplicated.
    rmSync(join(worktree, 'CLAUDE.local.md'));
    materializeContextFile(worktree, opts);
    const exclude = readFileSync(join(worktree, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').filter((l) => l.trim() === 'CLAUDE.local.md')).toHaveLength(1);
  });

  describe('non-bare contextFileName rejection', () => {
    let parent: string;
    let nestedWorktree: string;

    beforeEach(() => {
      parent = mkdtempSync(join(tmpdir(), 'nuncio-ctxfile-parent-'));
      nestedWorktree = join(parent, 'worktree');
      mkdirSync(join(nestedWorktree, '.git', 'info'), { recursive: true });
    });

    afterEach(() => {
      rmSync(parent, { recursive: true, force: true });
    });

    it('rejects a traversal name and writes nothing outside the worktree', () => {
      const warnings: string[] = [];
      const result = materializeContextFile(nestedWorktree, {
        policy: 'worktree-local',
        contextFileName: '../escaped-context.md',
        factsBlock: 'x',
        warn: (m) => warnings.push(m),
      });
      expect(result).toEqual({ written: false, skipped: false });
      expect(warnings).toHaveLength(1);
      expect(existsSync(join(parent, 'escaped-context.md'))).toBe(false);
      expect(existsSync(join(nestedWorktree, 'escaped-context.md'))).toBe(false);
    });

    it('rejects a nested relative path and writes nothing', () => {
      const warnings: string[] = [];
      const result = materializeContextFile(nestedWorktree, {
        policy: 'worktree-local',
        contextFileName: 'a/b.md',
        factsBlock: 'x',
        warn: (m) => warnings.push(m),
      });
      expect(result).toEqual({ written: false, skipped: false });
      expect(warnings).toHaveLength(1);
      expect(existsSync(join(nestedWorktree, 'a', 'b.md'))).toBe(false);
      expect(existsSync(join(nestedWorktree, 'a'))).toBe(false);
    });

    it('rejects an absolute path and writes nothing', () => {
      const escape = join(parent, 'abs-escape.md');
      const warnings: string[] = [];
      const result = materializeContextFile(nestedWorktree, {
        policy: 'worktree-local',
        contextFileName: escape,
        factsBlock: 'x',
        warn: (m) => warnings.push(m),
      });
      expect(result).toEqual({ written: false, skipped: false });
      expect(warnings).toHaveLength(1);
      expect(existsSync(escape)).toBe(false);
    });
  });

  it('creates .git/info/exclude when it is missing', () => {
    rmSync(join(worktree, '.git', 'info'), { recursive: true, force: true });
    mkdirSync(join(worktree, '.git'), { recursive: true }); // .git exists, info does not
    materializeContextFile(worktree, { policy: 'worktree-local', contextFileName: 'AGENTS.local.md', factsBlock: 'x' });
    expect(readFileSync(join(worktree, '.git', 'info', 'exclude'), 'utf8')).toContain('AGENTS.local.md');
  });
});
