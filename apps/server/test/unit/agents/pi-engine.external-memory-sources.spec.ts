import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

  it('reuses a successful Git-root probe across stores while rereading memory files', () => {
    const root = mkdtempSync(join(tmpdir(), 'nuncio-memory-root-cache-'));
    const projectPath = join(root, 'worktree');
    const repositoryRoot = join(root, 'repo');
    const otherProject = join(root, 'other-worktree');
    const otherRepositoryRoot = join(root, 'other-repo');
    const claudeRoot = join(root, 'claude');
    const claudeMemoryDir = join(
      claudeRoot,
      'projects',
      claudeProjectSlug(repositoryRoot),
      'memory',
    );
    const codexRoot = join(root, 'codex');
    const codexMemoryDir = join(codexRoot, 'memories');
    mkdirSync(claudeMemoryDir, { recursive: true });
    mkdirSync(codexMemoryDir, { recursive: true });
    writeFileSync(join(claudeMemoryDir, 'MEMORY.md'), '- [First](first.md) — initial');
    writeFileSync(join(claudeMemoryDir, 'first.md'), 'first body');
    writeFileSync(join(codexMemoryDir, 'MEMORY.md'), [
      '# Task Group: Shared root',
      'scope: cached repository identity',
      `applies_to: cwd=${repositoryRoot}; reuse_rule=safe`,
    ].join('\n'));

    let probes = 0;
    const sources = new ExternalMemorySources() as ExternalMemorySources & {
      repositoryRootResolver: (path: string) => string | null;
    };
    sources.repositoryRootResolver = (path) => {
      probes += 1;
      if (path === projectPath) return repositoryRoot;
      if (path === otherProject) return otherRepositoryRoot;
      return null;
    };

    try {
      expect(sources.loadClaude(projectPath, claudeRoot).ids).toEqual(['first']);
      expect(sources.loadCodex(projectPath, codexRoot).groups).toHaveLength(1);
      expect(probes).toBe(1);

      writeFileSync(join(claudeMemoryDir, 'MEMORY.md'), '- [Second](second.md) — refreshed');
      writeFileSync(join(claudeMemoryDir, 'second.md'), 'second body');
      expect(sources.loadClaude(projectPath, claudeRoot).ids).toEqual(['second']);
      expect(probes).toBe(1);

      sources.loadCodex(otherProject, codexRoot);
      expect(probes).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retries a failed Git-root probe and caches only after it succeeds', () => {
    const sources = new ExternalMemorySources() as ExternalMemorySources & {
      repositoryRootResolver: (path: string) => string | null;
    };
    let probes = 0;
    sources.repositoryRootResolver = () => {
      probes += 1;
      return probes === 1 ? null : '/repo';
    };

    sources.loadCodex('/project', '/missing-codex-home');
    sources.loadCodex('/project', '/missing-codex-home');
    sources.loadCodex('/project', '/missing-codex-home');

    expect(probes).toBe(2);
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

  it('resolves plain git worktrees and subdirectories to the repository-root store', () => {
    // realpath so git's absolute output matches the slug we compute (/var vs /private/var).
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'nuncio-claude-git-')));
    const repo = join(root, 'repo');
    const worktree = join(root, 'linked-worktree');
    mkdirSync(repo, { recursive: true });
    const git = (args: string[], cwd: string) =>
      execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init', '-q'], repo);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init'], repo);
    git(['worktree', 'add', '-q', worktree], repo);
    mkdirSync(join(repo, 'packages', 'web'), { recursive: true });
    const memoryDir = join(root, 'projects', claudeProjectSlug(repo), 'memory');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, 'MEMORY.md'), '- [Repo note](repo-note.md) — root store');
    writeFileSync(join(memoryDir, 'repo-note.md'), 'root body');

    try {
      const sources = new ExternalMemorySources();
      expect(sources.loadClaude(worktree, root).ids).toEqual(['repo-note']);
      expect(sources.loadClaude(join(repo, 'packages', 'web'), root).ids).toEqual(['repo-note']);
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
