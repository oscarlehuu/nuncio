import { Injectable } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildCursorModelParams,
  cursorModelItemLabel,
  cursorParametersToDescriptors,
  type CursorModelListItem,
  type CursorModelParameter,
} from './cursor-model-options.helpers';
import { EventsRepository } from '../../sessions/persistence/events.repository';
import { SessionsRepository } from '../../sessions/persistence/sessions.repository';
import { SettingsService } from '../../settings/settings.service';
import type { AgentRunContext } from '../agents.types';
import { BaseAgentProvider } from '../agents.base-provider';
import {
  CURSOR_PREFERRED_MODEL,
  isCursorDefaultModelId,
  isCursorToolCallError,
  parseCursorModel,
  STATIC_FALLBACK_CURSOR_MODELS,
  type CursorInteractionUpdate,
  type CursorSdk,
  type CursorSessionHandle,
} from './cursor-agent.helpers';
import type { ModelProviderDto } from '../../models/models.types';
import { truncatePayload } from '../../sessions/domain/events.types';
import { buildUserInputRequestedPayload } from '../../sessions/domain/interactive-tool-events';
import { isInteractiveTool } from '../tool-interaction.registry';

@Injectable()
export class CursorAgentProvider extends BaseAgentProvider {
  readonly id = 'cursor';
  readonly name = 'Cursor';

  private readonly activeSessions = new Map<string, CursorSessionHandle>();
  private sdkPromise?: Promise<CursorSdk>;
  private cachedAvailable?: boolean;
  private cachedModels?: ModelProviderDto[];
  private readonly cursorModelParameters = new Map<string, CursorModelParameter[]>();
  private store?: unknown;

  /** Test hook: inject a stub SDK instead of loading @cursor/sdk. */
  sdkOverride?: CursorSdk;

  constructor(sessions: SessionsRepository, events: EventsRepository, private readonly settings: SettingsService) {
    super(sessions, events);
  }

  async isAvailable(): Promise<boolean> {
    if (this.cachedAvailable !== undefined) return this.cachedAvailable;
    const key = this.settings.resolve('CURSOR_API_KEY')?.trim();
    this.cachedAvailable = !!key;
    return this.cachedAvailable;
  }

  /** Drop cached availability + models so the next call re-resolves from current settings. */
  bustCache(): void {
    this.cachedAvailable = undefined;
    this.cachedModels = undefined;
    this.cursorModelParameters.clear();
  }

  async listModels(): Promise<ModelProviderDto[]> {
    if (this.cachedModels) return this.cachedModels;
    try {
      const sdk = await this.loadSdk();
      const apiKey = this.settings.resolve('CURSOR_API_KEY')!;
      const models = (await sdk.Cursor.models.list({ apiKey })) as CursorModelListItem[];
      this.cursorModelParameters.clear();
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
                .map((m) => {
                  if (m.parameters?.length) this.cursorModelParameters.set(m.id, m.parameters);
                  const options = cursorParametersToDescriptors(m.parameters);
                  const variants =
                    options.length === 0
                      ? m.variants?.map((v) => ({
                          label: v.displayName,
                          params: v.params,
                          ...(v.isDefault ? { isDefault: true as const } : {}),
                        }))
                      : undefined;
                  return {
                    id: `cursor:${m.id}`,
                    name: cursorModelItemLabel(m),
                    sub: 'Cursor model',
                    ...(options.length > 0 ? { options } : {}),
                    ...(variants && variants.length > 0 ? { variants } : {}),
                  };
                }),
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
      const params = buildCursorModelParams(
        context.modelOptions,
        this.cursorModelParameters.get(modelId),
      );
      const agent = await sdk.Agent.create({
        apiKey,
        model: params ? { id: modelId, params } : { id: modelId },
        local: {
          cwd: this.resolveCwd(sessionId, context),
          useHttp1ForAgent: true,
          store: this.resolveStore(sdk),
        },
      });
      handle = { agent, accumulatedText: '', accumulatedThinking: '', thinkingOpen: false };
      this.activeSessions.set(sessionId, handle);
    }

    const active = handle;
    active.accumulatedText = '';
    active.accumulatedThinking = '';
    active.thinkingOpen = false;
    active.thinkingId = undefined;

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
      case 'thinking-delta':
        if (update.text) {
          this.ensureThinkingStarted(sessionId, active, context);
          active.accumulatedThinking += update.text;
          this.pushEvent(
            sessionId,
            'thinking_delta',
            { thinkingId: active.thinkingId, delta: update.text },
            context.emit,
          );
        }
        return;
      case 'thinking-completed':
        if (active.thinkingOpen || active.accumulatedThinking) {
          this.pushEvent(
            sessionId,
            'thinking_message',
            { thinkingId: active.thinkingId, text: active.accumulatedThinking },
            context.emit,
          );
          active.accumulatedThinking = '';
          active.thinkingOpen = false;
          active.thinkingId = undefined;
        }
        return;
      case 'tool-call-started': {
        const callId = update.toolCall?.id ?? crypto.randomUUID();
        const tool = update.toolCall?.type ?? 'unknown';
        const input = update.toolCall?.args;
        const userInputPayload = buildUserInputRequestedPayload(tool, input, callId);
        if (userInputPayload) {
          this.pushEvent(sessionId, 'user_input_requested', userInputPayload, context.emit);
          return;
        }
        const truncatedInput = input !== undefined ? truncatePayload(input).value : undefined;
        this.pushEvent(
          sessionId,
          'tool_start',
          { callId, tool, ...(truncatedInput !== undefined ? { input: truncatedInput } : {}) },
          context.emit,
        );
        return;
      }
      case 'tool-call-completed': {
        const callId = update.toolCall?.id;
        const tool = update.toolCall?.type ?? 'unknown';
        if (callId && isInteractiveTool(tool)) {
          this.pushEvent(
            sessionId,
            'user_input_resolved',
            {
              requestId: callId,
              resolvedBy: isCursorToolCallError(update.toolCall) ? 'skip' : 'user',
            },
            context.emit,
          );
          return;
        }
        const result = update.toolCall?.result;
        const truncatedOutput = result !== undefined ? truncatePayload(result).value : undefined;
        this.pushEvent(
          sessionId,
          'tool_end',
          {
            ...(callId ? { callId } : {}),
            tool,
            isError: isCursorToolCallError(update.toolCall),
            ...(truncatedOutput !== undefined ? { output: truncatedOutput } : {}),
          },
          context.emit,
        );
        return;
      }
      default:
        // token-delta, step-*, summary-*, etc. — not surfaced.
        return;
    }
  }

  private ensureThinkingStarted(
    sessionId: string,
    active: CursorSessionHandle,
    context: AgentRunContext,
  ): void {
    if (active.thinkingOpen) return;
    active.thinkingOpen = true;
    active.thinkingId = crypto.randomUUID();
    active.accumulatedThinking = '';
    this.pushEvent(
      sessionId,
      'thinking_start',
      { thinkingId: active.thinkingId },
      context.emit,
    );
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
