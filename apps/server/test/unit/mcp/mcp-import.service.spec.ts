import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { GitService } from '../../../src/git/git.service';
import {
  MCP_SETTINGS_KEY,
  McpServersRepository,
} from '../../../src/mcp/persistence/mcp-servers.repository';
import { MCP_IMPORT_HOME, McpImportService } from '../../../src/mcp/import/mcp-import.service';

describe('McpImportService', () => {
  let module: TestingModule;
  let service: McpImportService;
  let repo: McpServersRepository;
  let dataDir: string;
  let home: string;
  let projectDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-mcp-import-'));
    home = mkdtempSync(join(tmpdir(), 'nuncio-mcp-home-'));
    projectDir = mkdtempSync(join(tmpdir(), 'nuncio-mcp-proj-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(
      join(home, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          bridgememory: { command: 'node', args: ['/x/server.cjs'] },
          'ios-simulator': { command: 'npx', args: ['-y', 'ios-simulator-mcp'] },
        },
      }),
    );
    mkdirSync(join(projectDir, '.cursor'), { recursive: true });
    writeFileSync(
      join(projectDir, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { projtool: { command: 'bunx', args: ['proj-mcp'] } } }),
    );

    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { bridgememory: { command: 'node', args: ['/x/server.cjs'] } },
        projects: {},
      }),
    );

    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      join(home, '.codex', 'config.toml'),
      [
        '[mcp_servers.figma]',
        'url = "https://mcp.figma.com/mcp"',
        '',
        '[mcp_servers.off_server]',
        'command = "npx"',
        'args = ["off-mcp"]',
        'enabled = false',
      ].join('\n'),
    );

    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [
        McpServersRepository,
        McpImportService,
        { provide: MCP_SETTINGS_KEY, useValue: randomBytes(32) },
        { provide: MCP_IMPORT_HOME, useValue: home },
        {
          provide: GitService,
          useValue: {
            listProjects: async () => [
              { id: 'proj', name: 'proj', path: projectDir, isGit: true },
            ],
          },
        },
      ],
    }).compile();

    service = module.get(McpImportService);
    repo = module.get(McpServersRepository);
  });

  afterAll(async () => {
    await module.close();
    for (const dir of [dataDir, home, projectDir]) rmSync(dir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('previews cursor servers from global and project files as new', async () => {
    const preview = await service.preview('cursor');
    const names = preview.entries.map((entry) => entry.candidate.name).sort();
    expect(names).toEqual(['bridgememory', 'ios-simulator', 'projtool']);
    expect(preview.entries.every((entry) => entry.status === 'new')).toBe(true);
    const proj = preview.entries.find((entry) => entry.candidate.name === 'projtool');
    expect(proj?.candidate.projectPath).toBe(projectDir);
    expect(repo.list()).toHaveLength(0);
  });

  it('applies the cursor import and is idempotent', async () => {
    const first = await service.apply('cursor');
    expect(first.createdIds.sort()).toEqual(['bridgememory', 'ios-simulator', 'projtool']);
    expect(first.mergedIds).toEqual([]);

    const second = await service.apply('cursor');
    expect(second.createdIds).toEqual([]);
    expect(repo.list()).toHaveLength(3);
  });

  it('merges cross-source duplicates by transport identity instead of duplicating', async () => {
    const result = await service.apply('claude');
    expect(result.createdIds).toEqual([]);
    expect(result.mergedIds).toEqual(['bridgememory']);
    const bridge = repo.get('bridgememory');
    expect(bridge?.sources).toEqual(['import:cursor', 'import:claude']);
    expect(repo.list()).toHaveLength(3);
  });

  it('imports codex servers preserving enabled=false and oauth-less remotes', async () => {
    const preview = await service.preview('codex');
    expect(preview.entries.map((entry) => entry.candidate.name).sort()).toEqual([
      'figma',
      'off_server',
    ]);
    const result = await service.apply('codex');
    expect(result.createdIds.sort()).toEqual(['figma', 'off-server']);
    expect(repo.get('off-server')?.enabled).toBe(false);
    expect(repo.get('figma')?.transport).toEqual({ type: 'http', url: 'https://mcp.figma.com/mcp' });
  });

  it('marks project-scoped duplicates of a global row as existing', async () => {
    writeFileSync(
      join(projectDir, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: { bridgedupe: { command: 'node', args: ['/x/server.cjs'] } },
      }),
    );
    const preview = await service.preview('cursor');
    const dupe = preview.entries.find((entry) => entry.candidate.name === 'bridgedupe');
    expect(dupe?.status).toBe('existing');
    expect(dupe?.existingId).toBe('bridgememory');
  });

  it('returns an empty preview when the source files are missing', async () => {
    rmSync(join(home, '.codex', 'config.toml'));
    const preview = await service.preview('codex');
    expect(preview.entries).toEqual([]);
  });
});
