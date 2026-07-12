import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventsRepository } from '../../sessions/persistence/events.repository';
import { SessionsRepository } from '../../sessions/persistence/sessions.repository';
import { SettingsService } from '../../settings/settings.service';
import type { ModelOptionDescriptorDto, ModelOptionsMap } from '../../models/model-options.types';
import type { ModelProviderDto } from '../../models/models.types';
import {
  AgentRunCancelledError,
  BaseAgentProvider,
  RetainedEventFlushError,
} from '../agents.base-provider';
import type { AgentRunContext, EventEmitter } from '../agents.types';
import {
  runtimePolicyKey,
  runtimeToolsForPolicy,
} from '../agent-runtime-policy';
import { appendRuntimeToolInstructions, type AgentRuntimeTools } from '../tools/agent-runtime-tools.types';
import {
  buildCodexDynamicTools,
  executeCodexRuntimeTool,
} from '../tools/codex-runtime-tools.adapter';
import type { ProviderRequestResult } from '../../sessions/domain/sessions.types';
import {
  CodexAppServerClient,
  type CodexAppServerClientLike,
  CodexStdioTransport,
  type CodexServerNotification,
  type CodexServerRequest,
} from './codex-app-server.client';
import {
  expandHome,
  resolveCodexCli,
  type CodexCliCommandRunner,
  type CodexCliResolution,
} from './codex-cli-resolver';
import { mapCodexRuntimePolicy } from './codex-runtime-policy';

type CodexRuntimeMode = 'approval-required' | 'full-access';

interface CodexThreadOpenResponse {
  thread?: { id?: string; name?: string | null };
  threadId?: string;
  threadName?: string | null;
}

interface CodexTurnStartResponse {
  turn?: { id?: string };
  turnId?: string;
}

type CodexReasoningEffortOption =
  | string
  | {
      id?: string;
      effort?: string;
      reasoningEffort?: string;
      reasoning_effort?: string;
      description?: string;
    };

interface CodexModelListResponse {
  data?: Array<{
    id?: string;
    model?: string;
    displayName?: string;
    description?: string;
    hidden?: boolean;
    supportedReasoningEfforts?: CodexReasoningEffortOption[];
    supported_reasoning_efforts?: CodexReasoningEffortOption[];
    defaultReasoningEffort?: string;
    default_reasoning_effort?: string;
    additionalSpeedTiers?: string[];
    additional_speed_tiers?: string[];
    supportsFastMode?: boolean;
    supports_fast_mode?: boolean;
    fastMode?: boolean;
    fast_mode?: boolean;
    fastServiceTier?: boolean;
    fast_service_tier?: boolean;
    isDefault?: boolean;
  }>;
}

interface ActiveCodexSession {
  client: CodexAppServerClientLike;
  codexThreadId: string;
  currentEmit?: EventEmitter;
  requestProviderApproval?: AgentRunContext['requestProviderApproval'];
  runtimeTools?: AgentRuntimeTools;
  activeTurnId?: string;
  accumulatedText: string;
  /** itemId of the agentMessage item currently streaming — a change marks a new
   * section that must be separated from the previous one. */
  currentAgentItemId?: string;
  completions: Map<
    string,
    {
      resolve: () => void;
      reject: (error: Error) => void;
    }
  >;
  completedTurns: Map<string, { status: string; errorMessage?: string; error?: Error }>;
  unsubscribers: Array<() => void>;
  runtimePolicyKey: string;
  dynamicToolSurface: string | undefined;
}

const DEFAULT_CODEX_REASONING_EFFORT = 'medium';
const DEFAULT_CODEX_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;

function isDefinitiveCodexResumeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /runtime tool definitions do not match the persisted codex thread/i.test(message) ||
    /(?:thread|conversation)(?: id)?[^\n]{0,160}(?:not found|does not exist|no longer exists|unknown|missing|incompatible)/i.test(message) ||
    /(?:no such|unknown|missing|incompatible) (?:codex )?(?:thread|conversation)(?: id)?/i.test(message) ||
    /(?:invalid|malformed) (?:codex )?(?:thread|conversation)(?: id)?/i.test(message) ||
    /(?:thread|conversation)(?: id)? (?:is )?(?:invalid|malformed)/i.test(message) ||
    /(?:cwd|workspace|rollout path).*(?:mismatch|does not match|incompatible)/i.test(message)
  );
}

const FALLBACK_CODEX_MODELS: ModelProviderDto[] = [
  {
    id: 'codex',
    name: 'Codex',
    sub: 'Local Codex app-server',
    icon: '◇',
    groups: [
      {
        id: 'openai',
        name: 'OpenAI',
        sub: 'Runtime discovery unavailable; showing fallback models',
        models: [
          {
            id: 'codex:gpt-5.5',
            name: 'GPT-5.5',
            sub: 'Codex model',
            options: defaultCodexModelOptions(),
          },
          {
            id: 'codex:gpt-5.4',
            name: 'GPT-5.4',
            sub: 'Codex model',
            options: defaultCodexModelOptions(),
          },
        ],
      },
    ],
  },
];

@Injectable()
export class CodexAgentProvider extends BaseAgentProvider implements OnModuleDestroy {
  readonly id = 'codex';
  readonly name = 'Codex';
  readonly capabilities = {
    interrupt: true,
    modelSwitch: 'none',
    effortSwitch: 'none',
    images: false,
    steerWhileRunning: false,
    runtimePolicies: [
      { filesystem: 'read-only', network: 'disabled' },
      { filesystem: 'workspace-write', network: 'disabled' },
    ],
  } as const;

  private readonly activeSessions = new Map<string, ActiveCodexSession>();
  private cachedAvailable?: boolean;
  private cachedModels?: ModelProviderDto[];
  private cachedCli?: CodexCliResolution;

  /** Test hook: inject a fake app-server client. */
  clientFactory?: (input: { binaryPath: string; cwd: string; env: NodeJS.ProcessEnv }) => CodexAppServerClientLike;

  /** Test hook: inject discovered Codex CLI candidates without scanning the host. */
  cliCandidatePaths?: string[];

  /** Test hook: replace process execution for availability probes. */
  commandRunner: CodexCliCommandRunner = async (command, args, options) => {
    const result = spawnSync(command, args, {
      env: options.env,
      encoding: 'utf8',
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  };

  constructor(
    sessions: SessionsRepository,
    events: EventsRepository,
    private readonly settings: SettingsService,
  ) {
    super(sessions, events);
  }

  async isAvailable(): Promise<boolean> {
    if (this.cachedAvailable !== undefined) return this.cachedAvailable;
    const resolution = await this.resolveCli();
    this.cachedAvailable = resolution.status === 'ready';
    return this.cachedAvailable;
  }

  bustCache(): void {
    this.cachedAvailable = undefined;
    this.cachedModels = undefined;
    this.cachedCli = undefined;
  }

  /** Codex app-server thread ids survive Nuncio daemon restarts and can be resumed. */
  canResumeThread(session: { providerThreadId: string | null }): boolean {
    return typeof session.providerThreadId === 'string' && session.providerThreadId.length > 0;
  }

  async listModels(): Promise<ModelProviderDto[]> {
    if (this.cachedModels) return this.cachedModels;
    if (!(await this.isAvailable())) return [];

    const cwd = this.settings.resolve('NUNCIO_CODEX_CWD')?.trim() || process.cwd();
    const client = this.createClient(cwd, await this.resolveBinaryPathForRun());
    try {
      await client.initialize();
      const response = await client.request<CodexModelListResponse>('model/list', {});
      this.cachedModels = this.mapModelList(response);
      return this.cachedModels;
    } catch {
      return FALLBACK_CODEX_MODELS;
    } finally {
      client.close();
    }
  }

  onModuleDestroy(): void {
    for (const sessionId of [...this.activeSessions.keys()]) {
      this.dispose(sessionId);
    }
  }

  protected disposeRuntime(sessionId: string): void {
    const active = this.activeSessions.get(sessionId);
    if (!active) return;
    const activeTurnId = active.activeTurnId;

    if (activeTurnId) {
      void active.client
        .request('turn/interrupt', {
          threadId: active.codexThreadId,
          turnId: activeTurnId,
        })
        .catch(() => undefined);
    }

    this.closeActiveSession(sessionId, active);
  }

  async interrupt(sessionId: string): Promise<void> {
    const active = this.activeSessions.get(sessionId);
    if (!active) return;
    const activeTurnId = active.activeTurnId;

    if (activeTurnId) {
      await active.client.request('turn/interrupt', {
        threadId: active.codexThreadId,
        turnId: activeTurnId,
      });
    }

    try {
      this.flushPendingEvents(sessionId);
    } catch (error) {
      // The accepted tail remains queued on RetainedEventFlushError. Detach the
      // acknowledged SDK turn and queue IDLE behind that tail instead of
      // leaving a stopped runtime reported as active.
      if (!(error instanceof RetainedEventFlushError)) throw error;
    }
    this.closeActiveSession(sessionId, active);
    this.pushEvent(sessionId, 'status', { status: 'IDLE' }, active.currentEmit);
  }

  private closeActiveSession(sessionId: string, active: ActiveCodexSession): void {
    if (this.activeSessions.get(sessionId) !== active) return;
    this.settleActiveSession(
      sessionId,
      active,
      new AgentRunCancelledError('Codex session disposed.'),
    );
    for (const unsubscribe of active.unsubscribers) unsubscribe();
    active.client.close();
    try {
      this.sessions.updateProviderRuntimeState(sessionId, { providerActiveTurnId: null });
    } catch {
      // Session may have been deleted while the app-server process was active.
    }
  }

  protected async executePrompt(
    sessionId: string,
    text: string,
    isSteer: boolean,
    context: AgentRunContext,
  ): Promise<void> {
    const active = await this.ensureSession(sessionId, context);
    const runtimeTools = runtimeToolsForPolicy(context.runtimePolicy, context.tools);
    active.currentEmit = context.emit;
    active.requestProviderApproval = context.requestProviderApproval;
    active.runtimeTools = runtimeTools;
    active.accumulatedText = '';
    active.currentAgentItemId = undefined;

    const model = this.resolveModel(context.model);
    const effort = this.resolveReasoningEffort(context.modelOptions);
    const serviceTier = this.resolveServiceTier(context.modelOptions);
    const turnInput = [
      {
        type: 'text' as const,
        text: appendRuntimeToolInstructions(text, runtimeTools),
        text_elements: [] as [],
      },
    ];

    const turn =
      isSteer && active.activeTurnId
        ? await active.client.request<CodexTurnStartResponse>('turn/steer', {
            threadId: active.codexThreadId,
            input: turnInput,
            expectedTurnId: active.activeTurnId,
          })
        : await active.client.request<CodexTurnStartResponse>('turn/start', {
            threadId: active.codexThreadId,
            input: turnInput,
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
            ...(serviceTier ? { serviceTier } : {}),
            ...this.turnRuntimeOverrides(context.runtimePolicy),
          });

    const turnId = this.readTurnId(turn);
    if (!turnId) {
      throw new Error(`${isSteer && active.activeTurnId ? 'turn/steer' : 'turn/start'} response did not include a turn id.`);
    }

    active.activeTurnId = turnId;
    this.sessions.updateProviderRuntimeState(sessionId, { providerActiveTurnId: turnId });
    await this.waitForTurn(sessionId, active, turnId);
  }

  private async ensureSession(sessionId: string, context: AgentRunContext): Promise<ActiveCodexSession> {
    const existing = this.activeSessions.get(sessionId);
    if (existing) {
      if (existing.runtimePolicyKey !== runtimePolicyKey(context.runtimePolicy)) {
        throw new Error('Runtime policy cannot change on an active Codex session.');
      }
      const nextSurface = codexDynamicToolSurface(
        runtimeToolsForPolicy(context.runtimePolicy, context.tools),
      );
      if (existing.dynamicToolSurface !== nextSurface) {
        throw new Error('Runtime tool definitions cannot change on an active Codex thread.');
      }
      return existing;
    }

    const cwd = this.resolveCwd(context);
    const runtimeTools = runtimeToolsForPolicy(context.runtimePolicy, context.tools);
    const client = this.createClient(cwd, await this.resolveBinaryPathForRun());
    const active: ActiveCodexSession = {
      client,
      codexThreadId: '',
      currentEmit: context.emit,
      requestProviderApproval: context.requestProviderApproval,
      runtimeTools,
      accumulatedText: '',
      completions: new Map(),
      completedTurns: new Map(),
      unsubscribers: [],
      runtimePolicyKey: runtimePolicyKey(context.runtimePolicy),
      dynamicToolSurface: codexDynamicToolSurface(runtimeTools),
    };

    active.unsubscribers.push(
      client.onNotification((notification) => this.handleNotification(sessionId, active, notification)),
      client.onServerRequest((request) => {
        void this.handleServerRequest(sessionId, active, request).catch(() => {
          try {
            active.client.respond(request.id, { decision: 'deny' });
          } catch {
            // The app-server process may already be gone.
          }
        });
      }),
      client.onClose((error) => this.failActiveSession(sessionId, active, error)),
    );

    let resumeCandidate = false;
    try {
      await client.initialize();
      const session = this.sessions.findById(sessionId);
      const model = this.resolveModel(context.model);
      const runtime = this.threadRuntimeOverrides(context.runtimePolicy);
      const dynamicTools = buildCodexDynamicTools(runtimeTools);
      const persistedThreadId = session?.providerThreadId;
      resumeCandidate = Boolean(persistedThreadId);
      const persistedToolSurface = asString(session?.providerState?.codexDynamicToolSurface);
      if (
        persistedThreadId &&
        persistedToolSurface !== active.dynamicToolSurface &&
        (persistedToolSurface !== undefined || active.dynamicToolSurface !== undefined)
      ) {
        throw new Error('Runtime tool definitions do not match the persisted Codex thread.');
      }
      const response = persistedThreadId
        ? await client.request<CodexThreadOpenResponse>('thread/resume', {
            threadId: persistedThreadId,
            ...(model ? { model } : {}),
            cwd,
            ...runtime,
          })
        : await client.request<CodexThreadOpenResponse>('thread/start', {
            ...(model ? { model } : {}),
            cwd,
            ...runtime,
            ...(context.runtimePolicy ? { allowProviderModelFallback: false } : {}),
            experimentalRawEvents: false,
            ...(dynamicTools ? { dynamicTools } : {}),
          });

      const codexThreadId = this.readThreadId(response) ?? persistedThreadId;
      if (!codexThreadId) {
        throw new Error('Codex thread open response did not include a thread id.');
      }

      active.codexThreadId = codexThreadId;
      this.sessions.updateProviderRuntimeState(sessionId, {
        providerThreadId: codexThreadId,
        providerState: {
          ...(this.sessions.findById(sessionId)?.providerState ?? {}),
          resumeCursor: { threadId: codexThreadId },
          ...(active.dynamicToolSurface
            ? { codexDynamicToolSurface: active.dynamicToolSurface }
            : {}),
        },
      });
      this.syncThreadName(sessionId, active, this.readThreadName(response), codexThreadId, context.emit);
      this.activeSessions.set(sessionId, active);
      return active;
    } catch (error) {
      if (resumeCandidate && isDefinitiveCodexResumeError(error)) {
        this.sessions.updateProviderRuntimeState(sessionId, {
          providerThreadId: null,
          providerActiveTurnId: null,
        });
      }
      for (const unsubscribe of active.unsubscribers) unsubscribe();
      client.close();
      throw error;
    }
  }

  private createClient(cwd: string, binaryPath: string): CodexAppServerClientLike {
    const input = {
      binaryPath,
      cwd,
      env: this.buildCodexEnv(),
    };
    if (this.clientFactory) return this.clientFactory(input);
    return new CodexAppServerClient(CodexStdioTransport.spawn(input));
  }

  private handleNotification(
    sessionId: string,
    active: ActiveCodexSession,
    notification: CodexServerNotification,
  ): void {
    const params = asRecord(notification.params);
    if (notification.method === 'thread/started') {
      const threadId = asString(asRecord(params?.thread)?.id) ?? asString(params?.threadId);
      if (threadId) {
        active.codexThreadId = threadId;
        this.sessions.updateProviderRuntimeState(sessionId, {
          providerThreadId: threadId,
          providerState: {
            ...(this.sessions.findById(sessionId)?.providerState ?? {}),
            resumeCursor: { threadId },
            ...(active.dynamicToolSurface
              ? { codexDynamicToolSurface: active.dynamicToolSurface }
              : {}),
          },
        });
      }
      return;
    }

    if (notification.method === 'thread/name/updated') {
      const thread = asRecord(params?.thread);
      const threadId = asString(params?.threadId) ?? asString(thread?.id);
      const threadName =
        asString(params?.threadName) ??
        asString(params?.name) ??
        asString(thread?.name);
      this.syncThreadName(sessionId, active, threadName, threadId, active.currentEmit);
      return;
    }

    if (notification.method === 'turn/started') {
      const turnId = asString(asRecord(params?.turn)?.id) ?? asString(params?.turnId);
      if (turnId) {
        active.activeTurnId = turnId;
        this.sessions.updateProviderRuntimeState(sessionId, { providerActiveTurnId: turnId });
      }
      return;
    }

    if (notification.method === 'item/agentMessage/delta') {
      const delta = asString(params?.delta);
      if (!delta) return;
      // A turn's message can arrive as a sequence of agentMessage items; each
      // item's text is internally well-formed, but Codex sends no separator
      // between items, so appending deltas verbatim runs consecutive sections
      // together. Insert a paragraph break at each item boundary so the shared
      // markdown renderer shows them as distinct paragraphs.
      const itemId = asString(params?.itemId);
      const isNewItem =
        itemId !== undefined &&
        active.currentAgentItemId !== undefined &&
        itemId !== active.currentAgentItemId;
      const piece = isNewItem
        ? `${this.paragraphBoundary(active.accumulatedText)}${delta}`
        : delta;
      if (itemId !== undefined) active.currentAgentItemId = itemId;
      active.accumulatedText += piece;
      this.pushEvent(sessionId, 'assistant_delta', { delta: piece }, active.currentEmit);
      this.touchPreview(sessionId, active.accumulatedText, active.currentEmit);
      return;
    }

    if (notification.method === 'turn/completed') {
      const turn = asRecord(params?.turn);
      const turnId = asString(turn?.id) ?? asString(params?.turnId) ?? active.activeTurnId;
      if (!turnId) return;
      const status = asString(turn?.status) ?? 'completed';
      const errorMessage = asString(asRecord(turn?.error)?.message);
      this.completeTurn(sessionId, active, turnId, status, errorMessage);
      return;
    }

    if (notification.method === 'error') {
      const message =
        asString(asRecord(params?.error)?.message) ?? asString(params?.message) ?? 'Codex app-server error';
      if (active.activeTurnId) {
        this.completeTurn(sessionId, active, active.activeTurnId, 'failed', message);
      }
    }
  }

  private async handleServerRequest(
    sessionId: string,
    active: ActiveCodexSession,
    request: CodexServerRequest,
  ): Promise<void> {
    if (await this.handleDynamicToolCall(active, request)) return;
    const result = await this.resolveProviderRequest(sessionId, active, request);
    try {
      active.client.respond(request.id, { decision: result.decision });
    } catch {
      // The session may have been paused/archived while the approval was open.
    }
  }

  private async handleDynamicToolCall(
    active: ActiveCodexSession,
    request: CodexServerRequest,
  ): Promise<boolean> {
    if (request.method !== 'item/tool/call') return false;

    const params = asRecord(request.params);
    const toolName =
      asString(params?.tool) ??
      asString(params?.name) ??
      asString(asRecord(params?.item)?.tool);
    if (!toolName) {
      active.client.respond(request.id, {
        contentItems: [{ type: 'inputText', text: 'Dynamic tool request did not include a tool name.' }],
        success: false,
      });
      return true;
    }

    const response =
      (await executeCodexRuntimeTool(active.runtimeTools, toolName, params?.arguments)) ?? {
        contentItems: [{ type: 'inputText', text: `Unknown Nuncio runtime tool: ${toolName}` }],
        success: false,
      };
    active.client.respond(request.id, response);
    return true;
  }

  private async resolveProviderRequest(
    sessionId: string,
    active: ActiveCodexSession,
    request: CodexServerRequest,
  ): Promise<ProviderRequestResult> {
    if (active.requestProviderApproval) {
      return active.requestProviderApproval({
        provider: this.id,
        method: request.method,
        ...(request.params !== undefined ? { params: request.params } : {}),
      });
    }

    this.pushEvent(
      sessionId,
      'provider_request',
      {
        requestId: String(request.id),
        provider: this.id,
        method: request.method,
        status: 'pending',
        params: request.params,
      },
      active.currentEmit,
    );
    this.pushEvent(
      sessionId,
      'provider_request_resolved',
      {
        requestId: String(request.id),
        provider: this.id,
        method: request.method,
        status: 'resolved',
        decision: 'deny',
      },
      active.currentEmit,
    );
    return { requestId: String(request.id), decision: 'deny' };
  }

  private completeTurn(
    sessionId: string,
    active: ActiveCodexSession,
    turnId: string,
    status: string,
    errorMessage?: string,
  ): void {
    active.completedTurns.set(turnId, { status, ...(errorMessage ? { errorMessage } : {}) });
    active.activeTurnId = undefined;
    try {
      this.sessions.updateProviderRuntimeState(sessionId, { providerActiveTurnId: null });
    } catch {
      // Session may have been deleted mid-run.
    }

    const completion = active.completions.get(turnId);
    if (!completion) return;
    active.completions.delete(turnId);
    if (status === 'failed') {
      completion.reject(new Error(errorMessage ?? 'Codex turn failed.'));
      return;
    }

    this.pushEvent(
      sessionId,
      'assistant_message',
      { text: active.accumulatedText || '(no response)' },
      active.currentEmit,
    );
    completion.resolve();
  }

  private waitForTurn(sessionId: string, active: ActiveCodexSession, turnId: string): Promise<void> {
    const completed = active.completedTurns.get(turnId);
    if (completed) {
      active.completedTurns.delete(turnId);
      if (active.activeTurnId === turnId) {
        active.activeTurnId = undefined;
        this.sessions.updateProviderRuntimeState(sessionId, { providerActiveTurnId: null });
      }
      if (completed.status === 'failed') {
        return Promise.reject(completed.error ?? new Error(completed.errorMessage ?? 'Codex turn failed.'));
      }
      this.pushEvent(
        sessionId,
        'assistant_message',
        { text: active.accumulatedText || '(no response)' },
        active.currentEmit,
      );
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      active.completions.set(turnId, { resolve, reject });
    });
  }

  private failActiveSession(sessionId: string, active: ActiveCodexSession, error: Error): void {
    this.settleActiveSession(sessionId, active, error);
  }

  private settleActiveSession(sessionId: string, active: ActiveCodexSession, error: Error): void {
    this.activeSessions.delete(sessionId);

    const activeTurnId = active.activeTurnId;
    if (activeTurnId) {
      active.completedTurns.set(activeTurnId, {
        status: 'failed',
        errorMessage: error.message,
        error,
      });
      active.activeTurnId = undefined;
      try {
        this.sessions.updateProviderRuntimeState(sessionId, { providerActiveTurnId: null });
      } catch {
        // Session may have been deleted while the app-server process was active.
      }
    }

    for (const [turnId, completion] of active.completions) {
      active.completions.delete(turnId);
      completion.reject(error);
    }
  }

  private async resolveBinaryPathForRun(): Promise<string> {
    const resolution = await this.resolveCli();
    if (resolution.status === 'ready' && resolution.binaryPath) return resolution.binaryPath;
    throw new Error(resolution.reason);
  }

  private async resolveCli(): Promise<CodexCliResolution> {
    if (this.cachedCli) return this.cachedCli;
    this.cachedCli = await resolveCodexCli({
      configuredPath: this.settings.resolve('NUNCIO_CODEX_BIN')?.trim(),
      candidatePaths: this.cliCandidatePaths,
      env: this.buildCodexEnv(),
      commandRunner: this.commandRunner,
    });
    return this.cachedCli;
  }

  private resolveCwd(context: AgentRunContext): string {
    if (context.runtimePolicy) return mapCodexRuntimePolicy(context.runtimePolicy).workspaceRoot;
    return (
      context.cwd ??
      context.workspace ??
      this.settings.resolve('NUNCIO_CODEX_CWD')?.trim() ??
      process.cwd()
    );
  }

  private buildCodexEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    const codexHome = this.settings.resolve('NUNCIO_CODEX_HOME')?.trim();
    if (codexHome) env.CODEX_HOME = expandHome(codexHome, env);
    return env;
  }

  private runtimeMode(): CodexRuntimeMode {
    return this.settings.resolve('NUNCIO_CODEX_RUNTIME_MODE') === 'approval-required'
      ? 'approval-required'
      : 'full-access';
  }

  private threadRuntimeOverrides(contextPolicy: AgentRunContext['runtimePolicy']) {
    if (contextPolicy) return mapCodexRuntimePolicy(contextPolicy).thread;
    if (this.runtimeMode() === 'approval-required') {
      return { approvalPolicy: 'untrusted', sandbox: 'read-only' };
    }
    return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
  }

  private turnRuntimeOverrides(contextPolicy: AgentRunContext['runtimePolicy']) {
    if (contextPolicy) return mapCodexRuntimePolicy(contextPolicy).turn;
    if (this.runtimeMode() === 'approval-required') {
      return { approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly' } };
    }
    return { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } };
  }

  private resolveModel(model: string | null | undefined): string | undefined {
    if (!model?.trim()) return undefined;
    return model.startsWith('codex:') ? model.slice('codex:'.length) : model;
  }

  private resolveReasoningEffort(options: ModelOptionsMap | null | undefined): string | undefined {
    const value = options?.reasoningEffort ?? options?.reasoning ?? options?.effort;
    return typeof value === 'string' && value.trim() ? value : undefined;
  }

  private resolveServiceTier(options: ModelOptionsMap | null | undefined): string | undefined {
    return options?.fast === true || options?.fastMode === true ? 'fast' : undefined;
  }

  private readThreadId(response: CodexThreadOpenResponse): string | undefined {
    return response.thread?.id ?? response.threadId;
  }

  private readThreadName(response: CodexThreadOpenResponse): string | undefined {
    return asString(response.thread?.name) ?? asString(response.threadName);
  }

  private syncThreadName(
    sessionId: string,
    active: ActiveCodexSession,
    title: string | null | undefined,
    threadId?: string,
    emit?: EventEmitter,
  ): void {
    const trimmed = title?.trim();
    if (!trimmed) return;
    if (threadId && active.codexThreadId && threadId !== active.codexThreadId) return;

    try {
      const current = this.sessions.findById(sessionId);
      if (!current || current.title === trimmed) return;
      const updated = this.sessions.updateTitle(sessionId, trimmed);
      if (!updated) return;
      this.pushEvent(sessionId, 'session_title', { title: updated.title }, emit);
    } catch {
      // The user may have deleted the Nuncio session while the Codex app-server was still active.
    }
  }

  private readTurnId(response: CodexTurnStartResponse): string | undefined {
    return response.turn?.id ?? response.turnId;
  }

  private mapModelList(response: CodexModelListResponse): ModelProviderDto[] {
    const models = (response.data ?? [])
      .filter((model) => model.hidden !== true && (model.id || model.model))
      .map((model) => {
        const id = model.id ?? model.model!;
        const options = this.codexModelOptions(model);
        return {
          id: `codex:${id}`,
          name: model.displayName ?? id,
          sub: model.description ?? 'Codex model',
          ...(model.isDefault ? { badge: 'Default' } : {}),
          ...(options.length > 0 ? { options } : {}),
        };
      });

    if (models.length === 0) return FALLBACK_CODEX_MODELS;
    return [
      {
        id: this.id,
        name: this.name,
        sub: 'Local app-server',
        icon: '◇',
        groups: [
          {
            id: 'openai',
            name: 'OpenAI',
            sub: 'Discovered from codex app-server',
            models,
          },
        ],
      },
    ];
  }

  private codexModelOptions(model: NonNullable<CodexModelListResponse['data']>[number]): ModelOptionDescriptorDto[] {
    return [...this.reasoningOptions(model), ...this.fastOptions(model)];
  }

  private reasoningOptions(model: NonNullable<CodexModelListResponse['data']>[number]): ModelOptionDescriptorDto[] {
    const efforts = this.readReasoningEfforts(model);
    if (efforts.length === 0) return [];
    const defaultValue = model.defaultReasoningEffort ?? model.default_reasoning_effort ?? efforts[0]?.id;
    return [
      {
        id: 'reasoningEffort',
        label: 'Reasoning',
        type: 'select',
        defaultValue,
        options: efforts.map((effort) => ({
          id: effort.id,
          label: codexReasoningEffortLabel(effort.id),
          isDefault: effort.id === defaultValue,
        })),
      },
    ];
  }

  private readReasoningEfforts(
    model: NonNullable<CodexModelListResponse['data']>[number],
  ): Array<{ id: string }> {
    const raw = [
      ...(model.supportedReasoningEfforts ?? []),
      ...(model.supported_reasoning_efforts ?? []),
    ];
    const ids = new Set<string>();
    const out: Array<{ id: string }> = [];
    for (const effort of raw) {
      const id =
        typeof effort === 'string'
          ? effort
          : effort.reasoningEffort ?? effort.reasoning_effort ?? effort.effort ?? effort.id;
      const normalizedId = id?.trim();
      if (!normalizedId || ids.has(normalizedId)) continue;
      ids.add(normalizedId);
      out.push({ id: normalizedId });
    }
    return out;
  }

  private fastOptions(model: NonNullable<CodexModelListResponse['data']>[number]): ModelOptionDescriptorDto[] {
    if (!this.modelSupportsFastMode(model)) return [];
    return [codexFastOption()];
  }

  private modelSupportsFastMode(model: NonNullable<CodexModelListResponse['data']>[number]): boolean {
    const explicit =
      model.supportsFastMode ??
      model.supports_fast_mode ??
      model.fastMode ??
      model.fast_mode ??
      model.fastServiceTier ??
      model.fast_service_tier;
    if (explicit !== undefined) return explicit;

    const tiers = [...(model.additionalSpeedTiers ?? []), ...(model.additional_speed_tiers ?? [])];
    if (tiers.length > 0) return tiers.some((tier) => tier.trim().toLowerCase() === 'fast');

    return true;
  }
}

function defaultCodexModelOptions(): ModelOptionDescriptorDto[] {
  return [
    {
      id: 'reasoningEffort',
      label: 'Reasoning',
      type: 'select',
      defaultValue: DEFAULT_CODEX_REASONING_EFFORT,
      options: DEFAULT_CODEX_REASONING_EFFORTS.map((effort) => ({
        id: effort,
        label: codexReasoningEffortLabel(effort),
        isDefault: effort === DEFAULT_CODEX_REASONING_EFFORT,
      })),
    },
    codexFastOption(),
  ];
}

function codexReasoningEffortLabel(effort: string): string {
  switch (effort.toLowerCase()) {
    case 'low':
      return 'Low';
    case 'medium':
      return 'Medium';
    case 'high':
      return 'High';
    case 'xhigh':
      return 'Extra High';
    case 'max':
      return 'Max';
    case 'ultra':
      return 'Ultra · Multi-agent';
    default:
      return effort;
  }
}

function codexFastOption(): ModelOptionDescriptorDto {
  return {
    id: 'fast',
    label: 'Priority',
    type: 'boolean',
    defaultValue: false,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function codexDynamicToolSurface(runtimeTools: AgentRuntimeTools | undefined): string | undefined {
  const definitions = buildCodexDynamicTools(runtimeTools);
  return definitions
    ? createHash('sha256').update(JSON.stringify(definitions)).digest('hex')
    : undefined;
}
