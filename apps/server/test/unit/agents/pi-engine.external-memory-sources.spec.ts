import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeProjectSlug,
  codexGroupMatchesProject,
  ExternalMemorySources,
  parseCodexMemoryIndex,
  projectPathCandidates,
} from '../../../src/agents/pi-engine/external-memory-sources';

describe('external memory source paths', () => {
  it('computes Claude project slugs including dot path segments', () => {
    expect(claudeProjectSlug('/Users/me/src/.hidden/repo.name')).toBe(
      '-Users-me-src--hidden-repo-name',
    );
  });

  it('also targets the repository root for Claude-managed worktrees', () => {
    expect(projectPathCandidates('/repo/.claude/worktrees/feature-a')).toEqual([
      '/repo/.claude/worktrees/feature-a',
      '/repo',
    ]);
  });

  it('records actual Claude filenames from the repository-root fallback and blocks symlink escapes', () => {
    const root = mkdtempSync(join(tmpdir(), 'nuncio-claude-memory-'));
    const projectPath = '/repo/.claude/worktrees/feature-a';
    const memoryDir = join(root, 'projects', claudeProjectSlug('/repo'), 'memory');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, 'MEMORY.md'), [
      '- [Safe memory](safe.md) — use this',
      '- [Escape](escape.md) — must not escape',
    ].join('\n'));
    writeFileSync(join(memoryDir, 'Safe.MD'), 'safe body');
    writeFileSync(join(memoryDir, 'unlinked.md'), 'not advertised');
    const outside = join(root, 'outside.md');
    writeFileSync(outside, 'outside body');
    symlinkSync(outside, join(memoryDir, 'escape.md'));

    try {
      const sources = new ExternalMemorySources();
      const loaded = sources.loadClaude(projectPath, root);
      expect(loaded.ids).toEqual(['safe', 'escape']);
      expect(loaded.files.get('safe')?.filename).toBe('Safe.MD');
      expect(sources.readClaude(loaded, 'safe')).toBe('safe body');
      expect(sources.readClaude(loaded, 'unlinked')).toBeNull();
      expect(sources.readClaude(loaded, 'escape')).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails soft when external stores do not exist', () => {
    const sources = new ExternalMemorySources();
    expect(sources.loadClaude('/repo', '/missing/claude')).toEqual({
      indexContent: '', ids: [], locations: [], files: new Map(),
    });
    expect(sources.loadCodex('/repo', '/missing/codex')).toEqual({
      groups: [], hasSummary: false,
    });
  });
});

describe('Codex memory index parsing', () => {
  const fixture = `# Task Group: Repo delivery
scope: release and verification
applies_to: cwd=/Users/me/repo; reuse_rule=safe

## Reusable knowledge
Use Bun.

# Task Group: Cross checkout habits
scope: shared workflow
applies_to: cwd=/Users/me/other and /Users/me/repo/.claude/worktrees/feature-a; reuse_rule=verify first

## User preferences
Keep reports concise.

# Task Group: Temp-only work
scope: unrelated
applies_to: cwd=/tmp/unrelated; reuse_rule=never elsewhere
`;

  it('parses path-less titles, scopes, and multi-path applies_to lines', () => {
    const groups = parseCodexMemoryIndex(fixture);

    expect(groups).toHaveLength(3);
    expect(groups[1]).toMatchObject({
      title: 'Cross checkout habits',
      scope: 'shared workflow',
      appliesTo: [
        '/Users/me/other',
        '/Users/me/repo/.claude/worktrees/feature-a',
      ],
    });
    expect(groups[1]?.content).toContain('## User preferences');
  });

  it('keeps a single path containing " and " whole instead of granting its split prefix', () => {
    const [group] = parseCodexMemoryIndex(
      '# Task Group: Mixed dir\nscope: naming\napplies_to: cwd=/Users/me/research and development/repo; reuse_rule=safe\n',
    );

    expect(group?.appliesTo).toEqual(['/Users/me/research and development/repo']);
    expect(codexGroupMatchesProject(group!, '/Users/me/research and development/repo')).toBe(true);
    expect(codexGroupMatchesProject(group!, '/Users/me/research')).toBe(false);
  });

  it('matches equal and descendant applies_to paths without inheriting ancestor scopes', () => {
    const [repo, cross, temp] = parseCodexMemoryIndex(fixture);

    expect(codexGroupMatchesProject(repo!, '/Users/me/repo')).toBe(true);
    expect(codexGroupMatchesProject(repo!, '/Users/me/repo/packages/web')).toBe(false);
    expect(codexGroupMatchesProject(cross!, '/Users/me/repo')).toBe(true);
    expect(codexGroupMatchesProject(temp!, '/Users/me/repo')).toBe(false);
  });

  it('keeps an unsplit absolute applies_to path containing the word and', () => {
    const [group] = parseCodexMemoryIndex(`# Task Group: Ampersand path
scope: repository-specific
applies_to: cwd=/Users/me/research and development/repo; reuse_rule=safe
`);

    expect(group?.appliesTo).toContain('/Users/me/research and development/repo');
    expect(codexGroupMatchesProject(group!, '/Users/me/research and development/repo')).toBe(true);
  });
});
