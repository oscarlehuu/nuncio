import { Inject, Injectable, Optional } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GitService } from '../../git/git.service';
import { transportIdentity } from '../domain/mcp-transport';
import { McpServersRepository } from '../persistence/mcp-servers.repository';
import { parseClaudeGlobalConfig, parseClaudeProjectConfig } from './claude-mcp-scanner';
import { parseCursorMcpConfig } from './cursor-mcp-scanner';
import { parseCodexConfig } from './codex-mcp-scanner';
import type {
  McpImportCandidate,
  McpImportPreview,
  McpImportPreviewEntry,
  McpImportResult,
  McpImportSourceId,
} from './mcp-import.types';

/** Overridable home directory (tests point it at a fixture tree). */
export const MCP_IMPORT_HOME = Symbol('MCP_IMPORT_HOME');

/**
 * Read-only import from the external stores (Cursor / Claude Code / Codex)
 * into the Nuncio MCP registry. Copy-into-DB, never write back: the source
 * files stay owned by their CLIs. Dedupe is by transport identity, so the same
 * server registered in several stores collapses into one row with merged
 * provenance.
 */
@Injectable()
export class McpImportService {
  constructor(
    private readonly repo: McpServersRepository,
    private readonly git: GitService,
    @Optional() @Inject(MCP_IMPORT_HOME) private readonly homeOverride?: string,
  ) {}

  async preview(source: McpImportSourceId): Promise<McpImportPreview> {
    const candidates = await this.scan(source);
    const entries: McpImportPreviewEntry[] = [];
    const seenInScan = new Set<string>();
    for (const candidate of candidates) {
      const identity = transportIdentity(candidate.transport);
      const existing =
        this.repo.findByIdentity(identity, candidate.projectPath) ??
        this.repo.findByIdentity(identity, null);
      if (existing) {
        entries.push({ candidate, status: 'existing', existingId: existing.id });
        continue;
      }
      // Same transport twice within one scan with no stored row yet (e.g. a
      // global and a project file): the first occurrence creates the row.
      if (seenInScan.has(identity)) continue;
      seenInScan.add(identity);
      entries.push({ candidate, status: 'new' });
    }
    return { source, entries };
  }

  async apply(source: McpImportSourceId): Promise<McpImportResult> {
    const preview = await this.preview(source);
    const createdIds: string[] = [];
    const mergedIds: string[] = [];
    for (const entry of preview.entries) {
      if (entry.status === 'existing' && entry.existingId) {
        const existing = this.repo.get(entry.existingId);
        if (existing && !existing.sources.includes(entry.candidate.source)) {
          this.repo.addSource(entry.existingId, entry.candidate.source);
          mergedIds.push(entry.existingId);
        }
        continue;
      }
      const created = this.repo.create({
        name: entry.candidate.name,
        transport: entry.candidate.transport,
        enabled: entry.candidate.enabled,
        projectPath: entry.candidate.projectPath,
        auth: entry.candidate.auth,
        sources: [entry.candidate.source],
        secretKeys: entry.candidate.secretKeys,
      });
      createdIds.push(created.id);
    }
    return { source, createdIds, mergedIds };
  }

  private async scan(source: McpImportSourceId): Promise<McpImportCandidate[]> {
    const home = this.homeOverride ?? homedir();
    const projects = await this.projectPaths();
    switch (source) {
      case 'cursor':
        return [
          ...parseCursorMcpConfig(readOrEmpty(join(home, '.cursor', 'mcp.json')), null),
          ...projects.flatMap((projectPath) =>
            parseCursorMcpConfig(
              readOrEmpty(join(projectPath, '.cursor', 'mcp.json')),
              projectPath,
            ),
          ),
        ];
      case 'claude':
        return [
          ...parseClaudeGlobalConfig(readOrEmpty(join(home, '.claude.json'))),
          ...projects.flatMap((projectPath) =>
            parseClaudeProjectConfig(readOrEmpty(join(projectPath, '.mcp.json')), projectPath),
          ),
        ];
      case 'codex':
        return [
          ...parseCodexConfig(readOrEmpty(join(home, '.codex', 'config.toml')), null),
          ...projects.flatMap((projectPath) =>
            parseCodexConfig(readOrEmpty(join(projectPath, '.codex', 'config.toml')), projectPath),
          ),
        ];
      default: {
        const exhaustive: never = source;
        throw new Error(`unknown import source: ${exhaustive as string}`);
      }
    }
  }

  private async projectPaths(): Promise<string[]> {
    try {
      const projects = await this.git.listProjects();
      return projects.map((project) => project.path);
    } catch {
      return [];
    }
  }
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
