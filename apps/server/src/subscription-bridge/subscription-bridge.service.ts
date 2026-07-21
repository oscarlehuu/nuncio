import { BadRequestException, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseService } from '../db/database.service';
import { SettingsService } from '../settings/settings.service';
import type { ModelItemDto, ModelProviderDto } from '../models/models.types';
import {
  codexModelsForClaudePicker,
  isCodexBridgeModelId,
  parseBridgeModelsResponse,
} from './subscription-bridge.catalog';
import {
  defaultManagedCliproxyPort,
  discoverCliproxyInstalls,
  readCliproxyConfigFile,
  type CliproxyDiscoveryDto,
} from './subscription-bridge.discover';
import { CliproxyManagedHost } from './subscription-bridge.managed-host';
import type {
  AdoptExternalDto,
  InitManagedDto,
  MigrateManagedDto,
  SubscriptionBridgeClaudeCodeEnvDto,
  SubscriptionBridgeMode,
  SubscriptionBridgeModel,
  SubscriptionBridgeStatusDto,
} from './subscription-bridge.types';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8317';
const HEALTH_TIMEOUT_MS = 3_000;

const BRIDGE_SETTING_KEYS = new Set([
  'NUNCIO_CLIPROXY_ENABLED',
  'NUNCIO_CLIPROXY_MODE',
  'NUNCIO_CLIPROXY_BASE_URL',
  'NUNCIO_CLIPROXY_PORT',
  'NUNCIO_CLIPROXY_API_KEY',
  'NUNCIO_CLIPROXY_BIN',
]);

@Injectable()
export class SubscriptionBridgeService implements OnModuleInit, OnModuleDestroy {
  /** Overridable for unit tests. */
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);

  private catalogCache: { at: number; models: SubscriptionBridgeModel[] } | null = null;
  private readonly catalogTtlMs = 15_000;
  private reconcileChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly settings: SettingsService,
    private readonly db: DatabaseService,
    private readonly managedHost: CliproxyManagedHost,
  ) {}

  onModuleInit(): void {
    this.settings.onChange((key) => {
      if (BRIDGE_SETTING_KEYS.has(key)) {
        this.bustCache();
        this.enqueueReconcile();
      }
    });
    this.enqueueReconcile();
  }

  async onModuleDestroy(): Promise<void> {
    await this.managedHost.stop();
  }

  isEnabled(): boolean {
    return this.settings.resolve('NUNCIO_CLIPROXY_ENABLED') === '1';
  }

  mode(): SubscriptionBridgeMode {
    const raw = this.settings.resolve('NUNCIO_CLIPROXY_MODE')?.trim().toLowerCase();
    return raw === 'managed' ? 'managed' : 'external';
  }

  baseUrl(): string {
    const raw = this.settings.resolve('NUNCIO_CLIPROXY_BASE_URL')?.trim();
    return (raw || DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  managedPort(): number {
    const raw = this.settings.resolve('NUNCIO_CLIPROXY_PORT')?.trim();
    const parsed = raw ? Number(raw) : NaN;
    if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) return parsed;
    return defaultManagedCliproxyPort();
  }

  apiKey(): string | undefined {
    return this.settings.resolve('NUNCIO_CLIPROXY_API_KEY')?.trim() || undefined;
  }

  binaryPath(): string | undefined {
    return this.settings.resolve('NUNCIO_CLIPROXY_BIN')?.trim() || undefined;
  }

  managedConfigPath(): string {
    return join(this.db.dataDir, 'cliproxyapi', 'config.yaml');
  }

  managedAuthDir(): string {
    return join(this.db.dataDir, 'cliproxyapi', 'auth');
  }

  /** Whether a stripped Claude SDK model id must go through the bridge. */
  requiresBridge(strippedModelId: string | undefined | null): boolean {
    if (!strippedModelId?.trim()) return false;
    return isCodexBridgeModelId(strippedModelId);
  }

  /**
   * Env block for Claude Agent SDK when the selected model bills a Codex sub.
   * Throws when the bridge is required but disabled/offline/unconfigured.
   */
  async resolveClaudeSdkEnv(strippedModelId: string | undefined | null): Promise<Record<string, string> | null> {
    if (!this.requiresBridge(strippedModelId)) return null;

    if (!this.isEnabled()) {
      throw new Error(
        'Subscription bridge is required for this model but is disabled. Enable it in Settings → Subscription bridge.',
      );
    }

    const key = this.apiKey();
    if (!key) {
      throw new Error(
        'Subscription bridge API key is missing. Set NUNCIO_CLIPROXY_API_KEY in Settings → Subscription bridge.',
      );
    }

    const status = await this.status({ forceRefresh: true });
    if (!status.online) {
      throw new Error(
        status.error
          ? `Subscription bridge offline — ${status.error}`
          : 'Subscription bridge offline — start CLIProxyAPI or reconnect Codex.',
      );
    }
    if (!status.accounts.codex) {
      throw new Error(
        'Subscription bridge has no Codex account. Run the Codex login hint from Settings → Subscription bridge.',
      );
    }

    return {
      ANTHROPIC_BASE_URL: this.baseUrl(),
      ANTHROPIC_AUTH_TOKEN: key,
      ANTHROPIC_API_KEY: key,
    };
  }

  discover(opts?: { homeDir?: string }): CliproxyDiscoveryDto[] {
    return discoverCliproxyInstalls({ homeDir: opts?.homeDir });
  }

  async adoptExternal(
    dto: AdoptExternalDto & { homeDir?: string },
  ): Promise<SubscriptionBridgeStatusDto> {
    const configPath = dto.configPath?.trim();
    if (!configPath || !existsSync(configPath)) {
      throw new BadRequestException('CLIProxyAPI config path not found');
    }
    const parsed = readCliproxyConfigFile(configPath, dto.homeDir);
    const keyIndex = dto.apiKeyIndex ?? 0;
    const key = parsed.apiKeys[keyIndex];
    if (!key?.raw) {
      throw new BadRequestException('No api-keys entry found in that config');
    }
    const port = parsed.port;
    if (port == null) {
      throw new BadRequestException('Config is missing a port');
    }

    const installs = discoverCliproxyInstalls({
      homeDir: dto.homeDir,
      candidateConfigPaths: [configPath],
    });
    const binaryPath = installs[0]?.binaryPath ?? this.binaryPath();

    this.settings.set('NUNCIO_CLIPROXY_MODE', 'external');
    this.settings.set('NUNCIO_CLIPROXY_ENABLED', '1');
    this.settings.set('NUNCIO_CLIPROXY_BASE_URL', `http://127.0.0.1:${port}`);
    this.settings.set('NUNCIO_CLIPROXY_API_KEY', key.raw);
    if (binaryPath) this.settings.set('NUNCIO_CLIPROXY_BIN', binaryPath);

    await this.managedHost.stop();
    this.bustCache();
    return this.status({ forceRefresh: true });
  }

  async initManaged(dto: InitManagedDto = {}): Promise<SubscriptionBridgeStatusDto> {
    const port = dto.port ?? this.managedPort();
    const apiKey = `nuncio-${randomBytes(16).toString('hex')}`;
    const configPath = this.managedConfigPath();
    const authDir = this.managedAuthDir();
    mkdirSync(authDir, { recursive: true });
    mkdirSync(join(this.db.dataDir, 'cliproxyapi'), { recursive: true });

    const yaml = [
      '# Generated by Nuncio (cliproxyapi-nuncio).',
      `# Auth logins: Settings → Subscription bridge → login hints.`,
      `port: ${port}`,
      `auth-dir: "${authDir}"`,
      'debug: false',
      'api-keys:',
      `  - "${apiKey}"`,
      '',
    ].join('\n');
    writeFileSync(configPath, yaml, 'utf8');

    this.settings.set('NUNCIO_CLIPROXY_MODE', 'managed');
    this.settings.set('NUNCIO_CLIPROXY_ENABLED', '1');
    this.settings.set('NUNCIO_CLIPROXY_PORT', String(port));
    this.settings.set('NUNCIO_CLIPROXY_BASE_URL', `http://127.0.0.1:${port}`);
    this.settings.set('NUNCIO_CLIPROXY_API_KEY', apiKey);

    await this.ensureManagedRunning();
    this.bustCache();
    return this.status({ forceRefresh: true });
  }

  async migrateManaged(
    dto: MigrateManagedDto & { homeDir?: string },
  ): Promise<SubscriptionBridgeStatusDto> {
    const configPath = dto.configPath?.trim();
    if (!configPath || !existsSync(configPath)) {
      throw new BadRequestException('CLIProxyAPI config path not found');
    }
    const port = dto.port ?? this.managedPort();
    const sourceText = readFileSync(configPath, 'utf8');
    const parsed = readCliproxyConfigFile(configPath, dto.homeDir);
    const key = parsed.apiKeys[0];
    if (!key?.raw) {
      throw new BadRequestException('No api-keys entry found in that config');
    }

    const authDir = parsed.authDir ?? this.managedAuthDir();
    mkdirSync(join(this.db.dataDir, 'cliproxyapi'), { recursive: true });
    if (!parsed.authDir) mkdirSync(this.managedAuthDir(), { recursive: true });

    let yaml = sourceText;
    if (/^\s*port:\s*\d+\s*$/m.test(yaml)) {
      yaml = yaml.replace(/^\s*port:\s*\d+\s*$/m, `port: ${port}`);
    } else {
      yaml = `port: ${port}\n${yaml}`;
    }
    if (!/^\s*auth-dir:\s*/m.test(yaml)) {
      yaml = yaml.replace(/^(port:\s*\d+\s*\n)/m, `$1auth-dir: "${authDir}"\n`);
    }

    const managedPath = this.managedConfigPath();
    writeFileSync(managedPath, yaml, 'utf8');

    const installs = discoverCliproxyInstalls({
      homeDir: dto.homeDir,
      candidateConfigPaths: [configPath],
    });
    const binaryPath = installs[0]?.binaryPath ?? this.binaryPath();

    this.settings.set('NUNCIO_CLIPROXY_MODE', 'managed');
    this.settings.set('NUNCIO_CLIPROXY_ENABLED', '1');
    this.settings.set('NUNCIO_CLIPROXY_PORT', String(port));
    this.settings.set('NUNCIO_CLIPROXY_BASE_URL', `http://127.0.0.1:${port}`);
    this.settings.set('NUNCIO_CLIPROXY_API_KEY', key.raw);
    if (binaryPath) this.settings.set('NUNCIO_CLIPROXY_BIN', binaryPath);

    await this.ensureManagedRunning();
    this.bustCache();
    return this.status({ forceRefresh: true });
  }

  async startManaged(): Promise<SubscriptionBridgeStatusDto> {
    if (this.mode() !== 'managed') {
      throw new BadRequestException('Switch mode to managed before starting cliproxyapi-nuncio');
    }
    this.settings.set('NUNCIO_CLIPROXY_ENABLED', '1');
    await this.ensureManagedRunning();
    return this.status({ forceRefresh: true });
  }

  async stopManaged(): Promise<SubscriptionBridgeStatusDto> {
    await this.managedHost.stop();
    return this.status({ forceRefresh: true });
  }

  async status(opts?: { forceRefresh?: boolean }): Promise<SubscriptionBridgeStatusDto> {
    const enabled = this.isEnabled();
    const mode = this.mode();
    const baseUrl = this.baseUrl();
    const hasApiKey = Boolean(this.apiKey());
    const managed = {
      running: this.managedHost.isRunning(),
      pid: this.managedHost.pid(),
      configPath: mode === 'managed' ? (this.managedHost.activeConfigPath() ?? this.managedConfigPath()) : null,
      port: mode === 'managed' ? this.managedPort() : null,
    };
    const loginHints = this.buildLoginHints(mode);

    if (!enabled) {
      return {
        enabled: false,
        online: false,
        mode,
        baseUrl,
        hasApiKey,
        accounts: { claude: false, codex: false },
        modelCount: 0,
        error: null,
        managed,
        loginHints,
      };
    }

    if (!hasApiKey) {
      return {
        enabled: true,
        online: false,
        mode,
        baseUrl,
        hasApiKey: false,
        accounts: { claude: false, codex: false },
        modelCount: 0,
        error: 'API key not configured',
        managed,
        loginHints,
      };
    }

    try {
      const models = await this.fetchCatalog(opts?.forceRefresh === true);
      const accounts = {
        claude: models.some((m) => m.source === 'claude-sub'),
        codex: models.some((m) => m.source === 'codex-sub'),
      };
      return {
        enabled: true,
        online: true,
        mode,
        baseUrl,
        hasApiKey: true,
        accounts,
        modelCount: models.length,
        error: null,
        managed,
        loginHints,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        enabled: true,
        online: false,
        mode,
        baseUrl,
        hasApiKey: true,
        accounts: { claude: false, codex: false },
        modelCount: 0,
        error: message,
        managed,
        loginHints,
      };
    }
  }

  async listCodexModelsForClaude(): Promise<SubscriptionBridgeModel[]> {
    if (!this.isEnabled() || !this.apiKey()) return [];
    try {
      const models = await this.fetchCatalog(false);
      return codexModelsForClaudePicker(models);
    } catch {
      return [];
    }
  }

  /** Merge Codex-sub models into a Claude ModelProviderDto catalog (idempotent). */
  async mergeIntoClaudeCatalog(catalog: ModelProviderDto[]): Promise<ModelProviderDto[]> {
    const bridgeModels = await this.listCodexModelsForClaude();
    if (bridgeModels.length === 0) return catalog;

    const items: ModelItemDto[] = bridgeModels.map((model) => ({
      id: `claude:${model.id}`,
      name: model.displayName,
      sub: 'via Subscription bridge',
      badge: 'Codex sub',
    }));

    return catalog.map((provider) => {
      if (provider.id !== 'claude') return provider;
      const groups = [...(provider.groups ?? [])];
      const existingIdx = groups.findIndex((g) => g.id === 'codex-sub');
      const group = {
        id: 'codex-sub',
        name: 'Codex subscription',
        sub: 'Routed through Subscription bridge',
        badge: 'Codex sub',
        models: items,
      };
      if (existingIdx >= 0) {
        groups[existingIdx] = group;
      } else {
        groups.push(group);
      }
      return { ...provider, groups };
    });
  }

  async claudeCodeEnv(): Promise<SubscriptionBridgeClaudeCodeEnvDto> {
    const status = await this.status({ forceRefresh: true });
    const key = this.apiKey() ?? '';
    const baseUrl = this.baseUrl();
    const env = {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: key,
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
    };
    const exports = [
      `export ANTHROPIC_BASE_URL=${shellQuote(baseUrl)}`,
      `export ANTHROPIC_AUTH_TOKEN=${shellQuote(key)}`,
      `export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`,
    ].join('\n');

    return {
      enabled: status.enabled,
      online: status.online,
      exports,
      env,
    };
  }

  bustCache(): void {
    this.catalogCache = null;
  }

  private buildLoginHints(mode: SubscriptionBridgeMode): { claude: string; codex: string } {
    const bin = this.binaryPath() || 'cli-proxy-api';
    const config =
      mode === 'managed' && existsSync(this.managedConfigPath())
        ? this.managedConfigPath()
        : '<config.yaml>';
    return {
      claude: `${bin} --config ${config} --claude-login`,
      codex: `${bin} --config ${config} --codex-login`,
    };
  }

  private resolveBinaryOrThrow(): string {
    const configured = this.binaryPath();
    if (configured && existsSync(configured)) return configured;
    const found = discoverCliproxyInstalls().find((d) => d.binaryPath)?.binaryPath;
    if (found) return found;
    throw new BadRequestException(
      'CLIProxyAPI binary not found. Set NUNCIO_CLIPROXY_BIN to your cli-proxy-api path.',
    );
  }

  private async ensureManagedRunning(): Promise<void> {
    const bin = this.resolveBinaryOrThrow();
    const configPath = this.managedConfigPath();
    if (!existsSync(configPath)) {
      throw new BadRequestException(
        'Managed CLIProxyAPI config missing. Use Initialize managed or Migrate from existing.',
      );
    }
    await this.managedHost.start(bin, configPath);
  }

  private enqueueReconcile(): void {
    this.reconcileChain = this.reconcileChain
      .then(() => this.reconcileManagedProcess())
      .catch(() => undefined);
  }

  private async reconcileManagedProcess(): Promise<void> {
    if (this.mode() !== 'managed' || !this.isEnabled()) {
      if (this.managedHost.isRunning()) await this.managedHost.stop();
      return;
    }
    if (!existsSync(this.managedConfigPath())) return;
    try {
      await this.ensureManagedRunning();
    } catch {
      // Binary may be missing until the user sets NUNCIO_CLIPROXY_BIN.
    }
  }

  private async fetchCatalog(forceRefresh: boolean): Promise<SubscriptionBridgeModel[]> {
    const now = Date.now();
    if (!forceRefresh && this.catalogCache && now - this.catalogCache.at < this.catalogTtlMs) {
      return this.catalogCache.models;
    }

    const key = this.apiKey();
    if (!key) throw new Error('API key not configured');

    const url = `${this.baseUrl()}/v1/models`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${key}`,
          'x-api-key': key,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`CLIProxyAPI returned HTTP ${response.status}`);
      }
      const body = (await response.json()) as unknown;
      const models = parseBridgeModelsResponse(body);
      this.catalogCache = { at: now, models };
      return models;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`CLIProxyAPI timed out after ${HEALTH_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
