import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AgentProvider } from './agents.types';
import { CodexAgentProvider } from './providers/codex-agent.provider';
import { ClaudeAgentProvider } from './providers/claude-agent.provider';
import { DevinAgentProvider } from './providers/devin-agent.provider';
import { CursorAgentProvider } from './providers/cursor-agent.provider';
import { CursorCliProvider } from './providers/cursor-cli.provider';
import { PiAgentProvider } from './providers/pi-agent.provider';
import { MOCK_AGENT_PROVIDER } from './mock-agent.token';
import { SettingsService } from '../settings/settings.service';
import type { SessionDto } from '../sessions/domain/sessions.types';

/**
 * Vendor engines Nuncio no longer invests in. Hidden from every engine and model
 * picker unless the operator opts back in via the `engines.showLegacy` setting;
 * still fully resolvable by id (see `get`) so their existing sessions keep opening
 * and streaming. `cursor-cli` is the handoff runtime and is never listed anyway.
 */
const LEGACY_ENGINE_IDS = new Set(['cursor', 'cursor-cli', 'codex', 'claude', 'devin']);

@Injectable()
export class AgentRegistry {
  private readonly providers: AgentProvider[];
  private readonly cliProvider: CursorCliProvider;
  private legacyVisibleCache: boolean | undefined;

  constructor(
    private readonly pi: PiAgentProvider,
    private readonly cursor: CursorAgentProvider,
    private readonly codex: CodexAgentProvider,
    private readonly claude: ClaudeAgentProvider,
    cli: CursorCliProvider,
    private readonly settings: SettingsService,
    @Optional() private readonly devin?: DevinAgentProvider,
    // Bound only when `NUNCIO_FORCE_MOCK=1` opts the zero-credential engine in
    // (see AgentsModule). Resolves to undefined — and is thus never selectable —
    // on a normal boot.
    @Optional() @Inject(MOCK_AGENT_PROVIDER) mock?: AgentProvider,
  ) {
    this.cliProvider = cli;
    this.providers = [this.pi, this.cursor, this.codex, this.claude];
    if (this.devin) this.providers.push(this.devin);
    if (mock) this.providers.push(mock);
    settings.onChange(() => {
      this.legacyVisibleCache = undefined;
      this.bustCaches();
    });
  }

  /** Every registered provider. Runtime paths (shutdown durability flushes,
   * title/commit-message helpers, routing) must see hidden engines too, so
   * this is never filtered by visibility. */
  all(): AgentProvider[] {
    return this.providers;
  }

  async available(): Promise<AgentProvider[]> {
    const flags = await Promise.all(this.providers.map((provider) => provider.isAvailable()));
    return this.providers.filter((_, index) => flags[index]);
  }

  /** Providers shown in engine/model pickers — legacy engines are dropped
   * unless the operator opts back in. Visibility only: hidden engines stay
   * fully operational for existing sessions and runtime helpers. */
  listed(): AgentProvider[] {
    if (this.legacyEnginesVisible()) return this.providers;
    return this.providers.filter((provider) => !LEGACY_ENGINE_IDS.has(provider.id));
  }

  async listedAvailable(): Promise<AgentProvider[]> {
    const shown = this.listed();
    const flags = await Promise.all(shown.map((provider) => provider.isAvailable()));
    return shown.filter((_, index) => flags[index]);
  }

  get(id: string): AgentProvider {
    if (id === this.cliProvider.id) return this.cliProvider;
    const provider = this.providers.find((item) => item.id === id);
    if (!provider) {
      throw new BadRequestException(`Unknown agent provider ${id}`);
    }
    return provider;
  }

  async getAvailable(id: string): Promise<AgentProvider> {
    const provider = this.get(id);
    if (!(await provider.isAvailable())) {
      throw new BadRequestException(`Agent provider ${id} is not available`);
    }
    return provider;
  }

  /** Route handoff (cli) vs normal (sdk) sessions to the correct runtime. */
  resolveForSession(session: SessionDto): AgentProvider {
    if (session.cursorBackend === 'cli') return this.cliProvider;
    return this.get(session.provider);
  }

  async resolveAvailableForSession(session: SessionDto): Promise<AgentProvider> {
    const provider = this.resolveForSession(session);
    if (!(await provider.isAvailable())) {
      throw new BadRequestException(`Agent provider ${provider.id} is not available`);
    }
    return provider;
  }

  cli(): CursorCliProvider {
    return this.cliProvider;
  }

  /**
   * The default provider for a session/task created without an explicit engine
   * (Workbench "no picker" default AND unattended loop runs). Resolves to an
   * AVAILABLE provider through the registry — never a hardcoded fallthrough to an
   * unavailable engine. The forced Mock (`NUNCIO_FORCE_MOCK=1`) wins when present:
   * it is the deliberate offline/smoke engine, so an operator who opts in expects
   * it to be the default. Otherwise: cursor → codex → pi by preference, then any
   * other available provider.
   */
  async defaultId(): Promise<string> {
    const available = await this.available();
    const mock = available.find((p) => p.id === 'mock');
    if (mock) return mock.id;
    const preferred = [this.cursor.id, this.codex.id, this.pi.id];
    for (const id of preferred) {
      if (available.some((p) => p.id === id)) return id;
    }
    if (available.length > 0) return available[0]!.id;
    throw new ServiceUnavailableException('No agent provider is configured');
  }

  bustCaches(): void {
    for (const provider of this.providers) provider.bustCache();
  }

  /**
   * Whether the legacy vendor engines are shown in listings. Read from settings
   * and cached so `all()` stays synchronous; the cache is cleared on every
   * settings change (see the constructor) so a toggle takes effect at once.
   */
  private legacyEnginesVisible(): boolean {
    if (this.legacyVisibleCache === undefined) {
      this.legacyVisibleCache = this.settings.resolve('engines.showLegacy') === '1';
    }
    return this.legacyVisibleCache;
  }

  supportsInteraction(providerId: string): boolean {
    const provider = this.get(providerId);
    return provider.supportsInteraction?.() ?? false;
  }

  supportsInteractionForSession(session: SessionDto): boolean {
    const provider = this.resolveForSession(session);
    return provider.supportsInteraction?.() ?? false;
  }
}
