import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { EventsRepository } from '../../sessions/persistence/events.repository';
import { SessionsRepository } from '../../sessions/persistence/sessions.repository';
import { SettingsService } from '../../settings/settings.service';
import type { ModelOptionsMap } from '../../models/model-options.types';
import type { ModelProviderDto } from '../../models/models.types';
import { AgentRunCancelledError, BaseAgentProvider } from '../agents.base-provider';
import type { AgentRunContext, InteractionResponse } from '../agents.types';
import {
  runtimePolicyKey,
  runtimeToolsForPolicy,
} from '../agent-runtime-policy';
import { appendRuntimeToolInstructions } from '../tools/agent-runtime-tools.types';
import {
  buildClaudeMcpServers,
  CLAUDE_RUNTIME_MCP_SERVER,
  type ClaudeMcpServerConfig,
  type CreateSdkMcpServer,
} from '../tools/claude-runtime-tools.adapter';
import {
  classifyResult,
  createDeltaMappingState,
  mapStreamEvent,
  mapToolResults,
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
  type ClaudeUserContent,
  type ClaudeUserMessage,
  type ClaudeUserResultMessage,
} from './claude-agent.sdk';
import type { AgentAttachment } from '../agents.types';
import { CLAUDE_STATIC_MODELS } from './claude-agent.models';
import { InputQueue } from './claude-agent.input-queue';
import { buildClaudeRuntimePolicyOptions } from './claude-runtime-policy';

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
  /**
   * A SINGLE stable iterator over the query, obtained once and driven with
   * `.next()` across every turn. The SDK `Query` is an AsyncGenerator: a
   * `for await … of query` loop that exits (e.g. on a turn's terminal result)
   * calls `.return()` and finalizes the generator, so a later steer would find
   * a done iterator and produce no output. Holding one iterator and never
   * calling `.return()` on turn-end keeps the query alive for follow-up turns;
   * only dispose (abort) tears it down.
   */
  iterator?: AsyncIterator<ClaudeSdkMessage>;
  input: InputQueue;
  abort: AbortController;
  delta: DeltaMappingState;
  /** Approval callbacks parked awaiting a user decision, keyed by the SDK requestId (dedupe + resolve). */
  pendingApprovals: Map<string, PendingApproval>;
  /**
   * Tools whose `tool_start` fired but whose `tool_result` has not yet arrived,
   * keyed by callId → the (MCP-normalized) tool name emitted at start. Lets
   * `tool_end` echo the same name, and lets a terminal seal any still-open tool
   * so every `tool_start` pairs with a `tool_end`.
   */
  openTools: Map<string, string>;
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
  /**
   * Signature of the runtime toolset the live query was last built with,
   * including execute-closure identity so stable Crew schemas still refresh
   * their turn-scoped authority through `setMcpServers`.
   */
  mcpToolSignature: string;
  runtimePolicyKey: string;
  /** Persisted thread being resumed until its first successful terminal result. */
  resumedThreadId?: string;
}

@Injectable()
export class ClaudeAgentProvider extends BaseAgentProvider implements OnModuleDestroy {
  readonly id = 'claude';
  readonly name = 'Claude';
  readonly capabilities = {
    interrupt: true,
    modelSwitch: 'in-session',
    effortSwitch: 'in-session',
    // Base64 image blocks ride on the user MessageParam content; consumed from
    // context.attachments through the single buildUserMessage builder.
    images: true,
    steerWhileRunning: true,
    runtimePolicies: [
      { filesystem: 'read-only', network: 'disabled' },
      { filesystem: 'workspace-write', network: 'disabled' },
    ],
  } as const;

  private readonly activeSessions = new Map<string, ActiveClaudeSession>();
  private readonly mcpToolInstances = new WeakMap<object, number>();
  private nextMcpToolInstance = 1;
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

  async setModel(
    sessionId: string,
    model: string,
    options?: ModelOptionsMap | null,
  ): Promise<void> {
    const active = this.activeSessions.get(sessionId);
    if (!active) return;
    await active.query.setModel(this.stripPrefix(model));
    // Effort rides the same in-session switch: push a changed effort level to the
    // live query so the next turn honors it without a restart. Model-gated models
    // (Haiku) simply carry no effort option, so nothing is pushed.
    const effort = this.resolveEffort(options);
    if (effort) await this.applyEffort(active, effort);
  }

  /**
   * Push an effort change into a live query. `Settings.effortLevel` does not
   * include `'max'` (only `Options.effort` at query start does), so clamp it to
   * the highest mid-session level rather than sending a value the SDK rejects.
   */
  private async applyEffort(active: ActiveClaudeSession, effort: string): Promise<void> {
    if (!active.query.applyFlagSettings) return;
    const effortLevel = effort === 'max' ? 'xhigh' : effort;
    await active.query.applyFlagSettings({ effortLevel });
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
    const safeContext = this.policySafeContext(context);
    const existing = this.activeSessions.get(sessionId);
    if (existing) {
      if (existing.runtimePolicyKey !== runtimePolicyKey(context.runtimePolicy)) {
        throw new Error('Runtime policy cannot change on an active Claude session.');
      }
      // Follow-up turn on a still-open query (the previous turn completed but
      // the handle persists). This is a normal next turn, NOT a mid-flight
      // redirect — the live-redirect path is steerMidRun with priority 'now'.
      existing.delta = createDeltaMappingState();
      existing.requestProviderApproval = safeContext.requestProviderApproval;
      this.interruptedSessions.delete(sessionId);
      await this.maybeRebuildMcpServers(existing, safeContext);
      existing.input.push(this.buildUserMessage(text, safeContext, false));
      await this.consume(sessionId, existing, safeContext);
      return;
    }

    // A fresh run always starts a normal turn; resume threads through options.
    const active = await this.startSession(sessionId, text, safeContext);
    this.activeSessions.set(sessionId, active);
    await this.consume(sessionId, active, safeContext);
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
    if (active.runtimePolicyKey !== runtimePolicyKey(context.runtimePolicy)) {
      throw new Error('Runtime policy cannot change on an active Claude session.');
    }
    const safeContext = this.policySafeContext(context);
    this.pushEvent(sessionId, 'steer_message', { text: message }, context.emit);
    // priority 'now' cuts the in-flight turn short and redirects; the truncated
    // turn emits its own terminal result that consume() must not treat as the
    // run's end.
    active.pendingRedirects += 1;
    active.input.push(this.buildUserMessage(message, safeContext, true));
    return true;
  }

  supportsInteraction(): boolean {
    return true;
  }

  /**
   * Resolve a parked tool-approval prompt by requestId. The binary approval card
   * (respondProviderRequest) already resolves canUseTool through
   * `requestProviderApproval`; this path handles the richer respond flow (e.g.
   * an "always allow" option).
   *
   * Redelivery-safe: an unknown or already-settled requestId — a response
   * redelivered after the entry settled, or a session that already ended — is a
   * graceful no-op rather than a throw, so a duplicate HTTP respond never bubbles
   * as a 500 through the sessions path.
   */
  async submitInteraction(
    sessionId: string,
    requestId: string,
    response: InteractionResponse,
  ): Promise<void> {
    const active = this.activeSessions.get(sessionId);
    if (!active) return;
    const pending = this.findPendingByRequestId(active, requestId);
    if (!pending) return;
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
    const unset: Array<{ key: string; entry: PendingApproval }> = [];
    for (const [key, entry] of active.pendingApprovals) {
      if (key === requestId || entry.nuncioRequestId === requestId) return { key, entry };
      if (entry.nuncioRequestId === undefined) unset.push({ key, entry });
    }
    // Race: a respond can arrive before the approval hook's promise recorded its
    // nuncio requestId. The requestId matched no key yet, so correlate it to the
    // single live approval whose id is not yet set. With more than one such
    // approval the mapping is ambiguous, so decline rather than guess wrong.
    return unset.length === 1 ? unset[0] : undefined;
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
    const trustedMcpToolNames = (context.tools?.tools ?? []).map(
      (tool) => `mcp__${CLAUDE_RUNTIME_MCP_SERVER}__${tool.name}`,
    );
    const policyOptions = context.runtimePolicy
      ? buildClaudeRuntimePolicyOptions(context.runtimePolicy, trustedMcpToolNames)
      : undefined;

    const active: ActiveClaudeSession = {
      // query is assigned below; declared first so the canUseTool closure can
      // capture the handle and reject its parked callbacks on abort.
      query: undefined as unknown as ClaudeQuery,
      input,
      abort,
      delta: createDeltaMappingState(),
      pendingRedirects: 0,
      pendingApprovals: new Map(),
      openTools: new Map(),
      requestProviderApproval: context.requestProviderApproval,
      mcpToolSignature: this.mcpToolSignature(context),
      runtimePolicyKey: runtimePolicyKey(context.runtimePolicy),
      ...(resume ? { resumedThreadId: resume } : {}),
    };

    const mcpServers = await this.buildMcpServers(context);

    input.push(this.buildUserMessage(text, context, false));

    active.query = this.queryFactory({
      prompt: input,
      options: {
        cwd: policyOptions?.workspaceRoot ?? context.cwd ?? context.workspace ?? process.cwd(),
        includePartialMessages: true,
        // Session behavior is fully determined by nuncio: no ~/.claude plugins,
        // hooks, or CLAUDE.md leak into a nuncio-run session.
        settingSources: [],
        permissionMode: policyOptions?.permissionMode ?? this.resolvePermissionMode(),
        canUseTool: (toolName, toolInput, options) =>
          policyOptions
            ? policyOptions.authorizeTool(toolName, toolInput)
            : this.approveTool(active, toolName, toolInput, options),
        abortController: abort,
        ...(policyOptions ? { tools: policyOptions.tools, hooks: policyOptions.hooks } : {}),
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

  private policySafeContext(context: AgentRunContext): AgentRunContext {
    const tools = runtimeToolsForPolicy(context.runtimePolicy, context.tools);
    return tools === context.tools ? context : { ...context, tools };
  }

  /**
   * MCP servers are baked at query construction, but sessions.service derives
   * `context.tools` per turn — a changed toolset on a follow-up would otherwise
   * be silently ignored. Compare the derived toolset signature against the one
   * the live query was last built with; when it differs, rebuild the servers and
   * push them through `setMcpServers`. A query without `setMcpServers` support
   * (a fake/older SDK) is skipped gracefully. The signature is always refreshed
   * so a later turn compares against the currently-live toolset.
   */
  private async maybeRebuildMcpServers(
    active: ActiveClaudeSession,
    context: AgentRunContext,
  ): Promise<void> {
    const signature = this.mcpToolSignature(context);
    if (signature === active.mcpToolSignature) return;
    active.mcpToolSignature = signature;
    if (!active.query.setMcpServers) return;
    const servers = (await this.buildMcpServers(context)) ?? {};
    await active.query.setMcpServers(servers);
  }

  /**
   * A signature of each advertised definition plus its execute closure. Crew
   * schemas stay stable across revisions, but their closures carry turn-scoped
   * authority; treating a new closure as a changed MCP server prevents a resumed
   * query from executing the prior turn's authority.
   */
  private mcpToolSignature(context: AgentRunContext): string {
    const tools = context.tools?.tools ?? [];
    return JSON.stringify(
      tools.map((tool) => [
        tool.name,
        tool.inputSchema ?? {},
        this.mcpToolInstance(tool.execute),
      ]),
    );
  }

  private mcpToolInstance(execute: object): number {
    const existing = this.mcpToolInstances.get(execute);
    if (existing !== undefined) return existing;
    const created = this.nextMcpToolInstance++;
    this.mcpToolInstances.set(execute, created);
    return created;
  }

  /**
   * Drain the SDK message stream for one turn, mapping each message to nuncio
   * events. Drives ONE persistent iterator with `.next()` so exiting on a turn's
   * terminal result never finalizes the generator (a `for await` loop would call
   * `.return()` on break and kill the query for later steers). The iterator is
   * created once per session and reused across every turn; only dispose tears it
   * down via the abort controller.
   */
  private async consume(
    sessionId: string,
    active: ActiveClaudeSession,
    context: AgentRunContext,
  ): Promise<void> {
    active.iterator ??= active.query[Symbol.asyncIterator]();
    const iterator = active.iterator;
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) return;
        if (this.handleMessage(sessionId, active, next.value, context)) return;
      }
    } catch (error) {
      if (this.interruptedSessions.delete(sessionId)) return;
      // An abort (dispose mid-run) makes the generator throw — treat as a cancel,
      // not an error, so the shared error path does not land ERROR.
      if (active.abort.signal.aborted) throw new AgentRunCancelledError('Claude session disposed.');
      if (active.resumedThreadId) this.invalidateResumedThread(sessionId, active);
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
        // Remember every started tool by callId so its result can pair a
        // tool_end under the same (normalized) name a later block references.
        if (mapped.type === 'tool_start') {
          const callId = mapped.payload.callId as string;
          active.openTools.set(callId, mapped.payload.tool as string);
        }
        this.pushEvent(sessionId, mapped.type, mapped.payload, context.emit);
        if (mapped.type === 'assistant_delta') this.touchPreview(sessionId, active.delta.accumulatedText);
      }
      return false;
    }

    if (message.type === 'user') {
      this.emitToolEnds(sessionId, active, message, context);
      return false;
    }

    if (message.type === 'result') {
      return this.handleResult(sessionId, active, message, context);
    }

    // assistant frames, task notifications, api_retry, status, … carry no
    // additional user-facing event beyond the deltas + terminal result.
    return false;
  }

  /**
   * Emit a `tool_end` for each `tool_result` block on a user message. Each block
   * pairs back to a `tool_start` by callId; the name is read from openTools so it
   * matches the normalized name shown at start (falling back to a bare 'tool'
   * for a result we never saw a start for). A non-tool-result user frame yields
   * nothing.
   */
  private emitToolEnds(
    sessionId: string,
    active: ActiveClaudeSession,
    message: ClaudeUserResultMessage,
    context: AgentRunContext,
  ): void {
    for (const end of mapToolResults(message)) {
      const tool = active.openTools.get(end.callId) ?? 'tool';
      active.openTools.delete(end.callId);
      this.pushEvent(
        sessionId,
        'tool_end',
        {
          callId: end.callId,
          tool,
          isError: end.isError,
          ...(end.output !== undefined ? { output: end.output } : {}),
        },
        context.emit,
      );
    }
  }

  /**
   * Close any tool whose start fired but whose result never arrived (a turn that
   * ended — success, interrupt, or error — with a tool still open). Sealing keeps
   * the transcript invariant that every tool_start pairs with a tool_end.
   */
  private sealOpenTools(sessionId: string, active: ActiveClaudeSession, context: AgentRunContext): void {
    for (const [callId, tool] of active.openTools) {
      this.pushEvent(sessionId, 'tool_end', { callId, tool, isError: false }, context.emit);
    }
    active.openTools.clear();
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
      this.sealOpenTools(sessionId, active, context);
      this.pushEvent(sessionId, 'interrupted', {}, context.emit);
      return true;
    }

    if (active.pendingRedirects > 0) {
      // This is the truncated turn a live steer cut short: consume it silently
      // (the fresh redirected turn still follows and carries the real terminal).
      // Any tool the redirect aborted mid-flight never gets a result, so seal it
      // now rather than leaving a dangling tool_start. Clamp at zero so an
      // unexpected extra result never drives the counter negative.
      active.pendingRedirects = Math.max(0, active.pendingRedirects - 1);
      this.sealOpenTools(sessionId, active, context);
      return false;
    }

    if (classified.kind === 'cannot-resume') {
      // The stored thread cannot be resumed (workspace moved / session evicted);
      // drop the handle so a fresh run starts clean, then surface a clear error.
      this.sealOpenTools(sessionId, active, context);
      this.invalidateResumedThread(sessionId, active);
      this.dropHandle(sessionId, active);
      throw new Error(`Cannot resume Claude session: ${classified.message}`);
    }

    if (classified.kind === 'error') {
      this.sealOpenTools(sessionId, active, context);
      throw new Error(classified.message);
    }

    this.sealOpenTools(sessionId, active, context);
    active.resumedThreadId = undefined;
    this.pushEvent(
      sessionId,
      'assistant_message',
      { text: classified.text || '(no response)' },
      context.emit,
    );
    return true;
  }

  private invalidateResumedThread(sessionId: string, active: ActiveClaudeSession): void {
    active.resumedThreadId = undefined;
    this.sessions.updateProviderRuntimeState(sessionId, {
      providerThreadId: null,
      providerActiveTurnId: null,
    });
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
    const prompt = appendRuntimeToolInstructions(text, context.tools);
    return {
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: this.buildContent(prompt, context.attachments) },
      ...(isSteer ? { priority: 'now' as const } : {}),
    };
  }

  /**
   * Build the user MessageParam content. With no image attachments the content
   * is the bare prompt string (the simple, common path). With images it becomes
   * a blocks array: the text prompt followed by one base64 image block per image
   * attachment. Non-image attachment kinds are ignored gracefully.
   */
  private buildContent(text: string, attachments?: AgentAttachment[]): ClaudeUserContent {
    const images = (attachments ?? []).filter((attachment) => attachment.kind === 'image');
    if (images.length === 0) return text;
    return [
      { type: 'text', text },
      ...images.map((image) => ({
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: image.mimeType, data: image.data },
      })),
    ];
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

  /** Read the configured permission-mode setting fresh each run; unknown values fall back to the default. */
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
