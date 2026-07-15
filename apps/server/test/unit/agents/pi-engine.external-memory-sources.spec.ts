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

  it('honors Claude autoMemoryDirectory from user settings over the slug layout', () => {
    const root = mkdtempSync(join(tmpdir(), 'nuncio-claude-auto-'));
    const projectPath = join(root, 'repo');
    const customDir = join(root, 'custom-memory');
    mkdirSync(customDir, { recursive: true });
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(root, 'settings.json'), JSON.stringify({ autoMemoryDirectory: customDir }));
    writeFileSync(join(customDir, 'MEMORY.md'), '- [Custom note](custom-note.md) — relocated store');
    writeFileSync(join(customDir, 'custom-note.md'), 'relocated body');
    const slugDir = join(root, 'projects', claudeProjectSlug(projectPath), 'memory');
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(join(slugDir, 'MEMORY.md'), '- [Slug note](slug-note.md) — default store');
    writeFileSync(join(slugDir, 'slug-note.md'), 'slug body');

    try {
      const sources = new ExternalMemorySources();
      const loaded = sources.loadClaude(projectPath, root);
      expect(loaded.ids).toEqual(['custom-note']);
      expect(sources.readClaude(loaded, 'custom-note')).toBe('relocated body');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers project-local autoMemoryDirectory and ignores non-absolute values', () => {
    const root = mkdtempSync(join(tmpdir(), 'nuncio-claude-auto-scope-'));
    const projectPath = join(root, 'repo');
    const projectDir = join(root, 'project-memory');
    mkdirSync(join(projectPath, '.claude'), { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    // User scope sets a relative (invalid) value; project scope wins with a valid one.
    writeFileSync(join(root, 'settings.json'), JSON.stringify({ autoMemoryDirectory: 'relative/dir' }));
    writeFileSync(
      join(projectPath, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryDirectory: projectDir }),
    );
    writeFileSync(join(projectDir, 'MEMORY.md'), '- [Project note](project-note.md) — project scope');
    writeFileSync(join(projectDir, 'project-note.md'), 'project body');

    try {
      const loaded = new ExternalMemorySources().loadClaude(projectPath, root);
      expect(loaded.ids).toEqual(['project-note']);
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
