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
    );
    expect(controller.list()).toHaveLength(1);
  });

  it('get returns the DTO and 404s on unknown id', () => {
    const dto = makeDto();
    const controller = new McpServersController(
      { get: (id: string) => (id === dto.id ? dto : null) } as never,
      {} as never,
    );
    expect(controller.get('bridgememory')).toBe(dto);
    expect(() => controller.get('ghost')).toThrow(NotFoundException);
  });

  it('create validates required fields', () => {
    const create = jest.fn(() => makeDto());
    const controller = new McpServersController({ create } as never, {} as never);
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
    );
    expect(controller.update('bridgememory', { enabled: false })).toBe(dto);
    expect(() => controller.update('ghost', { enabled: false })).toThrow(NotFoundException);
  });

  it('remove 404s on unknown id', () => {
    const controller = new McpServersController(
      { delete: (id: string) => id === 'bridgememory' } as never,
      {} as never,
    );
    expect(controller.remove('bridgememory')).toEqual({ deleted: true });
    expect(() => controller.remove('ghost')).toThrow(NotFoundException);
  });

  it('import validates the source and routes dryRun to preview', async () => {
    const preview = jest.fn(async () => ({ source: 'cursor', entries: [] }));
    const apply = jest.fn(async () => ({ source: 'cursor', createdIds: [], mergedIds: [] }));
    const controller = new McpServersController({} as never, { preview, apply } as never);

    await expect(controller.import({ source: 'notastore' as never })).rejects.toThrow(
      BadRequestException,
    );
    await controller.import({ source: 'cursor', dryRun: true });
    expect(preview).toHaveBeenCalledWith('cursor');
    expect(apply).not.toHaveBeenCalled();
    await controller.import({ source: 'cursor' });
    expect(apply).toHaveBeenCalledWith('cursor');
  });
});
