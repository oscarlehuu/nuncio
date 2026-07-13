import { BadRequestException, Injectable } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import {
  fetchNpmLatestVersion,
  resolveRealCommandPath,
  runCommand,
  VERSION_TIMEOUT_MS,
  type ProviderUpdateCommandRunner,
} from './provider-update-command-runtime';
import {
  buildUpdateTarget,
  compareVersions,
  parseCliVersion,
  settingEnabled,
  type ProviderToolUpdateDefinition,
  type UpdateAction,
} from './provider-update-helpers';
import type {
  ProviderToolId,
  ProviderUpdateRunResultDto,
  ProviderUpdateStatusDto,
  ProviderUpdatesDto,
} from './provider-updates.types';

interface ProviderToolDefinition extends ProviderToolUpdateDefinition {
  provider: ProviderToolId;
  name: string;
  packageName: string;
  binarySetting: string;
  defaultBinary: string;
}

const UPDATE_TIMEOUT_MS = 5 * 60_000;

const PROVIDER_TOOLS: ProviderToolDefinition[] = [
  {
    provider: 'pi',
    name: 'Nuncio Engine',
    packageName: '@earendil-works/pi-coding-agent',
    binarySetting: 'NUNCIO_PI_BIN',
    defaultBinary: 'pi',
    nativeUpdateArgs: ['update'],
  },
  {
    provider: 'codex',
    name: 'Codex',
    packageName: '@openai/codex',
    binarySetting: 'NUNCIO_CODEX_BIN',
    defaultBinary: 'codex',
    nativeUpdateArgs: ['update'],
    standalonePathMarkers: ['/.codex/packages/standalone/'],
    homebrewName: 'codex',
    homebrewKind: 'cask',
  },
];

@Injectable()
export class ProviderUpdatesService {
  commandRunner: ProviderUpdateCommandRunner = runCommand;

  latestVersionResolver: (packageName: string) => Promise<string | null> =
    fetchNpmLatestVersion;

  realCommandPathResolver: (binaryPath: string) => string | null = resolveRealCommandPath;

  constructor(private readonly settings: SettingsService) {}

  async list(): Promise<ProviderUpdatesDto> {
    if (!this.updateChecksEnabled()) {
      return { enabled: false, notificationsEnabled: false, providers: [] };
    }
    const mutedProviders = this.mutedProviders();
    const providers = await Promise.all(
      PROVIDER_TOOLS.map((definition) => this.check(definition, mutedProviders)),
    );
    return {
      enabled: true,
      notificationsEnabled: this.updateNotificationsEnabled(),
      providers,
    };
  }

  async update(provider: ProviderToolId): Promise<ProviderUpdateRunResultDto> {
    if (!this.updateChecksEnabled()) {
      throw new BadRequestException('Provider update checks are disabled.');
    }
    const definition = this.getDefinition(provider);
    const before = await this.check(definition);
    const action = this.updateActionFor(definition);
    if (!before.canUpdate || !action) {
      throw new BadRequestException(`${definition.name} does not support one-click updates.`);
    }

    const result = await this.commandRunner(action.executable, action.args, {
      env: this.envFor(definition),
      timeoutMs: UPDATE_TIMEOUT_MS,
    });
    const output = [result.stderr, result.stdout].filter(Boolean).join('\n\n').trim() || null;
    if (result.timedOut || result.status !== 0) {
      return {
        provider,
        status: 'failed',
        message: result.timedOut
          ? `${definition.name} update timed out.`
          : `${definition.name} update exited with code ${result.status ?? 'unknown'}.`,
        output,
        providerStatus: before,
      };
    }

    const after = await this.check(definition);
    const stillBehind = after.status === 'behind_latest';
    return {
      provider,
      status: stillBehind ? 'unchanged' : 'succeeded',
      message: stillBehind
        ? `${definition.name} update completed, but a newer version still appears available.`
        : `${definition.name} updated.`,
      output,
      providerStatus: after,
    };
  }

  private async check(
    definition: ProviderToolDefinition,
    mutedProviders = this.mutedProviders(),
  ): Promise<ProviderUpdateStatusDto> {
    const checkedAt = new Date().toISOString();
    const binaryPath = this.binaryPathFor(definition);
    const versionResult = await this.commandRunner(binaryPath, ['--version'], {
      env: this.envFor(definition),
      timeoutMs: VERSION_TIMEOUT_MS,
    }).catch((error: unknown) => ({
      status: null,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    }));
    const currentVersion =
      versionResult.status === 0
        ? parseCliVersion(`${versionResult.stdout}\n${versionResult.stderr}`)
        : null;
    const latestVersion = currentVersion
      ? await this.latestVersionResolver(definition.packageName)
      : null;
    const updateTarget = this.updateTargetFor(definition);
    const status = deriveStatus(currentVersion, latestVersion);

    return {
      provider: definition.provider,
      name: definition.name,
      currentVersion,
      latestVersion,
      status,
      canUpdate: status === 'behind_latest' && updateTarget.canUpdate,
      updateCommand: status === 'behind_latest' ? updateTarget.updateCommand : null,
      message: messageForStatus(definition.name, status, versionResult),
      checkedAt,
      muted: mutedProviders.has(definition.provider),
    };
  }

  private updateChecksEnabled(): boolean {
    return settingEnabled(this.settings.resolve('NUNCIO_PROVIDER_UPDATE_CHECKS'));
  }

  private updateNotificationsEnabled(): boolean {
    return settingEnabled(this.settings.resolve('NUNCIO_CLI_UPDATE_NOTIFICATIONS'));
  }

  private mutedProviders(): Set<ProviderToolId> {
    const raw = this.settings.resolve('NUNCIO_CLI_UPDATE_MUTED') ?? '';
    return new Set(
      raw
        .split(',')
        .map((part) => part.trim().toLowerCase())
        .filter((part): part is ProviderToolId => part === 'pi' || part === 'codex'),
    );
  }

  private getDefinition(provider: ProviderToolId): ProviderToolDefinition {
    const definition = PROVIDER_TOOLS.find((candidate) => candidate.provider === provider);
    if (!definition) throw new BadRequestException(`Unknown provider tool: ${provider}`);
    return definition;
  }

  private binaryPathFor(definition: ProviderToolDefinition): string {
    return this.settings.resolve(definition.binarySetting)?.trim() || definition.defaultBinary;
  }

  private envFor(definition: ProviderToolDefinition): NodeJS.ProcessEnv {
    const env = { ...process.env };
    if (definition.provider === 'codex') {
      const codexHome = this.settings.resolve('NUNCIO_CODEX_HOME')?.trim();
      if (codexHome) env.CODEX_HOME = codexHome;
    }
    return env;
  }

  private updateTargetFor(definition: ProviderToolDefinition) {
    const binaryPath = this.binaryPathFor(definition);
    return buildUpdateTarget(
      definition,
      binaryPath,
      this.realCommandPathResolver(binaryPath),
    );
  }

  private updateActionFor(definition: ProviderToolDefinition): UpdateAction | undefined {
    return this.updateTargetFor(definition).action;
  }
}

function deriveStatus(
  currentVersion: string | null,
  latestVersion: string | null,
): ProviderUpdateStatusDto['status'] {
  if (!currentVersion || !latestVersion) return 'unknown';
  return compareVersions(currentVersion, latestVersion) < 0 ? 'behind_latest' : 'current';
}

function messageForStatus(
  name: string,
  status: ProviderUpdateStatusDto['status'],
  result: Awaited<ReturnType<ProviderUpdateCommandRunner>>,
): string | null {
  if (status === 'behind_latest') return `${name} has a newer CLI version available.`;
  if (status === 'current') return null;
  if (result.timedOut) return `${name} version check timed out.`;
  if (result.status !== 0) return `${name} version check failed.`;
  return `Could not parse the installed ${name} CLI version.`;
}
