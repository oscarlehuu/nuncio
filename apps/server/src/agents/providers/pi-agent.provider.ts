import { Injectable } from '@nestjs/common';
import { join } from 'node:path';
import type { ModelOptionsMap } from '../../models/model-options.types';
import type { ModelGroupDto, ModelItemDto, ModelProviderDto } from '../../models/models.types';
import { STATIC_MODEL_PROVIDERS } from '../../models/models.static';
import { truncatePayload } from '../../sessions/domain/events.types';
import { EventsRepository } from '../../sessions/persistence/events.repository';
import { SessionsRepository } from '../../sessions/persistence/sessions.repository';
import { SettingsService } from '../../settings/settings.service';
import type { AgentRunContext } from '../agents.types';
import { BaseAgentProvider } from '../agents.base-provider';
import { piThinkingDescriptors, resolvePiThinkingLevel } from './pi-thinking.helpers';

type PiSdk = typeof import('@earendil-works/pi-coding-agent');

type PiImageContent = { type: 'image'; data: string; mimeType: string };

type PiPromptOptions = {
  streamingBehavior?: 'steer' | 'followUp';
  images?: PiImageContent[];
};

type PiRegistryModel = {
  provider?: string;
  id?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  contextWindow?: number;
};

type PiLiveSession = {
  prompt: (text: string, options?: PiPromptOptions) => Promise<void>;
  steer: (text: string, images?: PiImageContent[]) => Promise<void>;
  abort: () => Promise<void>;
  setModel: (model: PiRegistryModel) => Promise<void>;
  setThinkingLevel: (level: string) => void;
  readonly model?: PiRegistryModel;
  readonly thinkingLevel?: string;
  readonly isStreaming?: boolean;
};

type PiSessionHandle = {
  session: PiLiveSession;
  modelRegistry: PiModelRegistry;
  prompt: (text: string, options?: PiPromptOptions) => Promise<void>;
  unsubscribe: () => void;
  resetAssistantText: () => void;
  getAssistantText: () => string;
  /** Turn-final assistant messages already emitted during the current prompt. */
  getAssistantTurnsEmitted: () => number;
  /** Error message of a turn that failed (stopReason 'error'), if any. */
  getTurnError: () => string | null;
  sealOpenTools: (emit?: AgentRunContext['emit']) => void;
};

function piImagesFromAttachments(context: AgentRunContext): PiImageContent[] {
  return (context.attachments ?? [])
    .filter((attachment) => attachment.kind === 'image')
    .map((attachment): PiImageContent => ({
      type: 'image',
      data: attachment.data,
      mimeType: attachment.mimeType,
    }));
}

type PiModelRegistry = {
  getAvailable: () => Array<{
    provider: string;
    id: string;
    name: string;
    cost?: { input: number; output: number };
    contextWindow?: number;
    reasoning?: boolean;
    thinkingLevelMap?: Record<string, string | null>;
  }>;
  find: (provider: string, id: string) => PiRegistryModel | undefined;
  getProviderDisplayName: (provider: string) => string;
};

@Injectable()
export class PiAgentProvider extends BaseAgentProvider {
  readonly id = 'pi';
  readonly name = 'Pi';
  readonly capabilities = {
    interrupt: true,
    modelSwitch: 'in-session',
    effortSwitch: 'in-session',
    images: true,
    steerWhileRunning: true,
  } as const;
  private readonly activeSessions = new Map<string, PiSessionHandle>();
  private readonly interruptedSessions = new Set<string>();
  private piSdkPromise?: Promise<PiSdk>;
  private cachedAvailable?: boolean;

  constructor(sessions: SessionsRepository, events: EventsRepository, private readonly settings: SettingsService) {
    super(sessions, events);
  }

  async isAvailable(): Promise<boolean> {
    if (this.cachedAvailable !== undefined) return this.cachedAvailable;
    try {
      const pi = await this.loadSdk();
      const agentDir = this.resolveAgentDir(pi);
      const authStorage = pi.AuthStorage.create(join(agentDir, 'auth.json'));
      const registry = pi.ModelRegistry.create(authStorage, join(agentDir, 'models.json'));
      this.cachedAvailable = registry.getAvailable().length > 0;
    } catch {
      this.cachedAvailable = false;
    }
    return this.cachedAvailable;
  }

  /** Drop cached availability so the next call re-resolves from current settings. */
  bustCache(): void {
    this.cachedAvailable = undefined;
  }

  /** The Pi session file outlives the daemon; a new handle reopens it on the next prompt. */
  canResumeThread(session: { providerThreadId: string | null }): boolean {
    return typeof session.providerThreadId === 'string' && session.providerThreadId.length > 0;
  }

  async listModels(): Promise<ModelProviderDto[]> {
    try {
      const pi = await this.loadSdk();
      const agentDir = this.resolveAgentDir(pi);
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
    this.interruptedSessions.delete(sessionId);
  }

  /**
   * Inject a steer message into a live streaming run. The Pi SDK queues it and
   * delivers after the current turn's tool calls, before the next LLM call —
   * the same mechanism the pi CLI uses for mid-run steering.
   */
  async steerMidRun(
    sessionId: string,
    message: string,
    context: AgentRunContext,
  ): Promise<boolean> {
    const handle = this.activeSessions.get(sessionId);
    if (!handle || !handle.session.isStreaming) return false;
    this.pushEvent(sessionId, 'steer_message', { text: message }, context.emit);
    const images = piImagesFromAttachments(context);
    await handle.session.steer(message, images.length ? images : undefined);
    return true;
  }

  async interrupt(sessionId: string): Promise<void> {
    const handle = this.activeSessions.get(sessionId);
    if (!handle) return;
    if (!handle.session.isStreaming) {
      await handle.session.abort().catch(() => undefined);
      return;
    }
    this.interruptedSessions.add(sessionId);
    try {
      await handle.session.abort();
    } catch (error) {
      this.interruptedSessions.delete(sessionId);
      throw error;
    }
  }

  async setModel(
    sessionId: string,
    modelId: string,
    options?: ModelOptionsMap | null,
  ): Promise<void> {
    const handle = this.activeSessions.get(sessionId);
    if (!handle) return;
    const model = resolveModelId(modelId, (provider, id) => handle.modelRegistry.find(provider, id));
    if (!model) return;
    await handle.session.setModel(model);
    const thinkingLevel = resolvePiThinkingLevel(options, model);
    if (thinkingLevel) handle.session.setThinkingLevel(thinkingLevel);
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

    const images = piImagesFromAttachments(context);
    const promptOptions: PiPromptOptions = {
      ...(images.length ? { images } : {}),
      ...(isSteer ? { streamingBehavior: 'steer' as const } : {}),
    };

    handle.resetAssistantText();
    this.interruptedSessions.delete(sessionId);
    let interrupted = false;
    try {
      await handle.prompt(text, Object.keys(promptOptions).length ? promptOptions : undefined);
    } catch (error) {
      if (this.interruptedSessions.delete(sessionId)) {
        interrupted = true;
      } else {
        throw error;
      }
    } finally {
      handle.sealOpenTools(context.emit);
    }
    if (interrupted) return;
    this.interruptedSessions.delete(sessionId);
    const turnError = handle.getTurnError();
    if (turnError) {
      // Route through the shared error path: ERROR status + error event.
      throw new Error(turnError);
    }
    if (handle.getAssistantTurnsEmitted() === 0) {
      // Fallback for runs where no message_end fired (older SDK shapes).
      this.pushEvent(
        sessionId,
        'assistant_message',
        { text: handle.getAssistantText() || '(no response)' },
        context.emit,
      );
    }
  }

  private loadSdk(): Promise<PiSdk> {
    this.piSdkPromise ??= import('@earendil-works/pi-coding-agent');
    return this.piSdkPromise;
  }

  /**
   * Resolve the Pi agent directory: a configured setting (DB or env) wins,
   * otherwise defer to the SDK's own resolution (`~/.pi/agent` by default).
   */
  private resolveAgentDir(pi: PiSdk): string {
    return this.settings.resolve('PI_AGENT_DIR') ?? pi.getAgentDir();
  }

  private async createPiSession(
    sessionId: string,
    context: AgentRunContext,
  ): Promise<PiSessionHandle> {
    const pi = await this.loadSdk();
    const agentDir = this.resolveAgentDir(pi);
    const authStorage = pi.AuthStorage.create(join(agentDir, 'auth.json'));
    const modelRegistry = pi.ModelRegistry.create(authStorage, join(agentDir, 'models.json'));
    const model = resolveModelId(context.model, (provider, id) => modelRegistry.find(provider, id));
    const thinkingLevel = resolvePiThinkingLevel(context.modelOptions, model);
    const persistedFile = this.sessions.findById(sessionId)?.providerThreadId ?? null;
    let resumeManager: ReturnType<typeof pi.SessionManager.open> | undefined;
    if (persistedFile) {
      try {
        resumeManager = pi.SessionManager.open(persistedFile, undefined, context.cwd);
      } catch {
        resumeManager = undefined;
      }
    }
    const customTools = buildPiCustomTools(context.cwd, pi);
    const { session } = await pi.createAgentSession({
      agentDir,
      ...(context.cwd ? { cwd: context.cwd } : {}),
      ...(resumeManager ? { sessionManager: resumeManager } : {}),
      authStorage,
      modelRegistry,
      // No `tools` allowlist: match pi CLI defaults (read/bash/edit/write active)
      // and keep extension-registered tools (foreman, subagent, ...) enabled.
      ...(customTools ? { customTools: customTools as never } : {}),
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    });

    if (session.sessionFile && session.sessionFile !== persistedFile) {
      this.sessions.updateProviderRuntimeState(sessionId, { providerThreadId: session.sessionFile });
    }

    let assistantText = '';
    let assistantTurnsEmitted = 0;
    let lastTurnError: string | null = null;
    let accumulatedThinking = '';
    let thinkingOpen = false;
    let thinkingId: string | undefined;
    const openTools = new Map<string, string>();

    const resetThinking = () => {
      accumulatedThinking = '';
      thinkingOpen = false;
      thinkingId = undefined;
    };
    const ensureThinkingStarted = () => {
      if (thinkingOpen) return;
      thinkingOpen = true;
      thinkingId = crypto.randomUUID();
      accumulatedThinking = '';
      this.pushEvent(sessionId, 'thinking_start', { thinkingId }, context.emit);
    };
    const sealOpenTools = (emit?: AgentRunContext['emit']) => {
      for (const [callId, tool] of openTools) {
        this.pushEvent(sessionId, 'tool_end', { callId, tool, isError: false }, emit);
      }
      openTools.clear();
    };

    const unsubscribe = session.subscribe((event: { type: string; [key: string]: unknown }) => {
      if (event.type === 'message_update') {
        const inner = event.assistantMessageEvent as {
          type?: string;
          delta?: string;
          content?: string;
        } | undefined;
        if (inner?.type === 'text_delta' && inner.delta) {
          assistantText += inner.delta;
          this.pushEvent(sessionId, 'assistant_delta', { delta: inner.delta }, context.emit);
          this.sessions.touchPreview(sessionId, assistantText);
        }
        if (inner?.type === 'thinking_start') {
          ensureThinkingStarted();
        }
        if (inner?.type === 'thinking_delta' && inner.delta) {
          ensureThinkingStarted();
          accumulatedThinking += inner.delta;
          this.pushEvent(
            sessionId,
            'thinking_delta',
            { thinkingId, delta: inner.delta },
            context.emit,
          );
        }
        if (inner?.type === 'thinking_end') {
          ensureThinkingStarted();
          const text = typeof inner.content === 'string' ? inner.content : accumulatedThinking;
          this.pushEvent(sessionId, 'thinking_message', { thinkingId, text }, context.emit);
          resetThinking();
        }
      }
      if (event.type === 'tool_execution_start') {
        const callId = typeof event.toolCallId === 'string' ? event.toolCallId : crypto.randomUUID();
        const tool = typeof event.toolName === 'string' ? event.toolName : 'unknown';
        openTools.set(callId, tool);
        const input = event.args !== undefined ? truncatePayload(event.args).value : undefined;
        this.pushEvent(
          sessionId,
          'tool_start',
          { callId, tool, ...(input !== undefined ? { input } : {}) },
          context.emit,
        );
      }
      if (event.type === 'tool_execution_end') {
        const callId = typeof event.toolCallId === 'string' ? event.toolCallId : undefined;
        const tool = typeof event.toolName === 'string' ? event.toolName : 'unknown';
        if (callId) openTools.delete(callId);
        const output = event.result !== undefined ? truncatePayload(event.result).value : undefined;
        this.pushEvent(
          sessionId,
          'tool_end',
          {
            ...(callId ? { callId } : {}),
            tool,
            isError: event.isError,
            ...(output !== undefined ? { output } : {}),
          },
          context.emit,
        );
      }
      if (event.type === 'message_end') {
        const message = event.message as
          | {
              role?: string;
              stopReason?: string;
              errorMessage?: string;
              content?: Array<{ type?: string; text?: string }>;
            }
          | undefined;
        if (message?.role === 'assistant') {
          if (message.stopReason === 'error') {
            // Remembered here, surfaced by executePrompt through the shared
            // error path so the session lands in ERROR with an error event.
            lastTurnError = message.errorMessage || 'Model call failed.';
          } else if (message.stopReason !== 'aborted') {
            const text = (message.content ?? [])
              .filter((block) => block?.type === 'text' && typeof block.text === 'string')
              .map((block) => block.text)
              .join('');
            if (text.trim()) {
              // Per-turn final message: mirrors the pi session file exactly, so
              // transcript refreshes dedupe instead of duplicating steered runs.
              this.pushEvent(sessionId, 'assistant_message', { text }, context.emit);
              assistantTurnsEmitted += 1;
            }
          }
        }
      }
      if (event.type === 'agent_end') {
        sealOpenTools(context.emit);
      }
    });

    return {
      session: session as PiLiveSession,
      modelRegistry,
      prompt: (prompt, options) => session.prompt(prompt, options as never),
      unsubscribe,
      resetAssistantText: () => {
        assistantText = '';
        assistantTurnsEmitted = 0;
        lastTurnError = null;
        resetThinking();
      },
      getAssistantText: () => assistantText,
      getAssistantTurnsEmitted: () => assistantTurnsEmitted,
      getTurnError: () => lastTurnError,
      sealOpenTools,
    };
  }

  private fromRegistry(modelRegistry: PiModelRegistry): ModelProviderDto[] {
    const models = modelRegistry.getAvailable();
    if (models.length === 0) return STATIC_MODEL_PROVIDERS;

    const groupsByProvider = new Map<string, ModelItemDto[]>();
    for (const model of models) {
      const registryModel = modelRegistry.find(model.provider, model.id);
      const options = piThinkingDescriptors(registryModel ?? model);
      const contextWindow = registryModel?.contextWindow ?? model.contextWindow;
      const validContextWindow =
        typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0
          ? contextWindow
          : undefined;
      const item: ModelItemDto = {
        id: `${model.provider}:${model.id}`,
        name: model.name,
        sub: model.id,
        ...(validContextWindow !== undefined ? { contextWindow: validContextWindow } : {}),
        ...(options.length > 0 ? { options } : {}),
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

/**
 * Build the `customTools` array for `createAgentSession`. When a worktree cwd is
 * set, rebind EVERY built-in tool to that cwd. This wins over same-named tools
 * registered by local extensions (e.g. claude-studio binds bash/read/edit/write to
 * `process.cwd()` at load time, which would make the agent operate in the server's
 * cwd instead of the worktree). SDK customTools take precedence over extension
 * `pi.registerTool` overrides. All built-ins are rebound so every tool the agent
 * can activate has a cwd-correct instance ready. Returns `undefined` when no
 * worktree is set so extension overrides apply as-is.
 */
export function buildPiCustomTools(
  cwd: string | undefined,
  factories: {
    createReadTool: (cwd: string) => unknown;
    createBashTool: (cwd: string) => unknown;
    createEditTool: (cwd: string) => unknown;
    createWriteTool: (cwd: string) => unknown;
    createGrepTool: (cwd: string) => unknown;
    createFindTool: (cwd: string) => unknown;
    createLsTool: (cwd: string) => unknown;
  },
): unknown[] | undefined {
  if (!cwd) return undefined;
  return [
    factories.createReadTool(cwd),
    factories.createBashTool(cwd),
    factories.createEditTool(cwd),
    factories.createWriteTool(cwd),
    factories.createGrepTool(cwd),
    factories.createFindTool(cwd),
    factories.createLsTool(cwd),
  ];
}
