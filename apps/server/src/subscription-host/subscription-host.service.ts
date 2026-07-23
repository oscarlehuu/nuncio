import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseService } from '../db/database.service';
import { SettingsService } from '../settings/settings.service';
import type { ModelItemDto, ModelProviderDto } from '../models/models.types';
import {
  SubscriptionHostManagedHost,
  type SubscriptionHostStartSpec,
} from './subscription-host.managed-host';
import type {
  SubscriptionHostMode,
  SubscriptionHostModel,
  SubscriptionHostStatusDto,
} from './subscription-host.types';
import {
  buildBuiltinLookup,
  buildSubscriptionHostProviderConfig,
  SUBSCRIPTION_HOST_PROVIDER_ID,
  type PiProviderRegistrar,
} from './subscription-host.pi-provider';

/**
 * Underlying helper package — deliberately never surfaced in the UI. The setting
 * users see is "Subscription model host (managed)".
 */
const SUBSCRIPTION_HOST_PACKAGE = '@oh-my-pi/pi-coding-agent';
/**
 * Pinned default; the operator can override via NUNCIO_SUBHOST_VERSION. This is
 * the first published version whose CLI exposes the `auth-broker` / `auth-gateway`
 * subcommands and the `omp` binary this module drives — older versions are a bare
 * chat CLI with none of that.
 */
const DEFAULT_SUBSCRIPTION_HOST_VERSION = '17.0.7';
const DEFAULT_BROKER_PORT = 18_700;
const DEFAULT_ROUTER_PORT = 18_701;
const HEALTH_TIMEOUT_MS = 3_000;

const HOST_SETTING_KEYS = new Set([
  'NUNCIO_SUBHOST_ENABLED',
  'NUNCIO_SUBHOST_MODE',
  'NUNCIO_SUBHOST_VERSION',
  'NUNCIO_SUBHOST_BROKER_PORT',
  'NUNCIO_SUBHOST_ROUTER_PORT',
]);

export interface SubscriptionHostInstallResult {
  version: string;
  bin: string;
}

export type SubscriptionHostInstallImpl = (opts: {
  dir: string;
  packageName: string;
  version: string;
}) => Promise<SubscriptionHostInstallResult>;

@Injectable()
export class SubscriptionHostService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SubscriptionHostService.name);

  /** Overridable for unit tests. */
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);
  /** Overridable for unit tests. */
  installImpl: SubscriptionHostInstallImpl = defaultInstall;

  private installed: SubscriptionHostInstallResult | null = null;
  private lastError: string | null = null;
  private catalogCache: { at: number; models: SubscriptionHostModel[] } | null = null;
  private readonly catalogTtlMs = 15_000;
  private reconcileChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly settings: SettingsService,
    private readonly db: DatabaseService,
    private readonly host: SubscriptionHostManagedHost,
  ) {}

  onModuleInit(): void {
    this.settings.onChange((key) => {
      if (HOST_SETTING_KEYS.has(key)) {
        this.catalogCache = null;
        void this.enqueueReconcile();
      }
    });
    void this.enqueueReconcile();
  }

  async onModuleDestroy(): Promise<void> {
    await this.host.stop();
  }

  isEnabled(): boolean {
    const raw = this.settings.resolve('NUNCIO_SUBHOST_ENABLED')?.trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'on';
  }

  mode(): SubscriptionHostMode {
    const raw = this.settings.resolve('NUNCIO_SUBHOST_MODE')?.trim().toLowerCase();
    return raw === 'external' ? 'external' : 'managed';
  }

  version(): string {
    return this.settings.resolve('NUNCIO_SUBHOST_VERSION')?.trim() || DEFAULT_SUBSCRIPTION_HOST_VERSION;
  }

  brokerPort(): number {
    return this.resolvePort('NUNCIO_SUBHOST_BROKER_PORT', DEFAULT_BROKER_PORT);
  }

  routerPort(): number {
    return this.resolvePort('NUNCIO_SUBHOST_ROUTER_PORT', DEFAULT_ROUTER_PORT);
  }

  routerBaseUrl(): string {
    return `http://127.0.0.1:${this.routerPort()}`;
  }

  /** Install dir + sign-in vault live under the data dir so they move with Nuncio. */
  dataDir(): string {
    return join(this.db.dataDir, 'subscription-host');
  }

  signInStoreDir(): string {
    return join(this.dataDir(), 'home');
  }

  async status(opts?: { forceRefresh?: boolean }): Promise<SubscriptionHostStatusDto> {
    const enabled = this.isEnabled();
    const base: SubscriptionHostStatusDto = {
      enabled,
      online: false,
      mode: this.mode(),
      version: this.version(),
      installedVersion: this.installed?.version ?? null,
      baseUrl: this.routerBaseUrl(),
      brokerPort: this.brokerPort(),
      routerPort: this.routerPort(),
      managed: {
        running: this.host.isRunning(),
        brokerPid: this.host.pid('broker'),
        routerPid: this.host.pid('router'),
      },
      modelCount: 0,
      error: this.lastError,
    };
    if (!enabled) return { ...base, error: null };

    try {
      const models = await this.fetchCatalog(opts?.forceRefresh === true);
      return { ...base, online: true, modelCount: models.length, error: null };
    } catch (error) {
      return { ...base, online: false, error: this.lastError ?? messageOf(error) };
    }
  }

  async listModels(): Promise<SubscriptionHostModel[]> {
    if (!this.isEnabled()) return [];
    try {
      return await this.fetchCatalog(false);
    } catch {
      return [];
    }
  }

  /** Merge the host's models as a group under the Nuncio Engine (`pi`) catalog. */
  async mergeIntoNuncioEngineCatalog(catalog: ModelProviderDto[]): Promise<ModelProviderDto[]> {
    const models = await this.listModels();
    if (models.length === 0) return catalog;

    const items: ModelItemDto[] = models.map((model) => ({
      id: `${SUBSCRIPTION_HOST_PROVIDER_ID}:${model.id}`,
      name: model.displayName,
      sub: 'via Subscription model host',
      badge: 'Subscription',
    }));
    const group = {
      id: 'subscription-host',
      name: 'Subscription models',
      sub: 'Managed subscription model host',
      badge: 'Subscription',
      models: items,
    };

    return catalog.map((provider) => {
      if (provider.id !== 'pi') return provider;
      const groups = [...(provider.groups ?? [])];
      const existing = groups.findIndex((g) => g.id === 'subscription-host');
      if (existing >= 0) groups[existing] = group;
      else groups.push(group);
      return { ...provider, groups };
    });
  }

  /**
   * Register (or tear down) the host's catalog as a `subscription-host` provider
   * on a Pi ModelRegistry so a chosen `subscription-host:<id>` model routes to the
   * router's loopback `/v1` endpoint. Fail-soft: when the host is disabled or
   * offline the catalog is empty and the provider is unregistered, so a session
   * falls back exactly as before and no stale routing lingers (teardown symmetry).
   */
  async applyToPiRegistry(registry: PiProviderRegistrar): Promise<void> {
    const models = await this.listModels();
    if (models.length === 0) {
      registry.unregisterProvider(SUBSCRIPTION_HOST_PROVIDER_ID);
      return;
    }
    const config = buildSubscriptionHostProviderConfig(
      this.routerBaseUrl(),
      models,
      buildBuiltinLookup(registry),
    );
    registry.registerProvider(SUBSCRIPTION_HOST_PROVIDER_ID, config);
  }

    async restart(): Promise<SubscriptionHostStatusDto> {
    this.installed = null;
    await this.host.stop();
    await this.enqueueReconcile();
    return this.status({ forceRefresh: true });
  }

  /** Await the current reconcile (install + start) — test/settings-change seam. */
  reconcileNow(): Promise<void> {
    return this.enqueueReconcile();
  }

  private resolvePort(key: string, fallback: number): number {
    const raw = this.settings.resolve(key)?.trim();
    const parsed = raw ? Number(raw) : NaN;
    if (Number.isInteger(parsed) && parsed > 0 && parsed < 65_536) return parsed;
    return fallback;
  }

  private enqueueReconcile(): Promise<void> {
    this.reconcileChain = this.reconcileChain.then(() => this.reconcile()).catch(() => undefined);
    return this.reconcileChain;
  }

  private async reconcile(): Promise<void> {
    if (!this.isEnabled() || this.mode() !== 'managed') {
      if (this.host.isRunning()) await this.host.stop();
      return;
    }
    try {
      await this.ensureRunning();
      this.lastError = null;
    } catch (error) {
      // Fail-soft: surface the error in status, keep the model group absent, and
      // never crash boot — the current helper keeps working.
      this.lastError = messageOf(error);
      this.logger.warn(`Subscription host unavailable: ${this.lastError}`);
    }
  }

  private async ensureRunning(): Promise<void> {
    const dir = this.dataDir();
    mkdirSync(this.signInStoreDir(), { recursive: true });
    if (!this.installed || this.installed.version !== this.version()) {
      this.installed = await this.installImpl({
        dir,
        packageName: SUBSCRIPTION_HOST_PACKAGE,
        version: this.version(),
      });
    }
    const spec: SubscriptionHostStartSpec = {
      bin: this.installed.bin,
      cwd: dir,
      // Root the sign-in vault under the data dir (the CLI keeps it under
      // $HOME/.omp); Nuncio supervises the process but never reads the secrets
      // it holds. The router (gateway) discovers the broker via env.
      env: {
        HOME: this.signInStoreDir(),
        OMP_AUTH_BROKER_URL: `http://127.0.0.1:${this.brokerPort()}`,
      },
      processes: [
        {
          name: 'broker',
          args: ['auth-broker', 'serve', '--bind', `127.0.0.1:${this.brokerPort()}`],
        },
        {
          name: 'router',
          // Loopback-only; skip the per-request bearer so Nuncio's local catalog
          // fetch needs no token round-trip (same trust model as the existing
          // loopback helper).
          args: ['auth-gateway', 'serve', '--bind', `127.0.0.1:${this.routerPort()}`, '--no-auth'],
        },
      ],
    };
    await this.host.start(spec);
  }

  private async fetchCatalog(forceRefresh: boolean): Promise<SubscriptionHostModel[]> {
    const now = Date.now();
    if (!forceRefresh && this.catalogCache && now - this.catalogCache.at < this.catalogTtlMs) {
      return this.catalogCache.models;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(`${this.routerBaseUrl()}/v1/models`, {
        method: 'GET',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Subscription model host returned HTTP ${response.status}`);
      const body = (await response.json()) as unknown;
      const models = parseModelsResponse(body);
      this.catalogCache = { at: now, models };
      return models;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Subscription model host timed out after ${HEALTH_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseModelsResponse(body: unknown): SubscriptionHostModel[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const models: SubscriptionHostModel[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id) continue;
    models.push({
      id,
      displayName: typeof record.display_name === 'string' ? record.display_name : id,
      ...(typeof record.owned_by === 'string' ? { ownedBy: record.owned_by } : {}),
      ...(typeof record.api === 'string' ? { api: record.api } : {}),
    });
  }
  return models;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function defaultInstall(opts: {
  dir: string;
  packageName: string;
  version: string;
}): Promise<SubscriptionHostInstallResult> {
  mkdirSync(opts.dir, { recursive: true });
  // Install the pinned package into the data dir (never global). Bun resolves
  // the CLI binary under node_modules/.bin.
  const proc = Bun.spawn(['bun', 'add', '--no-save', `${opts.packageName}@${opts.version}`], {
    cwd: opts.dir,
    stdout: 'ignore',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Subscription model host install failed (exit ${code}): ${stderr.slice(0, 500)}`);
  }
  return { version: opts.version, bin: join(opts.dir, 'node_modules', '.bin', 'omp') };
}
