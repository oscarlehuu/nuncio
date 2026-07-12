import { Injectable, Optional } from '@nestjs/common';
import { join } from 'node:path';
import type { ModelOptionsMap } from '../../models/model-options.types';
import type { ModelGroupDto, ModelItemDto, ModelProviderDto } from '../../models/models.types';
import { truncatePayload } from '../../sessions/domain/events.types';
import { formatInteractionAnswers } from '../../sessions/domain/format-interaction-answers';
import {
  buildUserInputRequestedPayload,
  findOpenUserInputRequest,
} from '../../sessions/domain/interactive-tool-events';
import { EventsRepository } from '../../sessions/persistence/events.repository';
import { SessionsRepository } from '../../sessions/persistence/sessions.repository';
import { SettingsService } from '../../settings/settings.service';
import type { AgentRunContext, InteractionResponse } from '../agents.types';
import { runtimePolicyKey, runtimeToolsForPolicy } from '../agent-runtime-policy';
import { AgentRunCancelledError, BaseAgentProvider } from '../agents.base-provider';
import { eventImagesFromAttachments } from '../agents.attachments';
import {
  appendRuntimeToolInstructions,
  asToolInput,
  normalizeAgentRuntimeToolResult,
  type AgentRuntimeTool,
  type AgentRuntimeTools,
} from '../tools/agent-runtime-tools.types';
import { piThinkingDescriptors, resolvePiThinkingLevel } from './pi-thinking.helpers';
import { piEngineExtensionPaths } from '../pi-engine/extension-allowlist';
import { buildTodoTool, TODO_TOOL_NAME } from '../pi-engine/todo-tool';
import {
  ASK_USER_QUESTION_TOOL_NAME,
  buildAskUserQuestionTool,
} from '../pi-engine/ask-user-question-tool';
import { normalizePlanItems } from '../../sessions/domain/plan.types';
import { buildPiRuntimePolicyOptions } from './pi-runtime-policy';
import {
  NUNCIO_CONTEXT_MAX_BYTES,
  NuncioContextService,
} from '../pi-engine/nuncio-context';

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
  input?: Array<'text' | 'image'>;
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
  dispose?: () => void;
};

type PiSessionHandle = {
  session: PiLiveSession;
  modelRegistry: PiModelRegistry;
  prompt: (text: string, options?: PiPromptOptions) => Promise<void>;
  unsubscribe: () => void;
  setEmit: (emit?: AgentRunContext['emit']) => void;
  resetAssistantText: () => void;
  getAssistantText: () => string;
  /** Turn-final assistant messages already emitted during the current prompt. */
  getAssistantTurnsEmitted: () => number;
  /** Error message of a turn that failed (stopReason 'error'), if any. */
  getTurnError: () => string | null;
  sealOpenTools: (emit?: AgentRunContext['emit']) => void;
  runtimePolicyKey: string;
  runtimeToolSnapshot: PiRuntimeToolSnapshot;
};

type PiRuntimeToolSnapshot = Array<{
  definition: string;
  execute: AgentRuntimeTool['execute'];
}>;

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
    input?: Array<'text' | 'image'>;
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
    runtimePolicies: [
      { filesystem: 'read-only', network: 'disabled' },
      { filesystem: 'workspace-write', network: 'disabled' },
    ],
  } as const;
  private readonly activeSessions = new Map<string, PiSessionHandle>();
  private readonly interruptedSessions = new Set<string>();
  private piSdkPromise?: Promise<PiSdk>;
  private cachedAvailable?: boolean;

  constructor(
    sessions: SessionsRepository,
    events: EventsRepository,
    private readonly settings: SettingsService,
    @Optional() private readonly nuncioContext?: NuncioContextService,
  ) {
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
      return [];
    }
  }

  protected disposeRuntime(sessionId: string): void {
    const handle = this.activeSessions.get(sessionId);
    if (!handle) return;
    void handle.session.abort().catch(() => undefined);
    handle.unsubscribe();
    handle.session.dispose?.();
    this.activeSessions.delete(sessionId);
    this.interruptedSessions.delete(sessionId);
  }

  protected prepareRuntimeDispose(sessionId: string): boolean {
    const handle = this.activeSessions.get(sessionId);
    if (!handle) return false;
    handle.sealOpenTools();
    return true;
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
    this.assertRuntimePolicyUnchanged(handle, context);
    const runtimeTools = runtimeToolsForPolicy(context.runtimePolicy, context.tools);
    if (!samePiRuntimeTools(handle.runtimeToolSnapshot, runtimeTools, context.runtimePolicy != null)) {
      throw new Error('Runtime tools cannot change during an active Pi turn.');
    }
    const generation = this.currentRunGeneration(sessionId);
    const eventImages = eventImagesFromAttachments(context.attachments);
    const payload = {
      text: message,
      ...(eventImages ? { images: eventImages } : {}),
      ...(context.steerOrigin ? { origin: context.steerOrigin } : {}),
    };
    this.pushEvent(
      sessionId,
      'steer_reserved',
      payload,
      context.emit,
    );
    try {
      await this.waitForPendingEvents(sessionId);
    } catch (error) {
      if (error instanceof AgentRunCancelledError) return false;
      throw error;
    }
    if (
      !this.isCurrentRunGeneration(sessionId, generation) ||
      this.activeSessions.get(sessionId) !== handle ||
      !handle.session.isStreaming
    ) return false;
    const images = piImagesFromAttachments(context);
    try {
      await handle.session.steer(message, images.length ? images : undefined);
    } catch {
      return false;
    }
    this.pushEvent(sessionId, 'steer_message', payload, context.emit);
    try {
      await this.waitForPendingEvents(sessionId);
    } catch (error) {
      // The SDK already accepted the input. Preserve exactly-once routing even
      // if teardown fences the run while its delivery event is recovering.
      if (!(error instanceof AgentRunCancelledError)) throw error;
    }
    return true;
  }

  supportsInteraction(): boolean {
    return true;
  }

  /**
   * Answer a pending interactive tool prompt. Pi extension tools resolve
   * immediately in headless SDK runs (the extension runner has no UI context),
   * so the answer is delivered as a steer: queued into the live stream when the
   * run is still going, otherwise re-entering the run as a new steer prompt.
   */
  async submitInteraction(
    sessionId: string,
    requestId: string,
    response: InteractionResponse,
    context: AgentRunContext,
  ): Promise<void> {
    const requested = findOpenUserInputRequest(this.events.list(sessionId, 0), requestId);
    if (!requested) {
      throw new Error(`No pending user input request ${requestId}`);
    }

    this.pushEvent(
      sessionId,
      'user_input_resolved',
      { requestId, resolvedBy: response.resolvedBy, answers: response.answers },
      context.emit,
    );

    const formatted = formatInteractionAnswers(requested.questions, response);
    const delivered = await this.steerMidRun(sessionId, formatted, context);
    if (!delivered) {
      await this.steer(sessionId, formatted, context);
    }
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
    const runtimeTools = runtimeToolsForPolicy(context.runtimePolicy, context.tools);
    let handle = this.activeSessions.get(sessionId);
    if (!handle) {
      handle = await this.createPiSession(sessionId, context, runtimeTools);
      this.activeSessions.set(sessionId, handle);
    } else {
      this.assertRuntimePolicyUnchanged(handle, context);
      if (!samePiRuntimeTools(handle.runtimeToolSnapshot, runtimeTools, context.runtimePolicy != null)) {
        if (handle.session.isStreaming) {
          throw new Error('Runtime tools cannot change during an active Pi turn.');
        }
        handle.unsubscribe();
        handle.session.dispose?.();
        handle = await this.createPiSession(sessionId, context, runtimeTools);
        this.activeSessions.set(sessionId, handle);
      }
    }
    handle.setEmit(context.emit);

    const images = piImagesFromAttachments(context);
    const promptOptions: PiPromptOptions = {
      ...(images.length ? { images } : {}),
      ...(isSteer ? { streamingBehavior: 'steer' as const } : {}),
    };

    handle.resetAssistantText();
    this.interruptedSessions.delete(sessionId);
    let interrupted = false;
    try {
      await handle.prompt(
        appendRuntimeToolInstructions(text, runtimeTools),
        Object.keys(promptOptions).length ? promptOptions : undefined,
      );
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

  /**
   * Pi extension discovery is deny-by-default in nuncio sessions: global
   * `~/.pi` extensions are written for the interactive CLI or rebind core
   * tools to a fixed cwd, which breaks worktree sessions. Allowlisted
   * extensions load through `additionalExtensionPaths`, so anything outside
   * the list never executes. `PI_EXTENSION_DISCOVERY=full` restores pi's
   * default discovery without disabling Nuncio's project-context injection.
   */
  private async createEngineResources(pi: PiSdk, agentDir: string, sessionId: string, cwd?: string) {
    const resolvedCwd = cwd ?? process.cwd();
    const settingsManager = pi.SettingsManager.create(resolvedCwd, agentDir);
    const session = this.sessions.findById(sessionId);
    const projectPath = session?.projectPath ?? null;
    const configuredBudget = Number(this.settings.resolve('NUNCIO_CONTEXT_FACTS_MAX_BYTES'));
    const contextBudget = Number.isInteger(configuredBudget) && configuredBudget > 0
      ? Math.min(configuredBudget, NUNCIO_CONTEXT_MAX_BYTES)
      : NUNCIO_CONTEXT_MAX_BYTES;
    const context = this.settings.resolve('NUNCIO_CONTEXT_FACTS_INJECT') === 'off'
      ? ''
      : (this.nuncioContext?.buildForProject(projectPath, contextBudget, session?.originTaskId) ?? '');
    const fullDiscovery = this.settings.resolve('PI_EXTENSION_DISCOVERY') === 'full';
    const resourceLoader = new pi.DefaultResourceLoader({
      cwd: resolvedCwd,
      agentDir,
      settingsManager,
      ...(!fullDiscovery ? {
        noExtensions: true,
        additionalExtensionPaths: piEngineExtensionPaths(agentDir),
      } : {}),
      ...(context ? { appendSystemPrompt: [context] } : {}),
    });
    await resourceLoader.reload();
    return { resourceLoader, settingsManager };
  }

  private async createPiSession(
    sessionId: string,
    context: AgentRunContext,
    runtimeTools = runtimeToolsForPolicy(context.runtimePolicy, context.tools),
  ): Promise<PiSessionHandle> {
    const pi = await this.loadSdk();
    const agentDir = this.resolveAgentDir(pi);
    const authStorage = pi.AuthStorage.create(join(agentDir, 'auth.json'));
    const modelRegistry = pi.ModelRegistry.create(authStorage, join(agentDir, 'models.json'));
    const model = resolveModelId(context.model, (provider, id) => modelRegistry.find(provider, id));
    if (context.runtimePolicy && context.model?.trim() && !model) {
      throw new Error(
        `Pi model "${context.model.trim()}" is unavailable; explicit runtime policy forbids fallback.`,
      );
    }
    const thinkingLevel = resolvePiThinkingLevel(context.modelOptions, model);
    const policyOptions = context.runtimePolicy
      ? buildPiRuntimePolicyOptions(context.runtimePolicy, pi)
      : undefined;
    const cwd = policyOptions?.workspaceRoot ?? context.cwd;
    const policyResourceLoader = policyOptions
      ? new pi.DefaultResourceLoader({
          cwd: policyOptions.workspaceRoot,
          agentDir,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        })
      : undefined;
    await policyResourceLoader?.reload();
    const persistedFile = this.sessions.findById(sessionId)?.providerThreadId ?? null;
    let resumeManager: ReturnType<typeof pi.SessionManager.open> | undefined;
    if (persistedFile) {
      try {
        resumeManager = pi.SessionManager.open(persistedFile, undefined, cwd);
      } catch (error) {
        this.sessions.updateProviderRuntimeState(sessionId, {
          providerThreadId: null,
          providerActiveTurnId: null,
        });
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot resume Pi session: ${reason}`);
      }
    }
    const runtimeCustomTools = buildPiRuntimeTools(
      runtimeTools,
      pi.defineTool,
    );
    const engineTools = [
      buildTodoTool(pi.defineTool as (tool: unknown) => unknown),
      buildAskUserQuestionTool(pi.defineTool as (tool: unknown) => unknown),
    ];
    const customTools = policyOptions
      ? [...policyOptions.customTools, ...runtimeCustomTools, ...engineTools]
      : [...(buildPiCustomTools(context.cwd, pi, context.tools) ?? []), ...engineTools];
    const engineResources = policyOptions
      ? undefined
      : await this.createEngineResources(pi, agentDir, sessionId, context.cwd);
    // Pi 0.80.6 treats `tools` as the allowlist for built-ins AND customTools.
    // Include the already-vetted Crew definitions or the SDK silently removes
    // submit_* from the registry despite receiving it in customTools.
    const policyToolNames = policyOptions
      ? [...new Set([
          ...policyOptions.toolNames,
          ...(runtimeTools?.tools.map((tool) => tool.name) ?? []),
          TODO_TOOL_NAME,
          ASK_USER_QUESTION_TOOL_NAME,
        ])]
      : undefined;
    const { session } = await pi.createAgentSession({
      agentDir,
      ...(cwd ? { cwd } : {}),
      ...(resumeManager ? { sessionManager: resumeManager } : {}),
      ...(engineResources ?? {}),
      authStorage,
      modelRegistry,
      ...(policyResourceLoader ? { resourceLoader: policyResourceLoader } : {}),
      // Solo keeps Pi's defaults. Explicit policy uses an allowlist and omits
      // bash because host-shell confinement plus disabled network is unprovable.
      ...(policyToolNames ? { tools: policyToolNames } : {}),
      customTools: customTools as never,
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    });

    if (session.sessionFile && session.sessionFile !== persistedFile) {
      this.sessions.updateProviderRuntimeState(sessionId, { providerThreadId: session.sessionFile });
    }

    let currentEmit = context.emit;
    let assistantText = '';
    let assistantTurnsEmitted = 0;
    let lastTurnError: string | null = null;
    let accumulatedThinking = '';
    let thinkingOpen = false;
    let thinkingId: string | undefined;
    const openTools = new Map<string, string>();
    /** Interactive tool calls surfaced as user_input_requested — no tool_start/tool_end pair. */
    const userInputRequests = new Set<string>();
    /** todo_write calls surfaced as plan_updated — no tool_start/tool_end pair. */
    const planToolCalls = new Set<string>();

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
      this.pushEvent(sessionId, 'thinking_start', { thinkingId }, currentEmit);
    };
    const sealOpenTools = (emit: AgentRunContext['emit'] = currentEmit) => {
      for (const [callId, tool] of openTools) {
        this.pushEvent(sessionId, 'tool_end', { callId, tool, isError: false }, emit);
      }
      openTools.clear();
      userInputRequests.clear();
      planToolCalls.clear();
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
          this.pushEvent(sessionId, 'assistant_delta', { delta: inner.delta }, currentEmit);
          this.touchPreview(sessionId, assistantText, currentEmit);
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
            currentEmit,
          );
        }
        if (inner?.type === 'thinking_end') {
          ensureThinkingStarted();
          const text = typeof inner.content === 'string' ? inner.content : accumulatedThinking;
          this.pushEvent(sessionId, 'thinking_message', { thinkingId, text }, currentEmit);
          resetThinking();
        }
      }
      if (event.type === 'tool_execution_start') {
        const callId = typeof event.toolCallId === 'string' ? event.toolCallId : crypto.randomUUID();
        const tool = typeof event.toolName === 'string' ? event.toolName : 'unknown';
        const userInputPayload = buildUserInputRequestedPayload(tool, event.args, callId);
        if (userInputPayload) {
          userInputRequests.add(callId);
          this.pushEvent(sessionId, 'user_input_requested', userInputPayload, currentEmit);
          return;
        }
        if (tool === TODO_TOOL_NAME) {
          const items = normalizePlanItems((event.args as { items?: unknown } | undefined)?.items);
          if (items) {
            planToolCalls.add(callId);
            this.pushEvent(sessionId, 'plan_updated', { items }, currentEmit);
            return;
          }
        }
        openTools.set(callId, tool);
        const input = event.args !== undefined ? truncatePayload(event.args).value : undefined;
        this.pushEvent(
          sessionId,
          'tool_start',
          { callId, tool, ...(input !== undefined ? { input } : {}) },
          currentEmit,
        );
      }
      if (event.type === 'tool_execution_end') {
        const callId = typeof event.toolCallId === 'string' ? event.toolCallId : undefined;
        if (callId && userInputRequests.delete(callId)) return;
        if (callId && planToolCalls.delete(callId)) return;
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
          currentEmit,
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
            // Pi may emit a failed attempt before an automatic retry succeeds.
            // Settlement follows the latest non-aborted assistant completion.
            lastTurnError = null;
            const text = (message.content ?? [])
              .filter((block) => block?.type === 'text' && typeof block.text === 'string')
              .map((block) => block.text)
              .join('');
            if (text.trim()) {
              // Per-turn final message: mirrors the pi session file exactly, so
              // transcript refreshes dedupe instead of duplicating steered runs.
              this.pushEvent(sessionId, 'assistant_message', { text }, currentEmit);
              assistantTurnsEmitted += 1;
            }
          }
        }
      }
      if (event.type === 'agent_end') {
        sealOpenTools(currentEmit);
      }
    });

    return {
      session: session as PiLiveSession,
      modelRegistry,
      prompt: (prompt, options) => session.prompt(prompt, options as never),
      unsubscribe,
      setEmit: (emit) => {
        currentEmit = emit;
      },
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
      runtimePolicyKey: runtimePolicyKey(context.runtimePolicy),
      runtimeToolSnapshot: snapshotPiRuntimeTools(runtimeTools),
    };
  }

  private assertRuntimePolicyUnchanged(
    handle: PiSessionHandle,
    context: AgentRunContext,
  ): void {
    if (handle.runtimePolicyKey !== runtimePolicyKey(context.runtimePolicy)) {
      throw new Error('Runtime policy cannot change on an active Pi session.');
    }
  }

  private fromRegistry(modelRegistry: PiModelRegistry): ModelProviderDto[] {
    const models = modelRegistry.getAvailable();
    if (models.length === 0) return [];

    const groupsByProvider = new Map<string, ModelItemDto[]>();
    for (const model of models) {
      const registryModel = modelRegistry.find(model.provider, model.id);
      const options = piThinkingDescriptors(registryModel ?? model);
      const contextWindow = registryModel?.contextWindow ?? model.contextWindow;
      const input = registryModel?.input ?? model.input ?? ['text'];
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
        capabilities: { images: input.includes('image') },
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
        models: groupModels.sort((left, right) =>
          left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }) ||
          left.id.localeCompare(right.id),
        ),
      });
    }
    groups.sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }) ||
      left.id.localeCompare(right.id),
    );

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
    defineTool?: (tool: unknown) => unknown;
  },
  runtimeTools?: AgentRuntimeTools,
): unknown[] | undefined {
  const tools = cwd
    ? [
        factories.createReadTool(cwd),
        factories.createBashTool(cwd),
        factories.createEditTool(cwd),
        factories.createWriteTool(cwd),
        factories.createGrepTool(cwd),
        factories.createFindTool(cwd),
        factories.createLsTool(cwd),
      ]
    : [];
  tools.push(...buildPiRuntimeTools(runtimeTools, factories.defineTool));
  return tools.length > 0 ? tools : undefined;
}

function buildPiRuntimeTools(
  runtimeTools: AgentRuntimeTools | undefined,
  defineTool: ((tool: unknown) => unknown) | undefined,
): unknown[] {
  const wrap = defineTool ?? ((tool: unknown) => tool);
  return (runtimeTools?.tools ?? []).map((tool) =>
    wrap({
      name: tool.name,
      label: tool.name,
      description: tool.description ?? tool.name,
      promptSnippet: tool.description ?? tool.name,
      parameters: tool.inputSchema,
      execute: async (_toolCallId: string, params: unknown) => {
        const result = normalizeAgentRuntimeToolResult(await tool.execute(asToolInput(params)));
        return {
          content: result.content,
          details: result.structuredContent ?? {},
          isError: result.isError === true,
        };
      },
    }),
  );
}

function snapshotPiRuntimeTools(runtimeTools: AgentRuntimeTools | undefined): PiRuntimeToolSnapshot {
  return (runtimeTools?.tools ?? []).map((tool) => ({
    definition: JSON.stringify([tool.name, tool.description ?? null, tool.inputSchema]),
    execute: tool.execute,
  }));
}

function samePiRuntimeTools(
  snapshot: PiRuntimeToolSnapshot,
  runtimeTools: AgentRuntimeTools | undefined,
  requireExecuteIdentity: boolean,
): boolean {
  const next = snapshotPiRuntimeTools(runtimeTools);
  return snapshot.length === next.length && snapshot.every(
    (tool, index) => tool.definition === next[index]?.definition
      && (!requireExecuteIdentity || tool.execute === next[index]?.execute),
  );
}
