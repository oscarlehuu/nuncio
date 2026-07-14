import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'bun:test';
import { PiLocalController } from '../../../src/pi-local/pi-local.controller';
import type { LocalPiSessionDto } from '../../../src/pi-local/pi-local-sessions.types';

describe('PiLocalController', () => {
  const workspace = '/tmp/demo-repo';
  const items: LocalPiSessionDto[] = [
    {
      sessionId: 'pi-1',
      path: '/tmp/pi/session.jsonl',
      workspace,
      title: 'Demo',
      preview: 'hello',
      updatedAt: 1,
      messageCount: 2,
      alreadyImported: false,
    },
  ];

  it('requires the workspace query param', async () => {
    const controller = new PiLocalController({
      listForWorkspace: async () => items,
    } as never);

    await expect(controller.list('  ')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.list(undefined)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lists local Pi sessions for a workspace with an optional limit', async () => {
    const listForWorkspace = async (ws: string, limit?: number) => {
      expect(ws).toBe(workspace);
      expect(limit).toBe(10);
      return items;
    };
    const controller = new PiLocalController({ listForWorkspace } as never);

    await expect(controller.list(workspace, '10')).resolves.toEqual({ items });
  });

  it('ignores non-finite limit values', async () => {
    const listForWorkspace = async (_ws: string, limit?: number) => {
      expect(limit).toBeUndefined();
      return items;
    };
    const controller = new PiLocalController({ listForWorkspace } as never);

    await expect(controller.list(workspace, 'not-a-number')).resolves.toEqual({ items });
  });
});
