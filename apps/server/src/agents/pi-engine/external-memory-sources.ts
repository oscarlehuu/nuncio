import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';

export interface ClaudeMemoryFile {
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

function normalizedAppliesTo(value: string): string {
  return value.replace(/^cwd=/, '').trim().replace(/^[`'"]|[`'"]$/g, '');
}

function parseAppliesTo(line: string): string[] {
  const value = line.slice('applies_to:'.length).split(';', 1)[0]?.trim() ?? '';
  const split = value.split(/\s+and\s+/).map(normalizedAppliesTo);
  const unsplit = normalizedAppliesTo(value);
  return [...new Set([...split, ...(isAbsolute(unsplit) ? [unsplit] : [])])]
    .filter((entry) => isAbsolute(entry));
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

export function codexGroupMatchesProject(group: CodexTaskGroup, projectPath: string): boolean {
  return projectPathCandidates(projectPath).some((candidate) =>
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
  loadClaude(projectPath: string, claudeDir: string): ClaudeMemorySource {
    try {
      const locations = projectPathCandidates(projectPath)
        .map((candidate) => join(claudeDir, 'projects', claudeProjectSlug(candidate), 'memory'));
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
      return {
        groups: index ? parseCodexMemoryIndex(index)
          .filter((group) => codexGroupMatchesProject(group, projectPath)) : [],
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
