import { BadRequestException, NotFoundException } from '@nestjs/common';
import { McpServersController } from '../../../src/mcp/api/mcp-servers.controller';
import type { McpServerDto } from '../../../src/mcp/domain/mcp.types';

function makeDto(over: Partial<McpServerDto> = {}): McpServerDto {
  return {
    id: 'bridgememory',
    name: 'bridgememory',
    description: null,
    transport: { type: 'stdio', command: 'node', args: ['/x/server.cjs'] },
    enabled: true,
    advertise: 'lazy',
    projectPath: null,
    engines: null,
    auth: 'none',
    oauthStatus: 'none',
    sources: ['import:cursor'],
    secretKeys: [],
    scope: 'global',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe('McpServersController', () => {
  it('list delegates to service.list()', () => {
    const controller = new McpServersController(
      { list: () => [makeDto()] } as never,
      {} as never,
      {} as never,
    );
    expect(controller.list()).toHaveLength(1);
  });

  it('get returns the DTO and 404s on unknown id', () => {
    const dto = makeDto();
    const controller = new McpServersController(
      { get: (id: string) => (id === dto.id ? dto : null) } as never,
      {} as never,
      {} as never,
    );
    expect(controller.get('bridgememory')).toBe(dto);
    expect(() => controller.get('ghost')).toThrow(NotFoundException);
  });

  it('create validates required fields', () => {
    const create = jest.fn(() => makeDto());
    const controller = new McpServersController({ create } as never, {} as never, {} as never);
    expect(() => controller.create({} as never)).toThrow(BadRequestException);
    expect(() => controller.create({ name: 'x' } as never)).toThrow(BadRequestException);
    controller.create({ name: 'x', transport: { type: 'stdio', command: 'x', args: [] } });
    expect(create).toHaveBeenCalled();
  });

  it('update 404s on unknown id and returns the patched DTO otherwise', () => {
    const dto = makeDto({ enabled: false });
    const controller = new McpServersController(
      { update: (id: string) => (id === dto.id ? dto : null) } as never,
      {} as never,
      {} as never,
    );
    expect(controller.update('bridgememory', { enabled: false })).toBe(dto);
    expect(() => controller.update('ghost', { enabled: false })).toThrow(NotFoundException);
  });

  it('remove 404s on unknown id', () => {
    const controller = new McpServersController(
      { delete: (id: string) => id === 'bridgememory' } as never,
      {} as never,
      {} as never,
    );
    expect(controller.remove('bridgememory')).toEqual({ deleted: true });
    expect(() => controller.remove('ghost')).toThrow(NotFoundException);
  });

  it('import validates the source and routes dryRun to preview', async () => {
    const preview = jest.fn(async () => ({ source: 'cursor', entries: [] }));
    const apply = jest.fn(async () => ({ source: 'cursor', createdIds: [], mergedIds: [] }));
    const controller = new McpServersController({} as never, { preview, apply } as never, {} as never);

    await expect(controller.import({ source: 'notastore' as never })).rejects.toThrow(
      BadRequestException,
    );
    await controller.import({ source: 'cursor', dryRun: true });
    expect(preview).toHaveBeenCalledWith('cursor');
    expect(apply).not.toHaveBeenCalled();
    await controller.import({ source: 'cursor' });
    expect(apply).toHaveBeenCalledWith('cursor');
  });

  it('import preview masks secret env, CLI arg, URL query, and header values', async () => {
    const preview = jest.fn(async () => ({
      source: 'cursor' as const,
      entries: [
        {
          status: 'new' as const,
          candidate: {
            name: 'bridge',
            transport: {
              type: 'stdio' as const,
              command: 'node',
              args: ['bridge-mcp', '--token', 'cli-secret', '--api-key=inline-secret'],
              env: { GITHUB_PAT: 'github-pat-secret', PLAIN: 'ok' },
            },
            source: 'import:cursor' as const,
            projectPath: null,
            enabled: true,
            auth: 'none' as const,
            secretKeys: ['GITHUB_PAT'],
            secretArgIndexes: [2, 3],
            secretUrlQueryKeys: [],
          },
        },
        {
          status: 'new' as const,
          candidate: {
            name: 'remote',
            transport: {
              type: 'http' as const,
              url: 'https://remote.example/mcp?tenant=query-secret',
              headers: { 'X-Account': 'header-secret' },
            },
            source: 'import:cursor' as const,
            projectPath: null,
            enabled: true,
            auth: 'none' as const,
            secretKeys: ['X-Account'],
            secretArgIndexes: [],
            secretUrlQueryKeys: ['tenant'],
          },
        },
      ],
    }));
    const controller = new McpServersController({} as never, { preview } as never, {} as never);
    const result = (await controller.import({ source: 'cursor', dryRun: true })) as {
      entries: Array<{
        candidate: {
          transport:
            | { type: 'stdio'; args: string[]; env?: Record<string, string> }
            | { type: 'http'; url: string; headers?: Record<string, string> };
        };
      }>;
    };
    const stdio = result.entries[0].candidate.transport;
    expect(stdio.type).toBe('stdio');
    if (stdio.type !== 'stdio') throw new Error('expected stdio preview');
    expect(JSON.stringify(stdio)).not.toContain('cli-secret');
    expect(JSON.stringify(stdio)).not.toContain('inline-secret');
    expect(JSON.stringify(stdio)).not.toContain('github-pat-secret');
    expect(stdio.args[3]).toContain('--api-key=');
    expect(stdio.env?.PLAIN).toBe('ok');

    const remote = result.entries[1].candidate.transport;
    expect(remote.type).toBe('http');
    if (remote.type !== 'http') throw new Error('expected remote preview');
    expect(remote.url).toContain('tenant=');
    expect(remote.url).not.toContain('query-secret');
    expect(remote.headers?.['X-Account']).not.toContain('header-secret');
  });
});
