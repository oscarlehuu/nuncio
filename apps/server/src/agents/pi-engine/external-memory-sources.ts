import { Injectable } from '@nestjs/common';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { expandHome } from '../providers/cli-path.helpers';

interface ClaudeMemoryFile {
  directory: string;
  filename: string;
}

export interface ClaudeMemorySource {
  indexContent: string;
  ids: string[];
  locations: string[];
  files: Map<string, ClaudeMemoryFile>;
}

export interface CodexTaskGroup {
  id: string;
  title: string;
  scope: string;
  appliesTo: string[];
  content: string;
}

export interface CodexMemorySource {
  groups: CodexTaskGroup[];
  hasSummary: boolean;
}

export interface ExternalMemoryRoots {
  claudeDir: string;
  codexHome: string;
}

export function claudeProjectSlug(projectPath: string): string {
  return resolve(projectPath).replace(/[/.]/g, '-');
}

export function projectPathCandidates(projectPath: string): string[] {
  const normalized = resolve(projectPath);
  const marker = '/.claude/worktrees/';
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex < 0) return [normalized];
  return [normalized, normalized.slice(0, markerIndex)];
}

/**
 * Claude Code derives the memory slug from the git repository — worktrees and
 * subdirectories share the main checkout's store. `--git-common-dir` points at
 * the main checkout's .git from any of them; fail soft outside a repo.
 */
function gitRepositoryRoot(projectPath: string): string | null {
  try {
    const commonDir = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: projectPath, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 },
    ).toString().trim();
    if (!commonDir) return null;
    return basename(commonDir) === '.git' ? dirname(commonDir) : null;
  } catch {
    return null;
  }
}

/**
 * Claude Code's documented `autoMemoryDirectory` setting relocates the auto
 * memory store: the configured directory then holds MEMORY.md and topic files
 * directly. Mirror the settings precedence (project local > project > user)
 * and require an absolute or ~-prefixed value, like Claude Code does.
 */
function claudeAutoMemoryDirectory(candidates: string[], claudeDir: string): string | null {
  const settingsFiles = [
    ...candidates.flatMap((candidate) => [
      join(candidate, '.claude', 'settings.local.json'),
      join(candidate, '.claude', 'settings.json'),
    ]),
    join(claudeDir, 'settings.json'),
  ];
  for (const file of settingsFiles) {
    const raw = safeRead(file);
    if (raw === null) continue;
    try {
      const value = (JSON.parse(raw) as { autoMemoryDirectory?: unknown }).autoMemoryDirectory;
      if (typeof value !== 'string' || !value.trim()) continue;
      const expanded = expandHome(value.trim());
      if (isAbsolute(expanded)) return expanded;
    } catch {
      // Malformed settings file: skip it and keep walking the precedence chain.
    }
  }
  return null;
}

function normalizedAppliesTo(value: string): string {
  return value.replace(/^cwd=/, '').trim().replace(/^[`'"]|[`'"]$/g, '');
}

function parseAppliesTo(line: string): string[] {
  const value = line.slice('applies_to:'.length).split(';', 1)[0]?.trim() ?? '';
  const split = value.split(/\s+and\s+/).map(normalizedAppliesTo).filter(Boolean);
  // " and " is ambiguous: separator between paths, or part of one path name.
  // Trust the split only when every piece is absolute; otherwise a split
  // prefix of a single path would grant an unrelated sibling scope.
  if (split.length > 1 && split.every((entry) => isAbsolute(entry))) {
    return [...new Set(split)];
  }
  const whole = normalizedAppliesTo(value);
  return isAbsolute(whole) ? [whole] : split.filter((entry) => isAbsolute(entry));
}

export function parseCodexMemoryIndex(content: string): CodexTaskGroup[] {
  const starts = [...content.matchAll(/^# Task Group:\s*(.+?)\s*$/gm)];
  return starts.map((match, index) => {
    const start = match.index ?? 0;
    const end = starts[index + 1]?.index ?? content.length;
    const section = content.slice(start, end).trimEnd();
    const scope = section.match(/^scope:\s*(.*?)\s*$/m)?.[1]?.trim() ?? '';
    const appliesLine = section.match(/^applies_to:\s*.*$/m)?.[0] ?? '';
    const digest = createHash('sha256').update(section).digest('hex').slice(0, 12);
    return {
      id: `group-${digest}`,
      title: match[1]?.trim() ?? `Task group ${index + 1}`,
      scope,
      appliesTo: appliesLine ? parseAppliesTo(appliesLine) : [],
      content: section,
    };
  });
}

function containsPath(parent: string, child: string): boolean {
  const pathFromParent = relative(resolve(parent), resolve(child));
  return pathFromParent === '' || (!pathFromParent.startsWith('..') && !isAbsolute(pathFromParent));
}

export function codexGroupMatchesProject(
  group: CodexTaskGroup,
  projectPath: string,
  candidates = projectPathCandidates(projectPath),
): boolean {
  return candidates.some((candidate) =>
    group.appliesTo.some((appliesTo) => containsPath(candidate, appliesTo)));
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function indexedClaudeFiles(index: string, memoryDir: string): Map<string, ClaudeMemoryFile> {
  try {
    const actualByLowercase = new Map(readdirSync(memoryDir)
      .filter((name) => extname(name).toLowerCase() === '.md' && name !== 'MEMORY.md')
      .map((name) => [name.toLowerCase(), name]));
    const files = new Map<string, ClaudeMemoryFile>();
    for (const match of index.matchAll(/\]\(([^)#]+\.md)(?:#[^)]+)?\)/gi)) {
      const linkedName = match[1] ?? '';
      const filename = actualByLowercase.get(linkedName.toLowerCase());
      if (basename(linkedName) !== linkedName || !filename) continue;
      files.set(linkedName.slice(0, -3), { directory: memoryDir, filename });
    }
    return files;
  } catch {
    return new Map();
  }
}

function safeContainedRead(directory: string, filename: string): string | null {
  try {
    const root = realpathSync(directory);
    const target = realpathSync(join(root, filename));
    if (!containsPath(root, target) || target === root) return null;
    return safeRead(target);
  } catch {
    return null;
  }
}

@Injectable()
export class ExternalMemorySources {
  /** Process boundary is overrideable so the positive-cache invariant is deterministic in tests. */
  repositoryRootResolver: (projectPath: string) => string | null = gitRepositoryRoot;
  private readonly projectCandidatesCache = new Map<string, string[]>();

  /**
   * Git identity does not change for a live worktree, while memory files do.
   * Cache only successful probes: this removes duplicate synchronous `git`
   * processes without preventing a non-repository folder from becoming one.
   */
  private resolveProjectCandidates(projectPath: string): string[] {
    const key = resolve(projectPath);
    const cached = this.projectCandidatesCache.get(key);
    if (cached) return cached;

    const candidates = projectPathCandidates(key);
    const gitRoot = this.repositoryRootResolver(candidates[0]!);
    if (!gitRoot) return candidates;

    const resolved = candidates.includes(gitRoot) ? candidates : [...candidates, gitRoot];
    this.projectCandidatesCache.set(key, resolved);
    return resolved;
  }

  loadClaude(projectPath: string, claudeDir: string): ClaudeMemorySource {
    try {
      const candidates = this.resolveProjectCandidates(projectPath);
      const override = claudeAutoMemoryDirectory(candidates, claudeDir);
      const locations = override
        ? [override]
        : candidates.map((candidate) => join(claudeDir, 'projects', claudeProjectSlug(candidate), 'memory'));
      const loaded = locations.flatMap((location) => {
        const index = safeRead(join(location, 'MEMORY.md'));
        return index === null ? [] : [{ location, index, files: indexedClaudeFiles(index, location) }];
      });
      const files = new Map<string, ClaudeMemoryFile>();
      for (const entry of loaded) {
        for (const [id, file] of entry.files) if (!files.has(id)) files.set(id, file);
      }
      return {
        indexContent: loaded.map((entry) => entry.index).join('\n'),
        ids: [...files.keys()],
        locations: loaded.map((entry) => entry.location),
        files,
      };
    } catch {
      return { indexContent: '', ids: [], locations: [], files: new Map() };
    }
  }

  loadCodex(projectPath: string, codexHome: string): CodexMemorySource {
    try {
      const memoryDir = join(codexHome, 'memories');
      const index = safeRead(join(memoryDir, 'MEMORY.md'));
      const candidates = this.resolveProjectCandidates(projectPath);
      return {
        groups: index ? parseCodexMemoryIndex(index)
          .filter((group) => codexGroupMatchesProject(group, projectPath, candidates)) : [],
        hasSummary: existsSync(join(memoryDir, 'memory_summary.md')),
      };
    } catch {
      return { groups: [], hasSummary: false };
    }
  }

  readClaude(source: ClaudeMemorySource, id: string): string | null {
    const file = source.files.get(id);
    return file ? safeContainedRead(file.directory, file.filename) : null;
  }

  readCodexSummary(codexHome: string): string | null {
    return safeContainedRead(join(codexHome, 'memories'), 'memory_summary.md');
  }
}
