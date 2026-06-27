import { Injectable } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelProviderDto } from '../../models/models.types';
import { EventsRepository } from '../../sessions/persistence/events.repository';
import { SessionsRepository } from '../../sessions/persistence/sessions.repository';
import { SettingsService } from '../../settings/settings.service';
import type { AgentRunContext } from '../agents.types';
import { BaseAgentProvider } from '../agents.base-provider';
import {
  CURSOR_PREFERRED_MODEL,
  isCursorDefaultModelId,
  parseCursorModel,
  STATIC_FALLBACK_CURSOR_MODELS,
  type CursorInteractionUpdate,
  type CursorSdk,
  type CursorSessionHandle,
} from './cursor-agent.helpers';

@Injectable()
export class CursorAgentProvider extends BaseAgentProvider {
  readonly id = 'cursor';
  readonly name = 'Cursor';

  private readonly activeSessions = new Map<string, CursorSessionHandle>();
  private sdkPromise?: Promise<CursorSdk>;
  private cachedAvailable?: boolean;
  private cachedModels?: ModelProviderDto[];
  private store?: unknown;

  /** Test hook: inject a stub SDK instead of loading @cursor/sdk. */
  sdkOverride?: CursorSdk;

  constructor(sessions: SessionsRepository, events: EventsRepository, private readonly settings: SettingsService) {
    super(sessions, events);
  }

  async isAvailable(): Promise<boolean> {
    if (this.settings.resolve('NUNCIO_FORCE_MOCK') === '1') return false;
    if (this.cachedAvailable !== undefined) return this.cachedAvailable;
    const key = this.settings.resolve('CURSOR_API_KEY')?.trim();
    this.cachedAvailable = !!key;
    return this.cachedAvailable;
  }

  /** Drop cached availability + models so the next call re-resolves from current settings. */
  bustCache(): void {
    this.cachedAvailable = undefined;
    this.cachedModels = undefined;
  }

  async listModels(): Promise<ModelProviderDto[]> {
    if (this.cachedModels) return this.cachedModels;
    try {
      const sdk = await this.loadSdk();
      const apiKey = this.settings.resolve('CURSOR_API_KEY')!;
      const models = await sdk.Cursor.models.list({ apiKey });
      const dto: ModelProviderDto[] = [
        {
          id: this.id,
          name: this.name,
          sub: 'Local SDK · @cursor/sdk',
          icon: '◆',
          groups: [
            {
              id: 'cursor',
              name: 'Cursor',
              sub: 'Local runtime',
              models: models
                .filter((m) => !isCursorDefaultModelId(m.id))
                .map((m) => ({
                  id: `cursor:${m.id}`,
                  name: m.id,
                  sub: 'Cursor model',
                })),
            },
          ],
        },
      ];
      this.cachedModels = dto;
      return dto;
    } catch {
      return STATIC_FALLBACK_CURSOR_MODELS;
    }
  }

  dispose(sessionId: string): void {
    const handle = this.activeSessions.get(sessionId);
    if (!handle) return;
    this.activeSessions.delete(sessionId);
    try {
      handle.agent.close?.();
    } catch {
      // sync fire-and-forget per Cursor SDK docs
    }
  }

  protected resolveCwd(_sessionId: string, context: AgentRunContext): string {
    return context.workspace ?? this.settings.resolve('NUNCIO_CURSOR_CWD') ?? process.cwd();
  }

  protected async executePrompt(
    sessionId: string,
    text: string,
    _isSteer: boolean,
    context: AgentRunContext,
  ): Promise<void> {
    let handle = this.activeSessions.get(sessionId);
    if (!handle) {
      const sdk = await this.loadSdk();
      const apiKey = this.settings.resolve('CURSOR_API_KEY')!;
      const modelId = parseCursorModel(context.model) ?? CURSOR_PREFERRED_MODEL;
      const agent = await sdk.Agent.create({
        apiKey,
        model: { id: modelId },
        local: {
          cwd: this.resolveCwd(sessionId, context),
          useHttp1ForAgent: true,
          store: this.resolveStore(sdk),
        },
      });
      handle = { agent, accumulatedText: '' };
      this.activeSessions.set(sessionId, handle);
    }

    const active = handle;
    active.accumulatedText = '';

    // onDelta gives token-by-token text + tool-call state (finer-grained than
    // run.stream()'s block-level `assistant` events). run.wait() drains the run
    // and returns the terminal result.
    const run = await active.agent.send(text, {
      onDelta: ({ update }) => this.handleDelta(sessionId, active, update, context),
    });
    const result = await run.wait();
    switch (result.status) {
      case 'finished':
        this.pushEvent(
          sessionId,
          'assistant_message',
          { text: result.result ?? active.accumulatedText ?? '(no response)' },
          context.emit,
        );
        return;
      case 'error':
        throw new Error(`Cursor run ${result.id} failed`);
      case 'cancelled':
        throw new Error(`Cursor run ${result.id} cancelled`);
      default: {
        const _exhaustive: never = result.status;
        throw new Error(`unexpected Cursor run status: ${_exhaustive}`);
      }
    }
  }

  private handleDelta(
    sessionId: string,
    active: CursorSessionHandle,
    update: CursorInteractionUpdate,
    context: AgentRunContext,
  ): void {
    switch (update.type) {
      case 'text-delta':
        if (update.text) {
          active.accumulatedText += update.text;
          this.pushEvent(sessionId, 'assistant_delta', { delta: update.text }, context.emit);
          this.sessions.touchPreview(sessionId, active.accumulatedText);
        }
        return;
      case 'tool-call-started':
        this.pushEvent(
          sessionId,
          'tool_start',
          { tool: update.toolCall?.type ?? 'unknown' },
          context.emit,
        );
        return;
      case 'tool-call-completed':
        this.pushEvent(
          sessionId,
          'tool_end',
          { tool: update.toolCall?.type ?? 'unknown', isError: false },
          context.emit,
        );
        return;
      default:
        // thinking-delta, token-delta, step-*, summary-*, etc. — not surfaced.
        return;
    }
  }

  private loadSdk(): Promise<CursorSdk> {
    if (this.sdkOverride) return Promise.resolve(this.sdkOverride);
    this.sdkPromise ??= import('@cursor/sdk') as Promise<CursorSdk>;
    return this.sdkPromise;
  }

  private resolveStore(sdk: CursorSdk): unknown {
    if (this.store) return this.store;
    const dir = join(process.env.NUNCIO_DATA_DIR ?? join(process.cwd(), 'data'), 'cursor-store');
    mkdirSync(dir, { recursive: true });
    this.store = new sdk.JsonlLocalAgentStore(dir);
    return this.store;
  }
}
