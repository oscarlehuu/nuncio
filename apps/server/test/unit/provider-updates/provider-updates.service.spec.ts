import { describe, expect, it } from 'bun:test';
import { ProviderUpdatesService } from '../../../src/provider-updates/provider-updates.service';
import type { SettingsService } from '../../../src/settings/settings.service';

function serviceWith(settings: Record<string, string | undefined>) {
  const service = new ProviderUpdatesService({
    resolve: (key: string) => settings[key],
  } as unknown as SettingsService);
  return service;
}

describe('ProviderUpdatesService', () => {
  it('reports Pi and Codex as behind latest with user-initiated update metadata', async () => {
    const service = serviceWith({
      NUNCIO_PROVIDER_UPDATE_CHECKS: '1',
      NUNCIO_CODEX_BIN: 'codex',
      NUNCIO_PI_BIN: 'pi',
    });
    service.commandRunner = async (command, args) => ({
      status: 0,
      stdout:
        args[0] === '--version'
          ? command === 'codex'
            ? 'codex-cli 0.141.0'
            : '0.80.2'
          : '',
      stderr: '',
    });
    service.latestVersionResolver = async (packageName) =>
      packageName === '@openai/codex' ? '0.142.5' : '0.80.3';
    service.realCommandPathResolver = () => null;

    const result = await service.list();

    expect(result.enabled).toBe(true);
    expect(result.providers).toHaveLength(2);
    expect(result.providers.map((provider) => provider.provider).sort()).toEqual(['codex', 'pi']);
    expect(result.providers.find((provider) => provider.provider === 'pi')).toMatchObject({
      currentVersion: '0.80.2',
      latestVersion: '0.80.3',
      status: 'behind_latest',
      canUpdate: true,
      updateCommand: 'pi update',
    });
    expect(result.providers.find((provider) => provider.provider === 'codex')).toMatchObject({
      currentVersion: '0.141.0',
      latestVersion: '0.142.5',
      status: 'behind_latest',
    });
  });

  it('does not probe CLIs or registries when provider update checks are disabled', async () => {
    const service = serviceWith({ NUNCIO_PROVIDER_UPDATE_CHECKS: '0' });
    let commandCalls = 0;
    let registryCalls = 0;
    service.commandRunner = async () => {
      commandCalls += 1;
      return { status: 0, stdout: '9.9.9', stderr: '' };
    };
    service.latestVersionResolver = async () => {
      registryCalls += 1;
      return '9.9.9';
    };

    await expect(service.list()).resolves.toEqual({ enabled: false, notificationsEnabled: false, providers: [] });
    expect(commandCalls).toBe(0);
    expect(registryCalls).toBe(0);
  });

  it('runs the Pi native update command only after an explicit update request', async () => {
    const service = serviceWith({ NUNCIO_PI_BIN: 'pi' });
    const calls: Array<{ command: string; args: string[] }> = [];
    service.commandRunner = async (command, args) => {
      calls.push({ command, args });
      if (args.includes('update')) return { status: 0, stdout: 'updated', stderr: '' };
      return { status: 0, stdout: calls.length > 2 ? '0.80.3' : '0.80.2', stderr: '' };
    };
    service.latestVersionResolver = async () => '0.80.3';
    service.realCommandPathResolver = () => null;

    const result = await service.update('pi');

    expect(calls.some((call) => call.command === 'pi' && call.args[0] === 'update')).toBe(true);
    expect(result.status).toBe('succeeded');
  });

  it('uses npm to update Pi when the installed CLI is npm global', async () => {
    const service = serviceWith({ NUNCIO_PI_BIN: 'pi' });
    service.realCommandPathResolver = () =>
      '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js';
    const calls: Array<{ command: string; args: string[] }> = [];
    let piVersion = '0.80.2';
    service.commandRunner = async (command, args) => {
      calls.push({ command, args });
      if (command === 'npm') {
        piVersion = '0.80.3';
        return { status: 0, stdout: 'updated', stderr: '' };
      }
      return { status: 0, stdout: command === 'pi' ? piVersion : 'codex-cli 0.142.5', stderr: '' };
    };
    service.latestVersionResolver = async () => '0.80.3';

    const before = (await service.list()).providers.find((provider) => provider.provider === 'pi');
    const result = await service.update('pi');

    expect(before).toMatchObject({
      status: 'behind_latest',
      canUpdate: true,
      updateCommand: 'npm install -g @earendil-works/pi-coding-agent@latest',
    });
    expect(calls.some((call) => call.command === 'npm' && call.args.includes('@earendil-works/pi-coding-agent@latest'))).toBe(
      true,
    );
    expect(result.status).toBe('succeeded');
  });

  it('offers a one-click Codex update only for detected package-manager installs', async () => {
    const service = serviceWith({ NUNCIO_CODEX_BIN: 'codex' });
    service.realCommandPathResolver = () =>
      '/Users/test/.npm-global/lib/node_modules/@openai/codex/bin/codex';
    service.commandRunner = async () => ({ status: 0, stdout: 'codex-cli 0.141.0', stderr: '' });
    service.latestVersionResolver = async () => '0.142.5';

    const status = (await service.list()).providers.find((provider) => provider.provider === 'codex');

    expect(status).toMatchObject({
      status: 'behind_latest',
      canUpdate: true,
      updateCommand: 'npm install -g @openai/codex@latest',
    });
  });

  it('uses the Codex native update command for standalone installs', async () => {
    const service = serviceWith({ NUNCIO_CODEX_BIN: '/Users/test/.local/bin/codex' });
    service.realCommandPathResolver = () =>
      '/Users/test/.codex/packages/standalone/current/bin/codex';
    const calls: Array<{ command: string; args: string[] }> = [];
    let codexVersion = '0.141.0';
    service.commandRunner = async (command, args) => {
      calls.push({ command, args });
      if (args[0] === 'update') {
        codexVersion = '0.142.5';
        return { status: 0, stdout: 'updated', stderr: '' };
      }
      return {
        status: 0,
        stdout: command.includes('codex') ? `codex-cli ${codexVersion}` : '0.80.3',
        stderr: '',
      };
    };
    service.latestVersionResolver = async () => '0.142.5';

    const status = (await service.list()).providers.find((provider) => provider.provider === 'codex');
    const result = await service.update('codex');

    expect(status).toMatchObject({
      status: 'behind_latest',
      canUpdate: true,
      updateCommand: '/Users/test/.local/bin/codex update',
    });
    expect(calls.some((call) => call.command === '/Users/test/.local/bin/codex' && call.args[0] === 'update')).toBe(
      true,
    );
    expect(result.status).toBe('succeeded');
  });

  it('reports notification mute state without hiding manual update metadata', async () => {
    const service = serviceWith({
      NUNCIO_CLI_UPDATE_NOTIFICATIONS: '0',
      NUNCIO_CLI_UPDATE_MUTED: 'pi',
      NUNCIO_PI_BIN: 'pi',
    });
    service.commandRunner = async (command) => ({
      status: 0,
      stdout: command === 'pi' ? '0.80.2' : 'codex-cli 0.141.0',
      stderr: '',
    });
    service.latestVersionResolver = async (packageName) =>
      packageName === '@openai/codex' ? '0.142.5' : '0.80.3';

    const result = await service.list();
    const pi = result.providers.find((provider) => provider.provider === 'pi');

    expect(result.notificationsEnabled).toBe(false);
    expect(pi).toMatchObject({
      status: 'behind_latest',
      muted: true,
      currentVersion: '0.80.2',
      latestVersion: '0.80.3',
      canUpdate: true,
    });
  });
});
