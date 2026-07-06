import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { EventsRepository } from '../../sessions/persistence/events.repository';
import { SessionsRepository } from '../../sessions/persistence/sessions.repository';
import { SettingsService } from '../../settings/settings.service';
import type { ModelOptionsMap } from '../../models/model-options.types';
import type { ModelProviderDto } from '../../models/models.types';
import { AgentRunCancelledError, BaseAgentProvider } from '../agents.base-provider';
import type { AgentRunContext, InteractionResponse } from '../agents.types';
import { appendRuntimeToolInstructions } from '../tools/agent-runtime-tools.types';
import {
  buildClaudeMcpServers,
  type ClaudeMcpServerConfig,
  type CreateSdkMcpServer,
} from '../tools/claude-runtime-tools.adapter';
import {
  classifyResult,
  createDeltaMappingState,
  mapStreamEvent,
  type DeltaMappingState,
} from './claude-agent.helpers';
import {
  buildApprovalRequest,
  decisionToPermissionResult,
  denyResult,
  interactionToDecision,
  type ClaudePermissionResult,
} from './claude-agent.permissions';
import {
  expandHome,
  findBundledClaudeBinary,
  resolveClaudeCli,
  type ClaudeCliCommandRunner,
  type ClaudeCliResolution,
} from './claude-cli-resolver';
import {
  buildClaudeQueryFactory,
  loadCreateSdkMcpServer,
  type ClaudeCanUseToolOptions,
  type ClaudeMcpServer,
  type ClaudePermissionMode,
  type ClaudeQuery,
  type ClaudeQueryFactory,
  type ClaudeResultMessage,
  type ClaudeSdkMessage,
  type ClaudeUserMessage,
} from './claude-agent.sdk';
import { CLAUDE_STATIC_MODELS } from './claude-agent.models';
import { InputQueue } from './claude-agent.input-queue';

const CLAUDE_MODEL_PREFIX = 'claude:';
const DEFAULT_PERMISSION_MODE: ClaudePermissionMode = 'acceptEdits';
const VALID_PERMISSION_MODES: ReadonlySet<ClaudePermissionMode> = new Set([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
]);

/** A tool-approval callback parked while the user decides, keyed by the SDK's requestId. */
interface PendingApproval {
  /** The promise the SDK callback awaits — reused when the same requestId is redelivered. */
  promise: Promise<ClaudePermissionResult>;
  /** Resolve the SDK callback with an allow/deny PermissionResult. */
  settle: (result: ClaudePermissionResult) => void;
  /** The nuncio approval requestId (once the card exists), so submitInteraction can match it. */
  nuncioRequestId?: string;
  /** The SDK callback options — carries `suggestions` for the always-allow round-trip. */
  options: ClaudeCanUseToolOptions;
  /** The tool's (possibly updated) input, echoed back on allow. */
  input: Record<string, unknown>;
}

interface ActiveClaudeSession {
  query: ClaudeQuery;
  input: InputQueue;
  abort: AbortController;
  delta: DeltaMappingState;
  /** Approval callbacks parked awaiting a user decision, keyed by the SDK requestId (dedupe + resolve). */
  pendingApprovals: Map<string, PendingApproval>;
  /** The approval hook from the run context, captured per session for canUseTool. */
  requestProviderApproval?: AgentRunContext['requestProviderApproval'];
  /**
   * Number of live `priority:'now'` steers awaiting their truncated terminal.
   * Each such steer cuts the in-flight turn short with its own `result`; that
   * result is a redirect, not the run's terminal, so `consume` must swallow one
   * `result` per pending steer and keep draining until the redirect's fresh turn
   * produces the real terminal result.
   */
  pendingRedirects: number;
}

@Injectable()
export class ClaudeAgentProvider extends BaseAgentProvider implements OnModuleDestroy {
  readonly id = 'claude';
  readonly name = 'Claude';
  readonly capabilities = {
    interrupt: true,
    modelSwitch: 'in-session',
    effortSwitch: 'in-session',
    // Flips to true in a later phase once attachments are wired; message
    // construction already routes through a single builder so that is a small
    // change, not a rewrite.
    images: false,
    steerWhileRunning: true,
  } as const;

  private readonly activeSessions = new Map<string, ActiveClaudeSession>();
  /** Sessions whose current run was interrupted — the terminal result is a clean stop, not an error. */
  private readonly interruptedSessions = new Set<string>();
  private cachedAvailable?: boolean;
  private cachedCli?: ClaudeCliResolution;

  /** Test hook: inject a fake `query` factory (constructor-injected, no module mock). */
  queryFactory: ClaudeQueryFactory = buildClaudeQueryFactory();

  /** Test hook: build the in-process MCP server without importing the real SDK. */
  createSdkMcpServer?: CreateSdkMcpServer;

  /** Test hook: replace process execution for the availability probe. */
  commandRunner: ClaudeCliCommandRunner = (command, args, options) =>
    new Promise((resolve) => {
      const child = spawn(command, args, { env: options.env });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk) => (stdout += chunk));
      child.stderr?.on('data', (chunk) => (stderr += chunk));
      child.on('error', (error) => resolve({ status: null, stdout, stderr: stderr || error.message }));
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });

  /** Test hook: supply the bundled binary path without scanning node_modules. */
  bundledBinaryPath?: string | null;

  constructor(
    sessions: SessionsRepository,
    events: EventsRepository,
    private readonly settings: SettingsService,
  ) {
    super(sessions, events);
  }

  async isAvailable(): Promise<boolean> {
    if (this.cachedAvailable !== undefined) return this.cachedAvailable;
    if (this.resolveApiKey()) {
      this.cachedAvailable = true;
      return true;
    }
    const resolution = await this.resolveCli();
    this.cachedAvailable = resolution.loggedIn;
    return this.cachedAvailable;
  }

  bustCache(): void {
    this.cachedAvailable = undefined;
    this.cachedCli = undefined;
  }

  /** Claude session JSONL survives daemon restarts; a stored session_id resumes cwd-scoped. */
  canResumeThread(session: { providerThreadId: string | null }): boolean {
    return typeof session.providerThreadId === 'string' && session.providerThreadId.length > 0;
  }

  async listModels(): Promise<ModelProviderDto[]> {
    if (!(await this.isAvailable())) return [];
    return CLAUDE_STATIC_MODELS;
  }

  onModuleDestroy(): void {
    for (const sessionId of [...this.activeSessions.keys()]) this.dispose(sessionId);
  }

  async interrupt(sessionId: string): Promise<void> {
    const active = this.activeSessions.get(sessionId);
    if (!active) return;
    this.interruptedSessions.add(sessionId);
    // An interrupt ends the current turn; any tool it parked for approval will
    // not run, so deny those prompts rather than leaving stale approval cards.
    this.denyAllPending(active);
    try {
      await active.query.interrupt();
    } catch (error) {
      this.interruptedSessions.delete(sessionId);
      throw error;
    }
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    const active = this.activeSessions.get(sessionId);
    if (!active) return;
    await active.query.setModel(this.stripPrefix(model));
  }

  dispose(sessionId: string): void {
    const active = this.activeSessions.get(sessionId);
    if (!active) return;
    this.activeSessions.delete(sessionId);
    this.interruptedSessions.delete(sessionId);
    this.flushDeltas(sessionId);
    // A completed turn leaves the SDK-spawned CLI subprocess resident; aborting
    // is the only reliable teardown — it kills the child and unblocks the
    // in-flight generator. Closing the input queue alone does not reap it.
    try {
      active.abort.abort();
    } catch {
      // Already aborted / generator gone.
    }
    active.input.close();
  }

  protected async executePrompt(
    sessionId: string,
    text: string,
    isSteer: boolean,
    context: AgentRunContext,
  ): Promise<void> {
    const existing = this.activeSessions.get(sessionId);
    if (existing) {
      // Follow-up turn on a still-open query (the previous turn completed but
      // the handle persists). This is a normal next turn, NOT a mid-flight
      // redirect — the live-redirect path is steerMidRun with priority 'now'.
      existing.delta = createDeltaMappingState();
      existing.requestProviderApproval = context.requestProviderApproval;
      this.interruptedSessions.delete(sessionId);
      existing.input.push(this.buildUserMessage(text, context, false));
      await this.consume(sessionId, existing, context);
      return;
    }

    // A fresh run always starts a normal turn; resume threads through options.
    const active = await this.startSession(sessionId, text, context);
    this.activeSessions.set(sessionId, active);
    await this.consume(sessionId, active, context);
  }

  /**
   * Steer a run that is already streaming without recreating the query. Returns
   * false when there is no live handle so the caller falls back to a fresh run.
   */
  async steerMidRun(
    sessionId: string,
    message: string,
    context: AgentRunContext,
  ): Promise<boolean> {
    const active = this.activeSessions.get(sessionId);
    if (!active) return false;
    this.pushEvent(sessionId, 'steer_message', { text: message }, context.emit);
    // priority 'now' cuts the in-flight turn short and redirects; the truncated
    // turn emits its own terminal result that consume() must not treat as the
    // run's end.
    active.pendingRedirects += 1;
    active.input.push(this.buildUserMessage(message, context, true));
    return true;
  }

  supportsInteraction(): boolean {
    return true;
  }

  /**
   * Resolve a parked tool-approval prompt by requestId. The binary approval card
   * (respondProviderRequest) already resolves canUseTool through
   * `requestProviderApproval`; this path handles the richer respond flow (e.g.
   * an "always allow" option). Idempotent: a redelivered or already-resolved id
   * is a no-op rather than a throw once the pending entry is gone.
   */
  async submitInteraction(
    sessionId: string,
    requestId: string,
    response: InteractionResponse,
  ): Promise<void> {
    const active = this.activeSessions.get(sessionId);
    const pending = active ? this.findPendingByRequestId(active, requestId) : undefined;
    if (!active || !pending) {
      throw new Error(`No pending Claude approval ${requestId}`);
    }
    const { decision, alwaysAllow } = interactionToDecision(response);
    this.settlePending(active, pending.key, decisionToPermissionResult(decision, pending.entry.input, pending.entry.options, alwaysAllow));
  }

  /**
   * The SDK permission callback. Routes through the session's approval hook so
   * the existing pending-approval card renders, maps the decision back to a
   * PermissionResult, and fails closed on abort or a missing hook. Deduped by the
   * SDK requestId so a redelivered control_request reuses the in-flight promise.
   */
  private approveTool(
    active: ActiveClaudeSession,
    toolName: string,
    input: Record<string, unknown>,
    options: ClaudeCanUseToolOptions,
  ): Promise<ClaudePermissionResult> {
    if (active.abort.signal.aborted) return Promise.resolve(denyResult());

    const existing = active.pendingApprovals.get(options.requestId);
    if (existing) return existing.promise;

    const hook = active.requestProviderApproval;
    if (!hook) {
      // Fail closed: no channel to ask the user means we must not silently allow.
      return Promise.resolve(denyResult('No approval channel available.'));
    }

    let settle!: (result: ClaudePermissionResult) => void;
    const promise = new Promise<ClaudePermissionResult>((resolve) => {
      settle = resolve;
    });
    const pending: PendingApproval = { promise, settle, options, input };
    active.pendingApprovals.set(options.requestId, pending);

    void hook(buildApprovalRequest(this.id, toolName, input, options))
      .then((result) => {
        pending.nuncioRequestId = result.requestId;
        // If submitInteraction already settled this (always-allow), the entry is
        // gone; only the binary card decision reaches here for a still-pending one.
        if (active.pendingApprovals.has(options.requestId)) {
          this.settlePending(active, options.requestId, decisionToPermissionResult(result.decision, input, options));
        }
      })
      .catch(() => this.settlePending(active, options.requestId, denyResult('Approval request failed.')));

    return promise;
  }

  private settlePending(
    active: ActiveClaudeSession,
    requestId: string,
    result: ClaudePermissionResult,
  ): void {
    const pending = active.pendingApprovals.get(requestId);
    if (!pending) return;
    active.pendingApprovals.delete(requestId);
    pending.settle(result);
  }

  private denyAllPending(active: ActiveClaudeSession): void {
    for (const requestId of [...active.pendingApprovals.keys()]) {
      this.settlePending(active, requestId, denyResult('Session disposed.'));
    }
  }

  private findPendingByRequestId(
    active: ActiveClaudeSession,
    requestId: string,
  ): { key: string; entry: PendingApproval } | undefined {
    for (const [key, entry] of active.pendingApprovals) {
      if (key === requestId || entry.nuncioRequestId === requestId) return { key, entry };
    }
    return undefined;
  }

  private async startSession(
    sessionId: string,
    text: string,
    context: AgentRunContext,
  ): Promise<ActiveClaudeSession> {
    const input = new InputQueue();
    const abort = new AbortController();
    const session = this.sessions.findById(sessionId);
    const resume = session?.providerThreadId?.trim() || undefined;
    const model = this.stripPrefix(context.model);
    const apiKey = this.resolveApiKey();
    const effort = this.resolveEffort(context.modelOptions);
    const appendSystemPrompt = context.tools?.systemPromptAppend?.trim() || undefined;

    const active: ActiveClaudeSession = {
      // query is assigned below; declared first so the canUseTool closure can
      // capture the handle and reject its parked callbacks on abort.
      query: undefined as unknown as ClaudeQuery,
      input,
      abort,
      delta: createDeltaMappingState(),
      pendingRedirects: 0,
      pendingApprovals: new Map(),
      requestProviderApproval: context.requestProviderApproval,
    };

    const mcpServers = await this.buildMcpServers(context);

    input.push(this.buildUserMessage(text, context, false));

    active.query = this.queryFactory({
      prompt: input,
      options: {
        cwd: context.cwd ?? context.workspace ?? process.cwd(),
        includePartialMessages: true,
        // Session behavior is fully determined by nuncio: no ~/.claude plugins,
        // hooks, or CLAUDE.md leak into a nuncio-run session.
        settingSources: [],
        permissionMode: this.resolvePermissionMode(),
        canUseTool: (toolName, toolInput, options) =>
          this.approveTool(active, toolName, toolInput, options),
        abortController: abort,
        ...(model ? { model } : {}),
        ...(resume ? { resume } : {}),
        ...(effort ? { effort } : {}),
        ...(mcpServers ? { mcpServers } : {}),
        ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
        // The subscription keychain ride needs no env; only pass the API key
        // when one is explicitly configured (the distribution path).
        ...(apiKey ? { env: { ...process.env, ANTHROPIC_API_KEY: apiKey } } : {}),
        ...(this.claudeBinaryPath() ? { pathToClaudeCodeExecutable: this.claudeBinaryPath() } : {}),
      },
    });

    // Fail-closed: an abort (dispose/interrupt) denies every parked callback so a
    // killed session never leaves a tool prompt hanging.
    abort.signal.addEventListener('abort', () => this.denyAllPending(active), { once: true });

    return active;
  }

  private async buildMcpServers(
    context: AgentRunContext,
  ): Promise<Record<string, ClaudeMcpServer> | undefined> {
    if (!context.tools?.tools?.length) return undefined;
    const create = this.createSdkMcpServer ?? (await loadCreateSdkMcpServer());
    const servers = buildClaudeMcpServers(create, context.tools);
    return servers as Record<string, ClaudeMcpServer> | undefined;
  }

  /** Drain the SDK message stream for one turn, mapping each message to nuncio events. */
  private async consume(
    sessionId: string,
    active: ActiveClaudeSession,
    context: AgentRunContext,
  ): Promise<void> {
    try {
      for await (const message of active.query) {
        if (this.handleMessage(sessionId, active, message, context)) return;
      }
    } catch (error) {
      if (this.interruptedSessions.delete(sessionId)) return;
      // An abort (dispose mid-run) makes the generator throw — treat as a cancel,
      // not an error, so the shared error path does not land ERROR.
      if (active.abort.signal.aborted) throw new AgentRunCancelledError('Claude session disposed.');
      throw error;
    }
  }

  /** Returns true when the turn reached its terminal result (stop consuming). */
  private handleMessage(
    sessionId: string,
    active: ActiveClaudeSession,
    message: ClaudeSdkMessage,
    context: AgentRunContext,
  ): boolean {
    if (message.type === 'system' && message.subtype === 'init') {
      this.persistThreadId(sessionId, message.session_id);
      return false;
    }

    if (message.type === 'stream_event') {
      const mapped = mapStreamEvent(message, active.delta, (accumulated) =>
        this.paragraphBoundary(accumulated),
      );
      if (mapped) {
        this.pushEvent(sessionId, mapped.type, mapped.payload, context.emit);
        if (mapped.type === 'assistant_delta') this.touchPreview(sessionId, active.delta.accumulatedText);
      }
      return false;
    }

    if (message.type === 'result') {
      return this.handleResult(sessionId, active, message, context);
    }

    // assistant/user frames, task notifications, api_retry, status, … carry no
    // additional user-facing event beyond the deltas + terminal result.
    return false;
  }

  private handleResult(
    sessionId: string,
    active: ActiveClaudeSession,
    message: ClaudeResultMessage,
    context: AgentRunContext,
  ): boolean {
    const wasInterrupted = this.interruptedSessions.delete(sessionId);
    const classified = classifyResult(message, active.delta.accumulatedText);

    if (wasInterrupted || classified.kind === 'interrupted') {
      // Clean stop — the query stays usable for the next prompt; the session
      // lands IDLE via the base lifecycle, not ERROR. An explicit interrupt
      // wins over a pending redirect (the user asked to stop).
      active.pendingRedirects = 0;
      this.pushEvent(sessionId, 'interrupted', {}, context.emit);
      return true;
    }

    if (active.pendingRedirects > 0) {
      // This is the truncated turn a live steer cut short: consume it silently
      // (the fresh redirected turn still follows and carries the real terminal).
      active.pendingRedirects -= 1;
      return false;
    }

    if (classified.kind === 'cannot-resume') {
      // The stored thread cannot be resumed (workspace moved / session evicted);
      // drop the handle so a fresh run starts clean, then surface a clear error.
      this.dropHandle(sessionId, active);
      throw new Error(`Cannot resume Claude session: ${classified.message}`);
    }

    if (classified.kind === 'error') {
      throw new Error(classified.message);
    }

    this.pushEvent(
      sessionId,
      'assistant_message',
      { text: classified.text || '(no response)' },
      context.emit,
    );
    return true;
  }

  /**
   * Drop a live handle after its turn already reached a terminal result. The
   * abort (which reaps the resident CLI subprocess) is deferred to a later tick:
   * firing it synchronously would flag `signal.aborted` before the error we are
   * about to throw unwinds, and `consume` would then misread that error as a
   * dispose-cancel instead of surfacing it.
   */
  private dropHandle(sessionId: string, active: ActiveClaudeSession): void {
    this.activeSessions.delete(sessionId);
    active.input.close();
    setTimeout(() => {
      try {
        active.abort.abort();
      } catch {
        /* generator already gone */
      }
    }, 0);
  }

  private persistThreadId(sessionId: string, threadId: string | undefined): void {
    if (!threadId) return;
    try {
      const current = this.sessions.findById(sessionId);
      if (current && current.providerThreadId === threadId) return;
      this.sessions.updateProviderRuntimeState(sessionId, { providerThreadId: threadId });
    } catch {
      // The session row may have been deleted mid-run.
    }
  }

  private buildUserMessage(
    text: string,
    context: AgentRunContext,
    isSteer: boolean,
  ): ClaudeUserMessage {
    // Steers into a live turn redirect immediately; a plain prompt runs normally.
    // Attachments (images) hang off this single builder in a later phase.
    return {
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: appendRuntimeToolInstructions(text, context.tools) },
      ...(isSteer ? { priority: 'now' as const } : {}),
    };
  }

  private async resolveCli(): Promise<ClaudeCliResolution> {
    if (this.cachedCli) return this.cachedCli;
    this.cachedCli = await resolveClaudeCli({
      configuredPath: this.configuredBinaryPath(),
      commandRunner: this.commandRunner,
      env: process.env,
      bundledBinaryPath: this.bundledBinaryPath,
    });
    return this.cachedCli;
  }

  private configuredBinaryPath(): string | undefined {
    return this.settings.resolve('NUNCIO_CLAUDE_BIN')?.trim() || undefined;
  }

  /** Absolute CLI path for the SDK to spawn: configured override, else the SDK-bundled binary. */
  private claudeBinaryPath(): string | undefined {
    const configured = this.configuredBinaryPath();
    if (configured) return expandHome(configured, process.env);
    if (this.bundledBinaryPath !== undefined) return this.bundledBinaryPath ?? undefined;
    return findBundledClaudeBinary(process.env) ?? undefined;
  }

  private resolveApiKey(): string | undefined {
    return this.settings.resolve('ANTHROPIC_API_KEY')?.trim() || undefined;
  }

  /** Read the founder permission-mode setting fresh each run; an unknown value falls back to the default. */
  private resolvePermissionMode(): ClaudePermissionMode {
    const value = this.settings.resolve('NUNCIO_CLAUDE_PERMISSION_MODE')?.trim();
    return value && VALID_PERMISSION_MODES.has(value as ClaudePermissionMode)
      ? (value as ClaudePermissionMode)
      : DEFAULT_PERMISSION_MODE;
  }

  private resolveEffort(options: ModelOptionsMap | null | undefined): string | undefined {
    const value = options?.effort ?? options?.reasoningEffort ?? options?.reasoning;
    return typeof value === 'string' && value.trim() ? value : undefined;
  }

  private stripPrefix(model: string | null | undefined): string | undefined {
    const trimmed = model?.trim();
    if (!trimmed) return undefined;
    return trimmed.startsWith(CLAUDE_MODEL_PREFIX)
      ? trimmed.slice(CLAUDE_MODEL_PREFIX.length)
      : trimmed;
  }
}
