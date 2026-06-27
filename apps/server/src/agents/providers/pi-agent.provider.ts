import { Injectable } from '@nestjs/common';
import { join } from 'node:path';
import type { ModelGroupDto, ModelItemDto, ModelProviderDto } from '../../models/models.types';
import { STATIC_MODEL_PROVIDERS } from '../../models/models.static';
import { EventsRepository } from '../../sessions/persistence/events.repository';
import { SessionsRepository } from '../../sessions/persistence/sessions.repository';
import type { AgentRunContext } from '../agents.types';
import { BaseAgentProvider } from '../agents.base-provider';

type PiSdk = typeof import('@earendil-works/pi-coding-agent');

type PiSessionHandle = {
  prompt: (text: string, options?: { streamingBehavior?: 'steer' | 'followUp' }) => Promise<void>;
  unsubscribe: () => void;
  resetAssistantText: () => void;
  getAssistantText: () => string;
};

type PiModelRegistry = {
  getAvailable: () => Array<{
    provider: string;
    id: string;
    name: string;
    cost?: { input: number; output: number };
  }>;
  getProviderDisplayName: (provider: string) => string;
};

@Injectable()
export class PiAgentProvider extends BaseAgentProvider {
  readonly id = 'pi';
  readonly name = 'Pi';
  private readonly activeSessions = new Map<string, PiSessionHandle>();
  private piSdkPromise?: Promise<PiSdk>;
  private cachedAvailable?: boolean;

  constructor(sessions: SessionsRepository, events: EventsRepository) {
    super(sessions, events);
  }

  async isAvailable(): Promise<boolean> {
    if (process.env.NUNCIO_FORCE_MOCK === '1') return false;
    if (this.cachedAvailable !== undefined) return this.cachedAvailable;
    try {
      const pi = await this.loadSdk();
      const agentDir = pi.getAgentDir();
      const authStorage = pi.AuthStorage.create(join(agentDir, 'auth.json'));
      const registry = pi.ModelRegistry.create(authStorage, join(agentDir, 'models.json'));
      this.cachedAvailable = registry.getAvailable().length > 0;
    } catch {
      this.cachedAvailable = false;
    }
    return this.cachedAvailable;
  }

  async listModels(): Promise<ModelProviderDto[]> {
    try {
      const pi = await this.loadSdk();
      const agentDir = pi.getAgentDir();
      const authStorage = pi.AuthStorage.create(join(agentDir, 'auth.json'));
      const modelRegistry = pi.ModelRegistry.create(authStorage, join(agentDir, 'models.json'));
      return this.fromRegistry(modelRegistry);
    } catch {
      return STATIC_MODEL_PROVIDERS;
    }
  }

  dispose(sessionId: string): void {
    const handle = this.activeSessions.get(sessionId);
    if (!handle) return;
    handle.unsubscribe();
    this.activeSessions.delete(sessionId);
  }

  protected async executePrompt(
    sessionId: string,
    text: string,
    isSteer: boolean,
    context: AgentRunContext,
  ): Promise<void> {
    let handle = this.activeSessions.get(sessionId);
    if (!handle) {
      handle = await this.createPiSession(sessionId, context);
      this.activeSessions.set(sessionId, handle);
    }

    handle.resetAssistantText();
    await handle.prompt(text, isSteer ? { streamingBehavior: 'steer' } : undefined);
    this.pushEvent(
      sessionId,
      'assistant_message',
      { text: handle.getAssistantText() || '(no response)' },
      context.emit,
    );
  }

  private loadSdk(): Promise<PiSdk> {
    this.piSdkPromise ??= import('@earendil-works/pi-coding-agent');
    return this.piSdkPromise;
  }

  private async createPiSession(
    sessionId: string,
    context: AgentRunContext,
  ): Promise<PiSessionHandle> {
    const pi = await this.loadSdk();
    const agentDir = pi.getAgentDir();
    const authStorage = pi.AuthStorage.create(join(agentDir, 'auth.json'));
    const modelRegistry = pi.ModelRegistry.create(authStorage, join(agentDir, 'models.json'));
    const model = resolveModelId(context.model, (provider, id) => modelRegistry.find(provider, id));
    const cwdOptions = context.cwd
      ? { cwd: context.cwd, sessionManager: pi.SessionManager.inMemory(context.cwd) }
      : { sessionManager: pi.SessionManager.inMemory() };
    // When a worktree cwd is set, rebind EVERY built-in tool to that cwd via
    // customTools. This wins over same-named tools registered by local extensions
    // (e.g. claude-studio binds bash/read/edit/write to process.cwd() at load time,
    // which would make the agent operate in the server's cwd instead of the worktree).
    // SDK customTools take precedence over extension `pi.registerTool` overrides.
    // We cover ALL built-in tools (not just the active allowlist) so the `tools`
    // allowlist below can evolve without risking drift — an inactive customTool is
    // filtered out by the allowlist, but a cwd-correct instance is always ready if a
    // tool is later enabled. This makes Nuncio immune to any extension that overrides
    // built-in tools with a wrong cwd, present or future.
    const customTools = context.cwd
      ? [
          pi.createReadTool(context.cwd),
          pi.createBashTool(context.cwd),
          pi.createEditTool(context.cwd),
          pi.createWriteTool(context.cwd),
          pi.createGrepTool(context.cwd),
          pi.createFindTool(context.cwd),
          pi.createLsTool(context.cwd),
        ]
      : undefined;
    const { session } = await pi.createAgentSession({
      agentDir,
      ...cwdOptions,
      authStorage,
      modelRegistry,
      tools: ['read', 'bash', 'grep', 'find', 'ls'],
      ...(customTools ? { customTools } : {}),
      ...(model ? { model } : {}),
    });

    let assistantText = '';
    const unsubscribe = session.subscribe((event: { type: string; [key: string]: unknown }) => {
      if (event.type === 'message_update') {
        const inner = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (inner?.type === 'text_delta' && inner.delta) {
          assistantText += inner.delta;
          this.pushEvent(sessionId, 'assistant_delta', { delta: inner.delta }, context.emit);
          this.sessions.touchPreview(sessionId, assistantText);
        }
      }
      if (event.type === 'tool_execution_start') {
        this.pushEvent(sessionId, 'tool_start', { tool: event.toolName }, context.emit);
      }
      if (event.type === 'tool_execution_end') {
        this.pushEvent(
          sessionId,
          'tool_end',
          { tool: event.toolName, isError: event.isError },
          context.emit,
        );
      }
    });

    return {
      prompt: (prompt, options) => session.prompt(prompt, options),
      unsubscribe,
      resetAssistantText: () => {
        assistantText = '';
      },
      getAssistantText: () => assistantText,
    };
  }

  private fromRegistry(modelRegistry: PiModelRegistry): ModelProviderDto[] {
    const models = modelRegistry.getAvailable();
    if (models.length === 0) return STATIC_MODEL_PROVIDERS;

    const groupsByProvider = new Map<string, ModelItemDto[]>();
    for (const model of models) {
      const item: ModelItemDto = {
        id: `${model.provider}:${model.id}`,
        name: model.name,
        sub: model.id,
      };
      if (model.cost) item.cost = `$${model.cost.input} / $${model.cost.output}`;
      groupsByProvider.set(model.provider, [...(groupsByProvider.get(model.provider) ?? []), item]);
    }

    const groups: ModelGroupDto[] = [];
    for (const [providerId, groupModels] of groupsByProvider) {
      groups.push({
        id: providerId,
        name: modelRegistry.getProviderDisplayName(providerId),
        sub: 'Pi ModelRegistry',
        models: groupModels,
      });
    }

    return [
      {
        id: this.id,
        name: this.name,
        sub: 'Local harness · ~/.pi/agent',
        icon: 'π',
        groups,
      },
    ];
  }
}

/**
 * Parse a stored model id and resolve it via the registry.
 * Accepts both `provider/modelId` (Pi SDK / synara convention) and
 * `provider:modelId` (nuncio frontend convention). Returns undefined for ids
 * without a provider separator (e.g. static fallback ids) so the caller falls
 * back to the SDK default model.
 */
export function resolveModelId<T>(
  modelId: string | null | undefined,
  find: (provider: string, id: string) => T | undefined,
): T | undefined {
  const trimmed = typeof modelId === 'string' ? modelId.trim() : '';
  if (!trimmed) return undefined;
  const sep = trimmed.includes('/') ? '/' : ':';
  const idx = trimmed.indexOf(sep);
  if (idx <= 0) return undefined;
  const provider = trimmed.slice(0, idx);
  const id = trimmed.slice(idx + 1);
  if (!provider || !id) return undefined;
  return find(provider, id);
}
