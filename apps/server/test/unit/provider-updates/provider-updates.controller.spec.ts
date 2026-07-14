import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'bun:test';
import { ProviderUpdatesController } from '../../../src/provider-updates/provider-updates.controller';
import type {
  ProviderUpdateRunResultDto,
  ProviderUpdatesDto,
} from '../../../src/provider-updates/provider-updates.types';

describe('ProviderUpdatesController', () => {
  const advisories: ProviderUpdatesDto = {
    enabled: true,
    notificationsEnabled: true,
    providers: [
      {
        provider: 'pi',
        name: 'Pi',
        currentVersion: '1.0.0',
        latestVersion: '1.0.1',
        status: 'behind_latest',
        canUpdate: true,
        updateCommand: 'pi update',
        message: null,
        checkedAt: '2024-01-01T00:00:00Z',
        muted: false,
      },
    ],
  };

  const updateResult: ProviderUpdateRunResultDto = {
    provider: 'pi',
    status: 'succeeded',
    message: 'Updated',
    output: 'ok',
    providerStatus: advisories.providers[0]!,
  };

  it('lists provider update advisories', async () => {
    const controller = new ProviderUpdatesController({
      list: async () => advisories,
      update: async () => updateResult,
    } as never);
    await expect(controller.list()).resolves.toEqual(advisories);
  });

  it('triggers an allowlisted provider update', async () => {
    const updateCalls: string[] = [];
    const controller = new ProviderUpdatesController({
      list: async () => advisories,
      update: async (provider: string) => {
        updateCalls.push(provider);
        return { ...updateResult, provider: provider as ProviderUpdateRunResultDto['provider'] };
      },
    } as never);

    await expect(controller.update('pi')).resolves.toMatchObject({ provider: 'pi', status: 'succeeded' });
    await expect(controller.update('codex')).resolves.toMatchObject({ provider: 'codex', status: 'succeeded' });
    expect(updateCalls).toEqual(['pi', 'codex']);
  });

  it('rejects unknown provider tool ids', () => {
    const controller = new ProviderUpdatesController({
      list: async () => advisories,
      update: async () => updateResult,
    } as never);
    expect(() => controller.update('cursor')).toThrow(BadRequestException);
    expect(() => controller.update('cursor')).toThrow(/Unknown provider tool/);
  });
});
