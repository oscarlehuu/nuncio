import { Injectable, OnModuleInit } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import type { ModelItemDto, ModelProviderDto } from '../models/models.types';
import {
  codexModelsForClaudePicker,
  isCodexBridgeModelId,
  parseBridgeModelsResponse,
} from './subscription-bridge.catalog';
import type {
  SubscriptionBridgeClaudeCodeEnvDto,
  SubscriptionBridgeModel,
  SubscriptionBridgeStatusDto,
} from './subscription-bridge.types';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8317';
const HEALTH_TIMEOUT_MS = 3_000;

const BRIDGE_SETTING_KEYS = new Set([
  'NUNCIO_CLIPROXY_ENABLED',
  'NUNCIO_CLIPROXY_BASE_URL',
  'NUNCIO_CLIPROXY_API_KEY',
  'NUNCIO_CLIPROXY_BIN',
]);

@Injectable()
export class SubscriptionBridgeService implements OnModuleInit {
  /** Overridable for unit tests. */
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);

  private catalogCache: { at: number; models: SubscriptionBridgeModel[] } | null = null;
  private readonly catalogTtlMs = 15_000;

  constructor(private readonly settings: SettingsService) {}

  onModuleInit(): void {
    this.settings.onChange((key) => {
      if (BRIDGE_SETTING_KEYS.has(key)) this.bustCache();
    });
  }

  isEnabled(): boolean {
    return this.settings.resolve('NUNCIO_CLIPROXY_ENABLED') === '1';
  }

  baseUrl(): string {
    const raw = this.settings.resolve('NUNCIO_CLIPROXY_BASE_URL')?.trim();
    return (raw || DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  apiKey(): string | undefined {
    return this.settings.resolve('NUNCIO_CLIPROXY_API_KEY')?.trim() || undefined;
  }

  binaryPath(): string | undefined {
    return this.settings.resolve('NUNCIO_CLIPROXY_BIN')?.trim() || undefined;
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
        'Subscription bridge is required for this model but is disabled. Enable it in Settings → Providers → Subscription bridge.',
      );
    }

    const key = this.apiKey();
    if (!key) {
      throw new Error(
        'Subscription bridge API key is missing. Set NUNCIO_CLIPROXY_API_KEY in Settings → Providers → Subscription bridge.',
      );
    }

    const status = await this.status({ forceRefresh: true });
    if (!status.online) {
      throw new Error(
        status.error
          ? `Subscription bridge offline — ${status.error}`
          : 'Subscription bridge offline — start CLIProxy or reconnect Codex.',
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

  async status(opts?: { forceRefresh?: boolean }): Promise<SubscriptionBridgeStatusDto> {
    const enabled = this.isEnabled();
    const baseUrl = this.baseUrl();
    const hasApiKey = Boolean(this.apiKey());
    const bin = this.binaryPath();
    const loginBinary = bin || 'cli-proxy-api';
    const loginHints = {
      claude: `${loginBinary} --config <config.yaml> --claude-login`,
      codex: `${loginBinary} --config <config.yaml> --codex-login`,
    };

    if (!enabled) {
      return {
        enabled: false,
        online: false,
        baseUrl,
        hasApiKey,
        accounts: { claude: false, codex: false },
        modelCount: 0,
        error: null,
        loginHints,
      };
    }

    if (!hasApiKey) {
      return {
        enabled: true,
        online: false,
        baseUrl,
        hasApiKey: false,
        accounts: { claude: false, codex: false },
        modelCount: 0,
        error: 'API key not configured',
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
        baseUrl,
        hasApiKey: true,
        accounts,
        modelCount: models.length,
        error: null,
        loginHints,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        enabled: true,
        online: false,
        baseUrl,
        hasApiKey: true,
        accounts: { claude: false, codex: false },
        modelCount: 0,
        error: message,
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
        throw new Error(`CLIProxy returned HTTP ${response.status}`);
      }
      const body = (await response.json()) as unknown;
      const models = parseBridgeModelsResponse(body);
      this.catalogCache = { at: now, models };
      return models;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`CLIProxy timed out after ${HEALTH_TIMEOUT_MS}ms`);
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
