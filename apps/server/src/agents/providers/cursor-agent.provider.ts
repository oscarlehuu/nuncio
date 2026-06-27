import { Injectable } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelProviderDto } from '../../models/models.types';
import { EventsRepository } from '../../sessions/persistence/events.repository';
import { SessionsRepository } from '../../sessions/persistence/sessions.repository';
import type { AgentRunContext } from '../agents.types';
import { BaseAgentProvider } from '../agents.base-provider';
import {
  parseCursorModel,
  STATIC_FALLBACK_CURSOR_MODELS,
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

  constructor(sessions: SessionsRepository, events: EventsRepository) {
    super(sessions, events);
  }

  async isAvailable(): Promise<boolean> {
    if (process.env.NUNCIO_FORCE_MOCK === '1') {
      this.cachedAvailable = false;
      return false;
    }
    if (this.cachedAvailable !== undefined) return this.cachedAvailable;
    const key = process.env.CURSOR_API_KEY?.trim();
    this.cachedAvailable = !!key;
    return this.cachedAvailable;
  }

  async listModels(): Promise<ModelProviderDto[]> {
    if (this.cachedModels) return this.cachedModels;
    try {
      const sdk = await this.loadSdk();
      const apiKey = process.env.CURSOR_API_KEY!;
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
              models: models.map((m) => ({
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
    return context.workspace ?? process.env.NUNCIO_CURSOR_CWD ?? process.cwd();
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
      const apiKey = process.env.CURSOR_API_KEY!;
      const modelId = parseCursorModel(context.model) ?? 'composer-2';
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

    const run = await active.agent.send(text);
    for await (const event of run.stream()) {
      switch (event.type) {
        case 'assistant': {
          const message = (event as { message?: { content?: Array<{ type: string; text?: string }> } })
            .message;
          for (const block of message?.content ?? []) {
            if (block.type === 'text' && block.text) {
              active.accumulatedText += block.text;
              this.pushEvent(sessionId, 'assistant_delta', { delta: block.text }, context.emit);
              this.sessions.touchPreview(sessionId, active.accumulatedText);
            }
          }
          break;
        }
        case 'tool_call': {
          const toolEvent = event as { status?: string; name?: string };
          if (toolEvent.status === 'running') {
            this.pushEvent(sessionId, 'tool_start', { tool: toolEvent.name }, context.emit);
          } else {
            this.pushEvent(
              sessionId,
              'tool_end',
              { tool: toolEvent.name, isError: toolEvent.status === 'error' },
              context.emit,
            );
          }
          break;
        }
        case 'thinking':
        case 'status':
        case 'system':
        case 'request':
        case 'user':
        case 'task':
        case 'usage':
          break;
        default: {
          const _exhaustive: never = event.type as never;
          void _exhaustive;
        }
      }
    }

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
