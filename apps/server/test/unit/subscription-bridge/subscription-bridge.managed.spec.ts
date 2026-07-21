import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Test, type TestingModule } from '@nestjs/testing';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseModule } from '../../../src/db/database.module';
import { SettingsModule } from '../../../src/settings/settings.module';
import { SettingsService } from '../../../src/settings/settings.service';
import { SubscriptionBridgeService } from '../../../src/subscription-bridge/subscription-bridge.service';
import { CliproxyManagedHost } from '../../../src/subscription-bridge/subscription-bridge.managed-host';

describe('SubscriptionBridge managed / external modes', () => {
  let module: TestingModule;
  let settings: SettingsService;
  let bridge: SubscriptionBridgeService;
  let host: CliproxyManagedHost;
  let dataDir: string;
  let homeDir: string;
  let fakeBin: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-bridge-managed-'));
    homeDir = mkdtempSync(join(tmpdir(), 'nuncio-bridge-home-'));
    fakeBin = join(homeDir, 'cli-proxy-api');
    writeFileSync(fakeBin, '#!/bin/sh\n', { mode: 0o755 });
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule, SettingsModule],
      providers: [CliproxyManagedHost, SubscriptionBridgeService],
    }).compile();
    settings = module.get(SettingsService);
    bridge = module.get(SubscriptionBridgeService);
    host = module.get(CliproxyManagedHost);
    // Avoid actually spawning binaries in unit tests.
    host.spawnImpl = async () => {
      let signalSent = false;
      let settled = false;
      let resolveExit!: (code: number | null) => void;
      const exited = new Promise<number | null>((resolve) => {
        resolveExit = (code) => {
          settled = true;
          resolve(code);
        };
      });
      return {
        pid: 4242,
        get killed() {
          return signalSent || settled;
        },
        get hasExited() {
          return settled;
        },
        kill() {
          signalSent = true;
          resolveExit(0);
        },
        exited,
      };
    };
    settings.set('NUNCIO_CLIPROXY_BIN', fakeBin);
  });

  afterEach(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.NUNCIO_CLIPROXY_MODE;
    delete process.env.NUNCIO_CLIPROXY_ENABLED;
    delete process.env.NUNCIO_CLIPROXY_PORT;
  });

  it('reports mode=external by default in status', async () => {
    const status = await bridge.status();
    expect(status.mode).toBe('external');
    expect(status.managed.running).toBe(false);
  });

  it('adoptExternal writes settings from a discovered config without spawning', async () => {
    const installDir = join(homeDir, 'cliproxyapi');
    mkdirSync(installDir, { recursive: true });
    writeFileSync(
      join(installDir, 'config.yaml'),
      `port: 8317\napi-keys:\n  - "adopt-key-abcdef12"\n`,
      'utf8',
    );
    writeFileSync(join(installDir, 'cli-proxy-api'), '#!/bin/sh\n', { mode: 0o755 });

    const result = await bridge.adoptExternal({
      configPath: join(installDir, 'config.yaml'),
      apiKeyIndex: 0,
      homeDir,
    });

    expect(result.mode).toBe('external');
    expect(settings.resolve('NUNCIO_CLIPROXY_MODE')).toBe('external');
    expect(settings.resolve('NUNCIO_CLIPROXY_ENABLED')).toBe('1');
    expect(settings.resolve('NUNCIO_CLIPROXY_BASE_URL')).toBe('http://127.0.0.1:8317');
    expect(settings.resolve('NUNCIO_CLIPROXY_API_KEY')).toBe('adopt-key-abcdef12');
    expect(settings.resolve('NUNCIO_CLIPROXY_BIN')).toBe(join(installDir, 'cli-proxy-api'));
    expect(host.isRunning()).toBe(false);
  });

  it('initManaged writes cliproxyapi-nuncio config under dataDir and sets managed mode', async () => {
    const result = await bridge.initManaged({ port: 18317 });
    expect(result.mode).toBe('managed');
    expect(settings.resolve('NUNCIO_CLIPROXY_MODE')).toBe('managed');
    expect(settings.resolve('NUNCIO_CLIPROXY_ENABLED')).toBe('1');
    expect(settings.resolve('NUNCIO_CLIPROXY_BASE_URL')).toBe('http://127.0.0.1:18317');
    expect(settings.resolve('NUNCIO_CLIPROXY_API_KEY')?.length).toBeGreaterThan(8);

    const configPath = join(dataDir, 'cliproxyapi', 'config.yaml');
    expect(existsSync(configPath)).toBe(true);
    const yaml = readFileSync(configPath, 'utf8');
    expect(yaml).toContain('port: 18317');
    expect(yaml).toContain('auth-dir:');
    expect(host.isRunning()).toBe(true);
  });

  it('migrateManaged copies external config into dataDir and can remaps the port', async () => {
    const installDir = join(homeDir, 'cliproxyapi');
    const authDir = join(homeDir, '.cli-proxy-api');
    mkdirSync(installDir, { recursive: true });
    mkdirSync(authDir, { recursive: true });
    writeFileSync(
      join(installDir, 'config.yaml'),
      `port: 8317\nauth-dir: "${authDir}"\napi-keys:\n  - "migrate-key-zzzz9999"\n`,
      'utf8',
    );
    writeFileSync(join(installDir, 'cli-proxy-api'), '#!/bin/sh\n', { mode: 0o755 });

    const result = await bridge.migrateManaged({
      configPath: join(installDir, 'config.yaml'),
      port: 18317,
      homeDir,
    });

    expect(result.mode).toBe('managed');
    const managedConfig = join(dataDir, 'cliproxyapi', 'config.yaml');
    expect(existsSync(managedConfig)).toBe(true);
    const yaml = readFileSync(managedConfig, 'utf8');
    expect(yaml).toContain('port: 18317');
    expect(yaml).toContain(authDir);
    expect(settings.resolve('NUNCIO_CLIPROXY_BASE_URL')).toBe('http://127.0.0.1:18317');
    expect(settings.resolve('NUNCIO_CLIPROXY_API_KEY')).toBe('migrate-key-zzzz9999');
    expect(host.isRunning()).toBe(true);
  });

  it('discover returns installs under home without mutating settings', async () => {
    const installDir = join(homeDir, 'cliproxyapi');
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, 'config.yaml'), 'port: 8317\napi-keys:\n  - "k-abcdef12"\n', 'utf8');

    const found = bridge.discover({ homeDir });
    expect(found).toHaveLength(1);
    expect(found[0]?.port).toBe(8317);
    expect(settings.resolve('NUNCIO_CLIPROXY_MODE')).toBe('external');
  });
});
