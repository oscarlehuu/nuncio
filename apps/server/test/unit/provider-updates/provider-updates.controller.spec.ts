import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'bun:test';
import { ProviderUpdatesController } from '../../../src/provider-updates/provider-updates.controller';

describe('ProviderUpdatesController', () => {
  it('lists provider update advisories', () => {
    const advisories = [{ provider: 'pi', current: '1.0.0', latest: '1.0.1' }];
    const controller = new ProviderUpdatesController({
      list: () => advisories,
      update: async () => ({ ok: true }),
    } as never);
    expect(controller.list()).toEqual(advisories);
  });

  it('triggers an allowlisted provider update', async () => {
    const updateCalls: string[] = [];
    const controller = new ProviderUpdatesController({
      list: () => [],
      update: async (provider: string) => {
        updateCalls.push(provider);
        return { ok: true, provider };
      },
    } as never);

    await expect(controller.update('pi')).resolves.toEqual({ ok: true, provider: 'pi' });
    await expect(controller.update('codex')).resolves.toEqual({ ok: true, provider: 'codex' });
    expect(updateCalls).toEqual(['pi', 'codex']);
  });

  it('rejects unknown provider tool ids', () => {
    const controller = new ProviderUpdatesController({
      list: () => [],
      update: async () => ({ ok: true }),
    } as never);
    expect(() => controller.update('cursor')).toThrow(BadRequestException);
    expect(() => controller.update('cursor')).toThrow(/Unknown provider tool/);
  });
});
