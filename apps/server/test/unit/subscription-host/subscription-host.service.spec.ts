import { beforeEach, describe, expect, it } from 'bun:test';
import type { ModelProviderDto } from '../../../src/models/models.types';
import { SubscriptionHostManagedHost } from '../../../src/subscription-host/subscription-host.managed-host';
import { SubscriptionHostService } from '../../../src/subscription-host/subscription-host.service';

class FakeSettings {
  private readonly values = new Map<string, string>();
  private readonly listeners: Array<(key: string) => void> = [];
  set(key: string, value: string) {
    this.values.set(key, value);
    for (const listener of this.listeners) listener(key);
  }
  resolve(key: string): string | undefined {
    return this.values.get(key);
  }
  onChange(listener: (key: string) => void): void {
    this.listeners.push(listener);
  }
}

class FakeHost {
  running = false;
  startCalls = 0;
  stopCalls = 0;
  lastSpec: unknown = null;
  async start(spec: unknown): Promise<void> {
    this.startCalls += 1;
    this.lastSpec = spec;
    this.running = true;
  }
  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.running = false;
  }
  isRunning(): boolean {
    return this.running;
  }
  pid(name: 'broker' | 'router'): number | null {
    return this.running ? (name === 'broker' ? 4200 : 4201) : null;
  }
}

function build(settings = new FakeSettings(), host = new FakeHost()) {
  const db = { dataDir: '/tmp/nuncio-data' } as { dataDir: string };
  const service = new SubscriptionHostService(
    settings as never,
    db as never,
    host as unknown as SubscriptionHostManagedHost,
  );
  return { service, settings, host };
}

function okModelsResponse() {
  return async () =>
    new Response(JSON.stringify({ data: [{ id: 'gpt-x-sol' }, { id: 'sonnet-sub' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
}

const PI_CATALOG: ModelProviderDto[] = [{ id: 'pi', name: 'Nuncio Engine', groups: [] }];

describe('SubscriptionHostService', () => {
  let settings: FakeSettings;

  beforeEach(() => {
    settings = new FakeSettings();
  });

  it('stays inert and boots clean when disabled', async () => {
    const { service, host } = build(settings);
    service.installImpl = async () => {
      throw new Error('should never install when disabled');
    };
    await service.reconcileNow();

    const status = await service.status();
    expect(status).toMatchObject({ enabled: false, online: false, modelCount: 0, error: null });
    expect(host.startCalls).toBe(0);
    expect(await service.mergeIntoNuncioEngineCatalog(PI_CATALOG)).toEqual(PI_CATALOG);
  });

  it('installs the pinned version, starts broker+router, and exposes the model group', async () => {
    const { service, host } = build(settings);
    let installedWith: { dir: string; packageName: string; version: string } | null = null;
    service.installImpl = async (opts) => {
      installedWith = opts;
      return { version: opts.version, bin: `${opts.dir}/node_modules/.bin/omp` };
    };
    service.fetchImpl = okModelsResponse() as unknown as typeof fetch;

    settings.set('NUNCIO_SUBHOST_ENABLED', '1');
    settings.set('NUNCIO_SUBHOST_VERSION', '0.3.1');
    await service.reconcileNow();

    expect(installedWith).toMatchObject({ version: '0.3.1' });
    expect((installedWith as unknown as { dir: string }).dir).toContain('subscription-host');
    expect(host.startCalls).toBe(1);
    const spec = host.lastSpec as { processes: Array<{ name: string }>; env?: Record<string, string> };
    expect(spec.processes.map((p) => p.name)).toEqual(['broker', 'router']);
    // The sign-in vault lives under the data dir so it backs up with Nuncio.
    expect(JSON.stringify(spec.env)).toContain('/tmp/nuncio-data');

    const status = await service.status();
    expect(status).toMatchObject({ enabled: true, online: true, modelCount: 2, error: null });
    expect(status.managed).toMatchObject({ running: true });

    const merged = await service.mergeIntoNuncioEngineCatalog(PI_CATALOG);
    const pi = merged.find((p) => p.id === 'pi');
    const group = pi?.groups?.find((g) => g.id === 'subscription-host');
    expect(group?.models).toHaveLength(2);
    expect(group?.models[0].id).toBe('pi:gpt-x-sol');
  });

  it('surfaces the error and omits the model group when install fails (fail-soft)', async () => {
    const { service, host } = build(settings);
    service.installImpl = async () => {
      throw new Error('npm registry unreachable');
    };
    settings.set('NUNCIO_SUBHOST_ENABLED', '1');

    // Reconcile must not throw even though install fails.
    await service.reconcileNow();

    const status = await service.status();
    expect(status.enabled).toBe(true);
    expect(status.online).toBe(false);
    expect(status.error).toContain('npm registry unreachable');
    expect(host.startCalls).toBe(0);
    expect(await service.mergeIntoNuncioEngineCatalog(PI_CATALOG)).toEqual(PI_CATALOG);
  });

  it('tears the children down on shutdown', async () => {
    const { service, host } = build(settings);
    service.installImpl = async (opts) => ({ version: opts.version, bin: `${opts.dir}/bin` });
    service.fetchImpl = okModelsResponse() as unknown as typeof fetch;
    settings.set('NUNCIO_SUBHOST_ENABLED', '1');
    await service.reconcileNow();
    expect(host.isRunning()).toBe(true);

    await service.onModuleDestroy();
    expect(host.stopCalls).toBeGreaterThanOrEqual(1);
    expect(host.isRunning()).toBe(false);
  });

  it('stops the managed host when it is disabled again', async () => {
    const { service, host } = build(settings);
    service.installImpl = async (opts) => ({ version: opts.version, bin: `${opts.dir}/bin` });
    service.fetchImpl = okModelsResponse() as unknown as typeof fetch;
    settings.set('NUNCIO_SUBHOST_ENABLED', '1');
    await service.reconcileNow();
    expect(host.isRunning()).toBe(true);

    settings.set('NUNCIO_SUBHOST_ENABLED', '0');
    await service.reconcileNow();
    expect(host.isRunning()).toBe(false);
  });
});
