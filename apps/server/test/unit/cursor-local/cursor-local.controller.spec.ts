import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'bun:test';
import { CursorLocalController } from '../../../src/cursor-local/cursor-local.controller';

describe('CursorLocalController', () => {
  const workspace = '/tmp/demo-repo';
  const items = [
    {
      chatId: 'chat-1',
      workspace,
      title: 'Demo',
      preview: 'hello',
      updatedAt: 1,
      messageCount: 2,
      alreadyImported: false,
    },
  ];

  it('requires the workspace query param', () => {
    const controller = new CursorLocalController({ listForWorkspace: () => items } as never);
    expect(() => controller.list('  ')).toThrow(BadRequestException);
    expect(() => controller.list(undefined)).toThrow(BadRequestException);
  });

  it('lists local Cursor sessions for a workspace with an optional limit', () => {
    let capturedLimit: number | undefined;
    const controller = new CursorLocalController({
      listForWorkspace: (_ws: string, limit?: number) => {
        capturedLimit = limit;
        return items;
      },
    } as never);

    expect(controller.list(workspace, '15')).toEqual({ items });
    expect(capturedLimit).toBe(15);
  });

  it('ignores non-finite limit values', () => {
    let capturedLimit: number | undefined = 99;
    const controller = new CursorLocalController({
      listForWorkspace: (_ws: string, limit?: number) => {
        capturedLimit = limit;
        return items;
      },
    } as never);

    expect(controller.list(workspace, 'nope')).toEqual({ items });
    expect(capturedLimit).toBeUndefined();
  });
});
