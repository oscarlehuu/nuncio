import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { EventEmitter } from 'events';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { AgentRegistry } from '../agents/agents.registry';
import { RetainedEventFlushError } from '../agents/agents.base-provider';
import {
  assertRuntimePolicyCapabilitySupported,
  assertRuntimePolicySupported,
  runtimeToolsForPolicy,
} from '../agents/agent-runtime-policy';
import type {
  AgentAttachment,
  AgentProvider,
  AgentRunContext,
  AgentRuntimePolicy,
} from '../agents/agents.types';
import { AgentToolRegistry } from '../agents/tools/agent-tool-registry';
import {
  buildAgentRuntimeEnvironment,
  createNuncioRuntimeInfoTool,
} from '../agents/runtime-environment';
import { decodeNuncioTransportUserText } from '../agents/runtime-user-prompt';
import { MediaStore } from './media.store';
import { CursorLocalSessionsService } from '../cursor-local/cursor-local-sessions.service';
import { turnsToSessionEvents } from '../cursor-local/cursor-transcript-hydrate';
import { readCursorChatMetadata } from '../cursor-local/cursor-chat-store';
import { ContextFactsService } from '../context/context-facts.service';
import { DatabaseService } from '../db/database.service';
import { EvidenceCaptureService } from '../evidence/evidence-capture.service';
import { renderContextFacts } from '../context/context-facts.renderer';
import { materializeContextFile } from '../context/context-file.materializer';
import { GitService } from '../git/git.service';
import type { ModelOptionsMap } from '../models/model-options.types';
import { renderEventsSince } from '../context/events-compactor';
import { renderHandoffBrief } from '../orchestration/handoff-brief.renderer';
import type { HandoffBrief } from '../orchestration/handoff-brief.types';
import { composeSessionPreamble } from '../orchestration/session-preamble';
import { buildWorkspaceSnapshot } from '../orchestration/workspace-snapshot';
import {
  buildSessionWorkspaceContext,
  renderWorkspaceContext,
} from '../orchestration/session-workspace-context';
import { PromptProfileService } from '../prompts/prompt-profile.service';
import { PiLocalSessionsService } from '../pi-local/pi-local-sessions.service';
import { canTransition } from './domain/sessions.fsm';
import { assertModeSupported } from './domain/session-modes';
import type { MultitaskCoordinator } from './domain/multitask-coordinator.types';
import type { SpawnTaskEventHandler } from '../chips/chips.types';
import type { ReproduceEventHandler } from '../reproduce/reproduce.types';
import { deriveHasPendingInput } from './domain/derive-pending-input';
import type { SessionEventType } from './domain/events.types';
import type {
  CreateSessionDto,
  ContinueExistingSessionDto,
  HandoffSessionDto,
  HandoffToProviderDto,
  ProviderRequestDecision,
  ProviderRequestInput,
  ProviderRequestResult,
  RespondInteractionDto,
  SessionDto,
  SessionEvent,
  SessionLineageDto,
  SessionRefDto,
  SessionStatus,
} from './domain/sessions.types';
import { isCursorCliRecentlyActive } from '../agents/providers/cursor-cli.active-run';
import { EventsRepository } from './persistence/events.repository';
import { ProviderRequestsRepository } from './persistence/provider-requests.repository';
import { SessionsRepository } from './persistence/sessions.repository';
import { SteerQueueRepository } from './persistence/steer-queue.repository';
import {
  resolveVerifyCommand,
  runVerifyCommand,
  VERIFY_TIMEOUT_MS,
} from './session-verifier';
import {
  buildFeedbackMessage,
  decideNextStep,
  foldLoopState,
  latestGreenVerifyPin,
  parseAutoSteerEnabled,
  parseMaxRounds,
  type VerifyResultPayload,
} from './verify-feedback';
import { captureWorkspaceDiffSnapshot } from './diff/turn-diff-classifier';
import { SettingsService } from '../settings/settings.service';
import { ProjectDefaultsResolver } from '../projects/project-defaults-resolver';
import { McpService } from '../mcp/mcp.service';
import {
  buildCodexMcpSuppressionConfig,
  listInheritedCodexMcpServerNames,
} from '../mcp/import/codex-inherited-mcp';

type StreamListener = (event: SessionEvent) => void;

const DEFAULT_BACKFILL_LIMIT = 200;

class PermanentLifecycleCleanupError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'PermanentLifecycleCleanupError';
  }
}

/** Trailing events scanned to decide whether a run is blocked on your input. */
const PENDING_SCAN_TAIL = 200;
const DEFAULT_STALLED_RUN_FORCE_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_DELETE_RETRY_WAIT_MS = 5_000;

/** Ancestor walk depth cap — bounds cost and survives a manufactured cycle. */
const ANCESTOR_WALK_CAP = 10;
// Cross-engine handoff: the compacted source timeline rides the new session's
// preamble under a 32 KB byte budget (renderEventsSince evicts oldest-first),
// reading at most this many trailing events.
const HANDOFF_HISTORY_EVENT_LIMIT = 2000;
const HANDOFF_HISTORY_BUDGET_BYTES = 32 * 1024;
const HANDOFF_CONTINUE_PROMPT =
  'Continue this task from where the previous engine left off. The handoff context above has the goal, workspace state, and a compacted timeline of the work so far — verify the current state of the working tree before making changes, then proceed.';

function toSessionRef(session: SessionDto): SessionRefDto {
  return { id: session.id, title: session.title, status: session.status, provider: session.provider };
}

function resolveStalledRunForceIdleMs(): number {
  const raw = process.env.NUNCIO_STALLED_RUN_FORCE_IDLE_MS;
  if (!raw) return DEFAULT_STALLED_RUN_FORCE_IDLE_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_STALLED_RUN_FORCE_IDLE_MS;
}

interface PendingProviderRequest {
  sessionId: string;
  provider: string;
  method: string;
  params?: unknown;
  resolve: (result: ProviderRequestResult) => void;
}

interface PendingOrchestrationEvent {
  type: SessionEventType;
  payload: unknown;
}

interface LifecycleRetry {
  cancelled: boolean;
  promise: Promise<void>;
  failure?: unknown;
}

interface CrewStartAttempt {
  cancelled: boolean;
}

@Injectable()
export class SessionsService implements OnModuleDestroy {
  private readonly streams = new Map<string, EventEmitter>();
  private readonly providerRequests = new Map<string, PendingProviderRequest>();
  private readonly transcriptMtimeCache = new Map<string, number>();
  private readonly locallyProducing = new Set<string>();
  private readonly verifying = new Set<string>();
  private readonly runPromises = new Map<string, Promise<void>>();
  private readonly startingSteers = new Set<string>();
  private readonly crewStartAttempts = new Map<string, Set<CrewStartAttempt>>();
  private readonly crewQuiesceCounts = new Map<string, number>();
  private readonly drainingSteerQueues = new Set<string>();
  // A multitask parent's coordinating turn runs here instead of a provider turn.
  // Registered by TasksModule at boot (the session layer never imports Tasks).
  private multitaskCoordinator: MultitaskCoordinator | null = null;
  private chipHandler: SpawnTaskEventHandler | null = null;
  private reproduceHandler: ReproduceEventHandler | null = null;
  // Verify-feedback loop settlement: resolves when the loop reaches a terminal
  // state (green verify / needs-attention / no-command). Task-lane consumers
  // await this instead of a bare awaitRun so they wait for the whole loop.
  private readonly verifySettled = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  // Fire-and-forget async work (drained queued steers) tracked so shutdown can
  // await it before the DB handle is torn down.
  private readonly pendingWork = new Set<Promise<unknown>>();
  private readonly verifierControllers = new Map<string, AbortController>();
  private readonly stalledRunTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly interruptForceIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly interruptAttempts = new Map<string, symbol>();
  private readonly interruptRecoveriesStarted = new Map<string, symbol>();
  private readonly interruptRecoveries = new Map<
    string,
    { attempt: symbol; resolve: () => void }
  >();
  private readonly lifecycleRetries = new Map<string, LifecycleRetry>();
  /** Bound one HTTP request without cancelling the durable background cleanup. */
  private deleteRetryWaitMs = DEFAULT_DELETE_RETRY_WAIT_MS;
  private readonly pendingOrchestrationEvents = new Map<string, PendingOrchestrationEvent[]>();
  private readonly orchestrationRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly transcriptWatchers = new Map<
    string,
    {
      count: number;
      watcher?: FSWatcher;
      debounce?: ReturnType<typeof setTimeout>;
      poller?: ReturnType<typeof setInterval>;
    }
  >();
  private stalledRunForceIdleMs = resolveStalledRunForceIdleMs();
  /** Backoff before re-attempting a stalled-run recovery step after a transient failure. */
  private readonly stalledRunRetryMs = 250;

  constructor(
    private readonly sessions: SessionsRepository,
    private readonly events: EventsRepository,
    private readonly providerRequestRecords: ProviderRequestsRepository,
    private readonly steerQueue: SteerQueueRepository,
    private readonly agents: AgentRegistry,
    private readonly git: GitService,
    private readonly cursorLocal: CursorLocalSessionsService,
    // Optional so lean test modules can omit it; images then persist inline.
    @Optional() private readonly media?: MediaStore,
    @Optional() private readonly piLocal?: PiLocalSessionsService,
    @Optional() private readonly settings?: SettingsService,
    @Optional() private readonly agentTools?: AgentToolRegistry,
    // Optional: when present, the verify-feedback loop resolves per-project
    // overrides (auto-steer / max-rounds) above the global setting.
    @Optional() private readonly projectDefaults?: ProjectDefaultsResolver,
    @Optional() private readonly contextFacts?: ContextFactsService,
    @Optional() private readonly profiles?: PromptProfileService,
    @Optional() private readonly database?: DatabaseService,
    // Optional: when present, a green ui-touching verify auto-captures
    // after-evidence (fail-open — capture never affects the loop).
    @Optional() private readonly evidence?: EvidenceCaptureService,
    @Optional() private readonly mcp?: McpService,
  ) {
    // A crash mid-fan-out can leave steer rows leased forever; a claim must
    // never outlive the process that took it. Release before restore so the
    // orphaned rows re-enter normal delivery.
    this.steerQueue.releaseAllClaims();
    // Restore before reconcile: sessions still RUNNING here get their drain
    // scheduled by the reconcile IDLE transition instead.
    this.restorePendingSteerQueues();
    this.reconcileInterruptedSessions();
    this.resolveStaleProviderRequests();
    this.resumeVerifyLoops();
  }

  list(includeArchived = false): SessionDto[] {
    return this.sessions
      .listUserFacing(includeArchived)
      .map((session) => this.enrichSession(session));
  }

  get(id: string): SessionDto | null {
    const session = this.sessions.findById(id);
    if (!session) return null;
    this.hydrateIfNeeded(session);
    const refreshed = this.sessions.findById(id);
    return refreshed ? this.enrichSession(refreshed) : null;
  }

  getEvents(
    id: string,
    since = 0,
    opts?: { limit?: number; tail?: number; before?: number },
  ): SessionEvent[] {
    const session = this.requireSession(id);
    this.hydrateIfNeeded(session);
    this.safeRefreshTranscript(id, session);
    let events: SessionEvent[];
    if (opts?.tail !== undefined) {
      events = this.events.listTail(id, opts.tail);
    } else if (opts?.before !== undefined) {
      events = this.events.listBefore(id, opts.before, opts.limit ?? DEFAULT_BACKFILL_LIMIT);
    } else {
      events = this.events.list(id, since, opts?.limit);
    }
    return this.projectPersistedTransportUserEvents(id, events);
  }

  private projectPersistedTransportUserEvents(id: string, events: SessionEvent[]): SessionEvent[] {
    const projected: SessionEvent[] = [];
    for (const event of events) {
      if (event.type !== 'user_message' && event.type !== 'steer_message') {
        projected.push(event);
        continue;
      }
      const payload = event.payload as Record<string, unknown>;
      if (typeof payload.text !== 'string') {
        projected.push(event);
        continue;
      }
      const decodedText = decodeNuncioTransportUserText(payload.text);
      if (decodedText === payload.text) {
        projected.push(event);
        continue;
      }
      const canonicalSeq = this.events.findUserInputSeqBefore(id, event.seq, decodedText);
      projected.push({
        ...event,
        payload: {
          ...payload,
          text: decodedText,
          ...(canonicalSeq !== null ? { transportDuplicateOfSeq: canonicalSeq } : {}),
        },
      });
    }
    return projected;
  }

  /** Catch-up refresh guarded against local live runs and transient fs errors. */
  private safeRefreshTranscript(id: string, session: SessionDto): void {
    if (this.locallyProducing.has(id)) return;
    try {
      this.refreshTranscriptIfNeeded(session);
    } catch {
      // Transient fs errors must not break event listing.
    }
  }

  /** Whether Cursor IDE/CLI is likely still running this handoff chat on the host. */
  isCursorCliActive(id: string): boolean {
    const session = this.requireSession(id);
    if (session.cursorBackend !== 'cli' || !session.cursorChatId || !session.workspace) {
      return false;
    }
    const workspace = session.worktreePath ?? session.workspace;
    const transcriptMtimeMs = this.cursorLocal.transcriptMtime(session.cursorChatId, workspace);
    const chatStoreMtimeMs = this.cursorLocal.chatStoreMtime(session.cursorChatId);
    const turnEnded = this.cursorLocal.isTranscriptTurnEnded(session.cursorChatId, workspace);
    return isCursorCliRecentlyActive(transcriptMtimeMs, chatStoreMtimeMs, turnEnded);
  }

  /** Append new transcript turns from disk; emits transcript_refreshed when rows land. */
  refreshTranscript(id: string): { added: number } {
    const session = this.requirePublicMutableSession(id);
    if (this.locallyProducing.has(id)) return { added: 0 };
    const before = this.events.list(id, 0).length;
    this.refreshTranscriptIfNeeded(session);
    const after = this.events.list(id, 0).length;
    return { added: Math.max(0, after - before) };
  }

  async create(input: CreateSessionDto): Promise<SessionDto> {
    const providerId = input.provider?.trim() || (await this.agents.defaultId());
    const provider = await this.agents.getAvailable(providerId);
    try {
      assertRuntimePolicyCapabilitySupported(input.runtimePolicy, provider.capabilities);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
    try {
      assertModeSupported(input.mode, provider.capabilities.modes);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }

    const id = input.id?.trim() || uuidv4().slice(0, 8);
    let workspace = input.workspace?.trim() || undefined;
    let projectPath: string | undefined;
    let baseBranch: string | undefined;
    let worktreePath: string | undefined;
    let branch: string | undefined;

    // Resolve the engine profile ONCE here (ADR-004: adapters get finished
    // strings). It drives both the preamble wrappers and the B4 context file.
    const profile = this.profiles?.resolve(providerId, input.model);

    if (input.projectPath?.trim()) {
      projectPath = input.projectPath.trim();
      await this.git.listBranches(projectPath);
      baseBranch = input.baseBranch?.trim() || undefined;
      if (input.useWorktree === true) {
        workspace = undefined;
        const slug = input.prompt.trim().split('\n')[0] ?? 'task';
        const worktree = await this.git.createWorktree(projectPath, baseBranch, id, slug);
        worktreePath = worktree.worktreePath;
        branch = input.pushBranch?.trim() || worktree.branch;
        baseBranch = worktree.baseBranch;
        if (input.upstreamBranch?.trim()) {
          try {
            await this.git.setWorktreeUpstream(
              worktreePath,
              worktree.branch,
              input.upstreamBranch.trim(),
            );
          } catch (error) {
            await this.git.removeWorktree(projectPath, worktreePath);
            throw error;
          }
        }
      } else {
        // Adopt an existing working dir (cross-engine handoff): an explicit
        // worktreePath/branch reuses the source session's isolated worktree
        // instead of creating a new one; otherwise run in the project itself.
        worktreePath = input.worktreePath?.trim() || undefined;
        branch = input.branch?.trim() || undefined;
        if (!worktreePath) workspace = workspace ?? projectPath;
      }
    }

    const runtimePolicy = this.validateRuntimePolicy(
      provider,
      input.runtimePolicy,
      worktreePath ?? workspace,
    );

    const mcpServerIds = this.validateMcpServerIds(input.mcpServerIds);

    // The single choke point for the first prompt: handoff brief → project
    // facts → workspace context → the user's prompt. Both this path and
    // TasksService.execute() (via input.contextBrief) compose here, so the
    // order is guaranteed in one place. Engines that inject the managed Nuncio
    // context into their own system prompt (capability flag) skip the duplicate
    // preamble facts on solo sessions; policy sessions keep them because the
    // hermetic policy loader never receives the managed context.
    const factsInPreamble =
      Boolean(projectPath) && !(provider.capabilities.systemContextInjection && !runtimePolicy);
    // Same hermetic rationale as Crew envelopes: a runtime-policy session gets
    // exactly its bounded prompt, so the workspace block stays out of it.
    const workspaceContext = runtimePolicy
      ? ''
      : await this.renderWorkspaceContextBlock(worktreePath ?? workspace, baseBranch);
    const prompt = composeSessionPreamble({
      ...(input.contextBrief ? { brief: renderHandoffBrief(input.contextBrief) } : {}),
      ...(input.historyContext ? { history: input.historyContext } : {}),
      ...(factsInPreamble ? { facts: this.renderProjectFacts(projectPath!, id) } : {}),
      ...(workspaceContext ? { workspace: workspaceContext } : {}),
      prompt: input.prompt,
      ...(profile ? { profile } : {}),
    });

    let session: SessionDto;
    try {
      session = this.sessions.create({
        ...input,
        id,
        prompt,
        rawPrompt: input.prompt,
        provider: providerId,
        workspace,
        projectPath,
        baseBranch,
        worktreePath,
        mcpServerIds,
        branch,
        runtimePolicy,
        cursorBackend: 'sdk',
      });
    } catch (error) {
      if (worktreePath && projectPath) {
        try {
          await this.git.removeWorktree(projectPath, worktreePath);
        } catch {
          // Preserve the insert failure; worktree pruning can reconcile the orphan later.
        }
      }
      throw error;
    }
    // B4: materialize the engine's native context file into the worktree now
    // that the session row exists (so a skip note can be recorded). Opt-in per
    // project; the preamble injection above is the guarantee, this reinforces it.
    if (worktreePath && projectPath) {
      this.materializeWorktreeContextFile(worktreePath, projectPath, profile?.contextFileName, session.id);
    }
    // A multitask parent whose engine can decompose runs a coordinating turn
    // (decompose → fan-out → wait on children) instead of a normal agent turn.
    // A modes-capable engine WITHOUT decompose falls back to the normal run so
    // its multitask overlay still applies (non-regressive).
    if (session.mode === 'multitask' && provider.decompose && this.multitaskCoordinator) {
      void this.startMultitaskRun(session);
    } else {
      void this.startRun(session, input.attachments);
    }
    return this.enrichSession(session);
  }

  /**
   * Render the project's facts for injection, or '' when disabled / empty. The
   * kill-switch and byte budget come from settings; the omission footer points
   * at the context tools only when orchestration tools are enabled.
   */
  private renderProjectFacts(projectPath: string, sessionId: string): string {
    if (!this.contextFacts) return '';
    if (this.settings?.resolve('NUNCIO_CONTEXT_FACTS_INJECT') === 'off') return '';
    if (this.contextFacts.count(projectPath) === 0) return '';
    const budgetRaw = Number(this.settings?.resolve('NUNCIO_CONTEXT_FACTS_MAX_BYTES'));
    const budget = Number.isInteger(budgetRaw) && budgetRaw > 0 ? budgetRaw : 4096;
    const facts = this.contextFacts.listPinnedFirst(projectPath, 200);
    const toolsEnabled = this.orchestrationToolsEnabled();
    return renderContextFacts(facts, budget, { toolsEnabled });
  }

  /**
   * Render the session-start workspace context block for a git cwd, or '' when
   * disabled / not a git repo. Best-effort: git failures never block creation.
   */
  private async renderWorkspaceContextBlock(
    cwd: string | undefined,
    baseBranch: string | undefined,
  ): Promise<string> {
    if (!cwd) return '';
    if (this.settings?.resolve('NUNCIO_WORKSPACE_CONTEXT_INJECT') === 'off') return '';
    const context = await buildSessionWorkspaceContext(cwd, baseBranch ?? null);
    return context ? renderWorkspaceContext(context) : '';
  }

  /** True when orchestration read/read-write tools are enabled for sessions. */
  private orchestrationToolsEnabled(): boolean {
    const mode = this.settings?.resolve('NUNCIO_ORCHESTRATION_TOOLS');
    return mode === 'read' || mode === 'read-write';
  }

  /**
   * B4: write the engine's native context file into a fresh worktree when the
   * project's policy opts in and the profile names one. Best-effort — a failure
   * (or a skipped existing file) never blocks session creation; a skip is noted
   * on the transcript. The rendered facts here are NOT gated by the preamble
   * inject kill-switch: the file and the preamble are independent channels.
   */
  private materializeWorktreeContextFile(
    worktreePath: string,
    projectPath: string,
    contextFileName: string | undefined,
    sessionId: string,
  ): void {
    const policy = this.settings?.resolve('NUNCIO_CONTEXT_FILE_POLICY') === 'worktree-local'
      ? 'worktree-local'
      : 'none';
    if (policy !== 'worktree-local' || !contextFileName) return;
    try {
      const budgetRaw = Number(this.settings?.resolve('NUNCIO_CONTEXT_FACTS_MAX_BYTES'));
      const budget = Number.isInteger(budgetRaw) && budgetRaw > 0 ? budgetRaw : 4096;
      const facts = this.contextFacts?.listPinnedFirst(projectPath, 200) ?? [];
      const factsBlock = renderContextFacts(facts, budget, { toolsEnabled: this.orchestrationToolsEnabled() });
      const result = materializeContextFile(worktreePath, { policy, contextFileName, factsBlock });
      if (result.skipped) {
        this.appendAndEmit(sessionId, 'status', {
          note: `Context file "${contextFileName}" already exists in the worktree; nuncio left it untouched.`,
        });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[sessions] context-file materialization failed for ${sessionId}: ${reason}`);
    }
  }

  async handoff(input: HandoffSessionDto): Promise<SessionDto> {
    const workspace = input.workspace?.trim();
    if (!workspace) throw new BadRequestException('workspace is required');

    // A prior session links the successor into a linear handoff chain, but only
    // when that predecessor actually exists (a stale/foreign id is ignored).
    const priorSessionId =
      input.priorSessionId && this.sessions.findById(input.priorSessionId)
        ? input.priorSessionId
        : undefined;

    if ('piSessionPath' in input) {
      return this.handoffPi(input.piSessionPath, workspace, input.title, priorSessionId);
    }

    const chatId = input.cursorChatId?.trim();
    if (!chatId) throw new BadRequestException('cursorChatId is required');

    const existing = this.sessions.findByCursorChatId(chatId, 'cli');
    if (existing) return this.enrichSession(existing);

    const local = this.cursorLocal.find(chatId, workspace);
    if (!local) {
      throw new NotFoundException(`Cursor chat ${chatId} not found for workspace`);
    }

    const title = input.title?.trim() || local.title;
    const model = this.cursorLocal.readTranscriptModel(chatId, workspace);
    const cursorMeta = readCursorChatMetadata(homedir(), chatId);
    const session = this.sessions.createHandoff({
      title: cursorMeta.name ?? title,
      workspace,
      cursorChatId: chatId,
      prompt: title,
      model,
      projectPath: cursorMeta.repoPath ?? workspace,
      branch: cursorMeta.branch ?? null,
      priorSessionId,
    });
    this.hydrateIfNeeded(session);
    const refreshed = this.sessions.findById(session.id)!;
    return this.enrichSession(refreshed);
  }

  private async handoffPi(
    piSessionPath: string | undefined,
    workspace: string,
    requestedTitle?: string,
    priorSessionId?: string,
  ): Promise<SessionDto> {
    const path = piSessionPath?.trim();
    if (!path) throw new BadRequestException('piSessionPath is required');

    const existing = this.sessions.findByProviderThreadId(path);
    if (existing) return this.enrichSession(existing);

    const local = await this.piLocal?.find(path, workspace);
    if (!local) {
      throw new NotFoundException(`Pi session ${path} not found for workspace`);
    }

    const title = requestedTitle?.trim() || local.title;
    const sessionWorkspace = local.workspace || workspace;
    const meta = this.piLocal?.readModelMeta(path) ?? { model: null, thinkingLevel: null };
    const branch = await this.git.currentBranch(sessionWorkspace);
    const session = this.sessions.createHandoff({
      provider: 'pi',
      title,
      workspace: sessionWorkspace,
      providerThreadId: path,
      prompt: title,
      model: meta.model,
      modelOptions: meta.thinkingLevel ? { thinkingLevel: meta.thinkingLevel } : null,
      projectPath: workspace,
      branch,
      priorSessionId,
    });
    this.hydrateIfNeeded(session);
    const refreshed = this.sessions.findById(session.id)!;
    return this.enrichSession(refreshed);
  }

  /**
   * Hand a settled session to another engine: a fresh session on the target
   * provider, seeded with a handoff brief (goal + workspace snapshot) and the
   * source's compacted timeline, reusing the source's working directory and
   * linked via priorSessionId. The transcript never replays verbatim —
   * renderEventsSince is the sanctioned lossy carrier.
   */
  async handoffToProvider(id: string, input: HandoffToProviderDto): Promise<SessionDto> {
    const source = this.requireSession(id);
    if (source.status !== 'IDLE' && source.status !== 'PAUSED' && source.status !== 'ERROR') {
      throw new BadRequestException(`Cannot hand off session in status ${source.status}`);
    }
    const targetId = input.provider?.trim();
    if (!targetId) throw new BadRequestException('provider is required');
    await this.agents.getAvailable(targetId);

    const events = this.events.listTail(id, HANDOFF_HISTORY_EVENT_LIMIT);
    // A session that is itself a fresh handoff has nothing native to carry —
    // require one real assistant turn before chaining another handoff.
    if (source.priorSessionId && !events.some((event) => event.type === 'assistant_message')) {
      throw new BadRequestException(
        'This session is a fresh handoff with no turns of its own yet — run it before handing off again.',
      );
    }

    const history = renderEventsSince(events, HANDOFF_HISTORY_BUDGET_BYTES, {
      sessionId: id,
      sinceSeq: 0,
    });
    const workingDir = source.worktreePath ?? source.workspace ?? source.projectPath ?? undefined;
    const snapshot = workingDir ? await buildWorkspaceSnapshot(workingDir, source.baseBranch) : null;
    const brief: HandoffBrief = {
      goal: `Continue "${source.title}" — handed off from ${source.provider}.`,
      ...(snapshot ? { workspace: snapshot } : {}),
      sourceSessionId: id,
    };

    const created = await this.create({
      prompt: input.prompt?.trim() || HANDOFF_CONTINUE_PROMPT,
      provider: targetId,
      // Same engine keeps the source model unless overridden; a different
      // engine falls back to its own default when no model is given.
      ...(input.model
        ? { model: input.model }
        : targetId === source.provider && source.model
          ? { model: source.model }
          : {}),
      ...(source.workspace ? { workspace: source.workspace } : {}),
      ...(source.projectPath ? { projectPath: source.projectPath } : {}),
      ...(source.baseBranch ? { baseBranch: source.baseBranch } : {}),
      ...(source.worktreePath ? { worktreePath: source.worktreePath } : {}),
      ...(source.branch ? { branch: source.branch } : {}),
      contextBrief: brief,
      historyContext: history,
      priorSessionId: id,
    });
    // The handoff continues the same task — carry the source title instead of
    // the first line of the composed preamble.
    return this.rename(created.id, source.title);
  }

  /**
   * Continue one durable session in place and wait for its turn plus the
   * session-owned verification loop. Provider thread, workspace, and runtime
   * policy all come from the persisted session row.
   */
  async continueExistingSession(
    id: string,
    input: ContinueExistingSessionDto,
  ): Promise<SessionDto> {
    const current = this.requireSession(id);
    if (current.status !== 'IDLE' && current.status !== 'PAUSED' && current.status !== 'ERROR') {
      throw new BadRequestException(`Cannot continue session in status ${current.status}`);
    }
    const prompt = composeSessionPreamble({
      ...(input.contextBrief ? { brief: renderHandoffBrief(input.contextBrief) } : {}),
      prompt: input.prompt,
    });

    this.armVerifySettlement(id);
    try {
      await this.steerInternal(
        id,
        prompt,
        input.forceResume ?? (current.status === 'ERROR'),
        input.attachments,
        input.origin,
      );
      await this.awaitVerifySettled(id);
      return this.requireSession(id);
    } catch (error) {
      this.settleVerify(id);
      throw error;
    }
  }

  /** Stop a Crew member handle without exposing pause/interrupt controls publicly. */
  async quiesceCrewSession(id: string): Promise<SessionDto> {
    const session = this.requireSession(id);
    if (session.verifyOwner !== 'crew') {
      throw new BadRequestException('Session is not Crew-owned');
    }
    this.beginCrewQuiescence(id);
    try {
      const provider = this.agents.resolveForSession(session);
      await provider.quiesce(id);
      if (session.status === 'RUNNING') this.appendAndEmit(id, 'interrupted', { owner: 'crew' });
      this.locallyProducing.delete(id);
      this.cancelProviderRequests(id);
      this.steerQueue.deleteForSession(id);
      this.settleVerify(id);
      if (this.sessions.findById(id)?.status === 'RUNNING') this.transition(id, 'IDLE');
      return this.requireSession(id);
    } finally {
      this.endCrewQuiescence(id);
    }
  }

  private beginCrewQuiescence(id: string): void {
    this.crewQuiesceCounts.set(id, (this.crewQuiesceCounts.get(id) ?? 0) + 1);
    for (const attempt of this.crewStartAttempts.get(id) ?? []) attempt.cancelled = true;
  }

  private endCrewQuiescence(id: string): void {
    const remaining = (this.crewQuiesceCounts.get(id) ?? 1) - 1;
    if (remaining > 0) this.crewQuiesceCounts.set(id, remaining);
    else this.crewQuiesceCounts.delete(id);
  }

  private beginCrewStart(session: SessionDto): CrewStartAttempt | null {
    if (session.verifyOwner !== 'crew') return null;
    const attempt = { cancelled: (this.crewQuiesceCounts.get(session.id) ?? 0) > 0 };
    const attempts = this.crewStartAttempts.get(session.id) ?? new Set<CrewStartAttempt>();
    attempts.add(attempt);
    this.crewStartAttempts.set(session.id, attempts);
    return attempt;
  }

  private endCrewStart(id: string, attempt: CrewStartAttempt | null): void {
    if (!attempt) return;
    const attempts = this.crewStartAttempts.get(id);
    attempts?.delete(attempt);
    if (attempts?.size === 0) this.crewStartAttempts.delete(id);
  }

  private canStartCrewAttempt(attempt: CrewStartAttempt | null): boolean {
    return attempt?.cancelled !== true;
  }

  async steer(
    id: string,
    message: string,
    forceResume?: boolean,
    attachments?: AgentAttachment[],
    origin?: string,
  ): Promise<SessionDto> {
    this.requirePublicMutableSession(id);
    return this.steerInternal(id, message, forceResume, attachments, origin);
  }

  steerInBackground(
    id: string,
    message: string,
    forceResume?: boolean,
    attachments?: AgentAttachment[],
    origin?: string,
    failureContext?: Record<string, unknown>,
  ): void {
    const session = this.requirePublicMutableSession(id);
    const trimmed = message?.trim() ?? '';
    if (!trimmed && !(attachments && attachments.length > 0)) {
      throw new BadRequestException('message is required');
    }
    if (session.status !== 'RUNNING' && !canTransition(session.status, 'RUNNING')) {
      throw new BadRequestException(`Cannot steer session in status ${session.status}`);
    }
    this.enqueueSteer(
      id,
      trimmed,
      this.persistImageAttachments(id, attachments),
      origin,
      failureContext,
    );
    // A running/starting turn owns its normal settle drain. Starting another
    // pass now would make a non-live steer re-enqueue itself indefinitely.
    if (session.status !== 'RUNNING' && !this.startingSteers.has(id)) {
      setTimeout(() => this.drainSteerQueue(id), 0);
    }
  }

  private async steerInternal(
    id: string,
    message: string,
    forceResume?: boolean,
    attachments?: AgentAttachment[],
    origin?: string,
  ): Promise<SessionDto> {
    this.requireSession(id);
    const trimmed = message?.trim() ?? '';
    // Allow an image-only steer (screenshot with no words); otherwise text is required.
    if (!trimmed && !(attachments && attachments.length > 0)) {
      throw new BadRequestException('message is required');
    }
    const persisted = this.persistImageAttachments(id, attachments);

    const current = this.requireSession(id);
    if (current.status === 'RUNNING') {
      const handled = await this.steerRunning(current, trimmed, persisted, origin);
      if (!handled) this.enqueueSteer(id, trimmed, persisted, origin);
      return this.requireSession(id);
    }
    if (this.startingSteers.has(id)) {
      this.enqueueSteer(id, trimmed, persisted, origin);
      return this.requireSession(id);
    }
    if (!canTransition(current.status, 'RUNNING')) {
      throw new BadRequestException(`Cannot steer session in status ${current.status}`);
    }

    this.refreshTranscriptIfNeeded(current);
    // Claim start ownership before the first await without mutating the FSM. A
    // concurrent steer queues, while provider/preflight failure preserves the
    // exact prior state (CREATED, IDLE, PAUSED, or ERROR).
    this.startingSteers.add(id);
    const crewStart = this.beginCrewStart(current);
    if (!this.canStartCrewAttempt(crewStart)) {
      this.startingSteers.delete(id);
      this.endCrewStart(id, crewStart);
      return this.requireSession(id);
    }
    let provider: AgentProvider;
    try {
      provider = await this.trackPendingWork(this.agents.resolveAvailableForSession(current));
      if (this.destroyed) {
        throw new HttpException('Session service is shutting down', HttpStatus.SERVICE_UNAVAILABLE);
      }
    } catch (error) {
      this.startingSteers.delete(id);
      this.endCrewStart(id, crewStart);
      this.scheduleSteerDrainAfterFailedStart(id, current.status);
      throw error;
    }
    if (!this.canStartCrewAttempt(crewStart)) {
      this.startingSteers.delete(id);
      this.endCrewStart(id, crewStart);
      return this.requireSession(id);
    }

    this.locallyProducing.add(id);
    let startFailed = false;
    try {
      const steering = provider.steer(id, trimmed, {
        ...this.buildAgentRunContext(current),
        attachments: persisted,
        forceResume: forceResume === true,
        ...(origin ? { steerOrigin: origin } : {}),
      });
      this.trackPendingWork(steering);
      await steering;
    } catch (error) {
      startFailed = true;
      throw error;
    } finally {
      this.startingSteers.delete(id);
      this.endCrewStart(id, crewStart);
      this.locallyProducing.delete(id);
      if (startFailed) this.scheduleSteerDrainAfterFailedStart(id, current.status);
    }
    this.trackPendingWork(this.maybeVerify(id));
    return this.requireSession(id);
  }

  /**
   * Write image attachments to disk and stamp each with its `id`, so the
   * transcript event persists only a reference instead of base64. The base64
   * `data` is kept on the returned attachment because the provider still needs
   * it to send the image to the model. A write failure falls back to inline
   * persistence — the image still works, just heavier in the event log.
   */
  private persistImageAttachments(
    sessionId: string,
    attachments?: AgentAttachment[],
  ): AgentAttachment[] | undefined {
    if (!this.media || !attachments || attachments.length === 0) return attachments;
    const media = this.media;
    return attachments.map((attachment) => {
      if (attachment.kind !== 'image' || attachment.id) return attachment;
      try {
        return { ...attachment, id: media.write(sessionId, attachment.data) };
      } catch {
        return attachment;
      }
    });
  }

  /** Inject into the live run when the provider supports it; false → caller queues. */
  private async steerRunning(
    session: SessionDto,
    message: string,
    attachments?: AgentAttachment[],
    origin?: string,
  ): Promise<boolean> {
    const provider = this.agents.resolveForSession(session);
    if (!provider.capabilities.steerWhileRunning || !provider.steerMidRun) return false;
    this.locallyProducing.add(session.id);
    try {
      const steering = provider.steerMidRun(session.id, message, {
        ...this.buildAgentRunContext(session),
        attachments,
        ...(origin ? { steerOrigin: origin } : {}),
      });
      this.trackPendingWork(steering);
      return await steering;
    } finally {
      this.locallyProducing.delete(session.id);
    }
  }

  private trackPendingWork<T>(work: Promise<T>): Promise<T> {
    this.pendingWork.add(work);
    void work.then(
      () => this.pendingWork.delete(work),
      () => this.pendingWork.delete(work),
    );
    return work;
  }

  private readonly backgroundSteerFailureHandlers = new Set<(
    failure: {
      sessionId: string;
      origin?: string;
      context: Record<string, unknown>;
      error: unknown;
    },
  ) => void>();
  private readonly backgroundSteerDeliveredHandlers = new Set<(
    delivery: {
      sessionId: string;
      origin?: string;
      context: Record<string, unknown>;
    },
  ) => void>();

  onBackgroundSteerFailure(
    handler: (
      failure: {
        sessionId: string;
        origin?: string;
        context: Record<string, unknown>;
        error: unknown;
      },
    ) => void,
  ): () => void {
    this.backgroundSteerFailureHandlers.add(handler);
    return () => this.backgroundSteerFailureHandlers.delete(handler);
  }

  onBackgroundSteerDelivered(
    handler: (
      delivery: {
        sessionId: string;
        origin?: string;
        context: Record<string, unknown>;
      },
    ) => void,
  ): () => void {
    this.backgroundSteerDeliveredHandlers.add(handler);
    return () => this.backgroundSteerDeliveredHandlers.delete(handler);
  }

  private enqueueSteer(
    id: string,
    message: string,
    attachments?: AgentAttachment[],
    origin?: string,
    failureContext?: Record<string, unknown>,
  ): number {
    const rowId = this.steerQueue.enqueue(id, message, attachments, origin, failureContext);
    this.appendAndEmit(id, 'steer_queued', { text: message });
    return rowId;
  }


  /**
   * Claim (lease) the queued steers for a multitask fan-out. Claimed rows are
   * hidden from the normal settle-drain, so the same messages can never be
   * delivered a second time while the fan-out does async work. The caller must
   * later {@link finalizeDrainedSteers} (success) or {@link releaseClaimedSteers}
   * (failure) with the returned ids.
   */
  claimSteerQueueForMultitask(id: string): Array<{ id: number; message: string }> {
    this.requireSession(id);
    return this.steerQueue.claimAll(id).map((steer) => ({ id: steer.id, message: steer.message }));
  }

  /** Return claimed rows to normal delivery (fan-out aborted before consuming them). */
  releaseClaimedSteers(steerIds: number[]): void {
    this.steerQueue.releaseByIds(steerIds);
  }

  /**
   * Tell live clients the queued placeholders were consumed by a fan-out. The
   * rows themselves are deleted inside the caller's transaction; this only
   * emits the projection event (empty payload — the web client drops queued
   * placeholder blocks on this signal regardless of payload).
   */
  emitSteerQueueCleared(id: string): void {
    this.appendAndEmit(id, 'steer_queue_cleared', {});
  }

  /** Direct handle to the steer-queue repository for a caller-owned transaction. */
  get steerQueueRepository(): SteerQueueRepository {
    return this.steerQueue;
  }

  /**
   * Walk a session's lineage: ancestors up the `parentSessionId` chain (capped
   * at 10, cycle-safe via a visited set) and its direct tree children (oldest
   * first). Throws NotFound when the session itself does not exist.
   */
  lineage(id: string): SessionLineageDto {
    const session = this.sessions.findById(id);
    if (!session) throw new NotFoundException('Session not found');

    const ancestors: SessionRefDto[] = [];
    const visited = new Set<string>([id]);
    let cursor = session.parentSessionId;
    while (cursor && ancestors.length < ANCESTOR_WALK_CAP && !visited.has(cursor)) {
      visited.add(cursor);
      const parent = this.sessions.findById(cursor);
      if (!parent) break;
      ancestors.push(toSessionRef(parent));
      cursor = parent.parentSessionId;
    }

    const children = this.sessions.childrenOf(id).map(toSessionRef);
    return { ancestors, children };
  }

  /**
   * Flush a RUNNING parent's provider-buffered deltas as their own independent,
   * committed write, so they land at an earlier seq than a later orchestration
   * event. MUST be called BEFORE opening any transaction that appends such an
   * event — the flush appends AND emits its delta synchronously, and a delta is
   * a legitimate event regardless of whether that later transaction commits.
   * Settled sessions are also flushed when the provider still owns accepted
   * events from the preceding run. No-op when no buffer exists or the provider
   * is missing/unavailable.
   */
  flushParentBuffer(sessionId: string): void {
    const session = this.sessions.findById(sessionId);
    if (!session) return;
    try {
      const provider = this.agents.resolveForSession(session);
      const hasRetainedEvents = provider.pendingEventSessionIds?.().includes(sessionId) ?? false;
      if (session.status !== 'RUNNING' && !hasRetainedEvents) return;
      provider.flushPendingEvents?.(sessionId);
    } catch (error) {
      if (error instanceof RetainedEventFlushError) throw error;
      // A missing/unavailable provider must never block a digest append.
    }
  }

  /**
   * Persist an orchestration-authored event WITHOUT flushing or fanning out, so
   * a caller can wrap it in a transaction alongside other writes and emit only
   * after the commit. The caller is responsible for calling flushParentBuffer
   * BEFORE the transaction — flushing here would append+emit a delta that a
   * transaction rollback could then erase from persistence but not from clients.
   * Returns null when the session no longer exists.
   */
  persistOrchestrationEvent(
    sessionId: string,
    type: SessionEventType,
    payload: unknown,
  ): SessionEvent | null {
    if (!this.sessions.findById(sessionId)) return null;
    return this.events.append(sessionId, type, payload);
  }

  /** Fan a previously-persisted event out to live subscribers. */
  emitPersistedEvent(sessionId: string, event: SessionEvent): void {
    this.emit(sessionId, event);
  }

  /**
   * Append an orchestration-authored event (e.g. a subagent digest) to a
   * session's log through the same persist+fanout path run events take, so live
   * subscribers update without a reload. Flushes the parent's provider buffer
   * first so a buffered delta cannot overtake this event. Annotate-don't-block:
   * the session FSM is untouched. Returns null when the session no longer
   * exists; never throws — digest delivery must never destabilize its producer.
   */
  appendOrchestrationEvent(
    sessionId: string,
    type: SessionEventType,
    payload: unknown,
  ): SessionEvent | null {
    const queued = this.pendingOrchestrationEvents.get(sessionId);
    if (queued?.length) {
      queued.push({ type, payload });
      this.scheduleOrchestrationRetry(sessionId);
      return null;
    }
    try {
      this.flushParentBuffer(sessionId);
    } catch (error) {
      if (!(error instanceof RetainedEventFlushError)) throw error;
      this.pendingOrchestrationEvents.set(sessionId, [{ type, payload }]);
      this.scheduleOrchestrationRetry(sessionId);
      return null;
    }
    const event = this.persistOrchestrationEvent(sessionId, type, payload);
    if (event) this.emit(sessionId, event);
    return event;
  }

  private scheduleOrchestrationRetry(sessionId: string): void {
    if (this.destroyed || this.orchestrationRetryTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.orchestrationRetryTimers.delete(sessionId);
      this.drainPendingOrchestrationEvents(sessionId);
    }, 100);
    this.orchestrationRetryTimers.set(sessionId, timer);
  }

  private drainPendingOrchestrationEvents(sessionId: string, duringShutdown = false): void {
    const queued = this.pendingOrchestrationEvents.get(sessionId);
    if ((this.destroyed && !duringShutdown) || !queued?.length) return;
    try {
      const session = this.sessions.findById(sessionId);
      if (!session) {
        this.pendingOrchestrationEvents.delete(sessionId);
        return;
      }
      try {
        // Retry even if the FSM already settled: the accepted provider tail still
        // owns the earlier transcript position and must commit before this queue.
        this.agents.resolveForSession(session).flushPendingEvents?.(sessionId);
      } catch (error) {
        if (error instanceof RetainedEventFlushError) throw error;
        // A missing/unavailable provider cannot own an in-memory retained tail.
      }

      while (queued.length) {
        const pending = queued[0];
        const event = this.persistOrchestrationEvent(sessionId, pending.type, pending.payload);
        queued.shift();
        if (event) this.emit(sessionId, event);
      }
      this.pendingOrchestrationEvents.delete(sessionId);
    } catch {
      // Reads and appends can fail under the same transient SQLite fault. Keep
      // the queue intact and retry instead of letting a timer crash the daemon.
      if (!duringShutdown) this.scheduleOrchestrationRetry(sessionId);
    }
  }

  /**
   * Schedule a settle-drain for a session out-of-band — used after releasing a
   * steer claim that a fan-out never consumed, so freed messages don't sit
   * undelivered until an unrelated trigger. No-ops unless the session is IDLE:
   * a RUNNING session drains on its own next settle, and PAUSED/ERROR must not
   * be force-fed. Reuses the same drain mechanism status transitions use.
   */
  scheduleSteerDrain(id: string): void {
    if (this.destroyed) return;
    if (this.sessions.findById(id)?.status !== 'IDLE') return;
    setTimeout(() => this.drainSteerQueue(id), 0);
  }

  /** Retry an acknowledged concurrent steer only if no newer lifecycle state won. */
  private scheduleSteerDrainAfterFailedStart(id: string, expectedStatus: SessionStatus): void {
    // An active queue drain owns both retry timing and row acknowledgement.
    // Scheduling here as well would bypass its backoff and create a hot loop.
    if (
      this.destroyed ||
      this.drainingSteerQueues.has(id) ||
      this.sessions.findById(id)?.status !== expectedStatus
    ) return;
    setTimeout(() => {
      if (
        this.destroyed ||
        this.drainingSteerQueues.has(id) ||
        this.sessions.findById(id)?.status !== expectedStatus
      ) return;
      this.drainSteerQueue(id);
    }, 0);
  }

  /** Deliver the next queued steer once the foreground run has settled. */
  private drainSteerQueue(id: string): void {
    // Drain timers can outlive the service; after shutdown the database is
    // closed, so touching the queue would throw from a detached timer.
    if (this.destroyed || this.drainingSteerQueues.has(id)) return;
    // A requested pause/archive/delete owns the session even while retained
    // events or the status write are retrying. Never let an older queue timer
    // restart provider work before that lifecycle intent settles.
    if (this.lifecycleRetries.has(id)) return;
    // Crew owns every continuation of its hidden member Sessions. A stale
    // generic queue row must remain inert for owner reconciliation instead of
    // entering the public steer path and retrying forever after authorization
    // rejects it.
    const owner = this.sessions.findById(id);
    if (!owner || owner.verifyOwner === 'crew') return;

    // Skip any leading task-digest wakes that must not restart an ERROR/PAUSED
    // session, then deliver the first eligible row. Skipping is atomic (row
    // delete + suppression note commit together) so a crash mid-skip never
    // swallows a wake, and the loop ensures a user steer queued behind skipped
    // wakes is not pinned.
    let next = this.steerQueue.peekNext(id);
    while (next) {
      if (next.origin === 'task-digest') {
        const status = this.sessions.findById(id)?.status;
        if (status === 'ERROR' || status === 'PAUSED') {
          try {
            this.skipQueuedDigestWake(id, next.id, status);
          } catch (error) {
            // Atomic skip failed (both-or-neither): the row is still queued.
            // Stop this pass rather than spin; a later drain retries it.
            const reason = error instanceof Error ? error.message : String(error);
            console.warn(`[sessions] failed to skip queued digest wake for ${id}: ${reason}`);
            return;
          }
          next = this.steerQueue.peekNext(id);
          continue;
        }
      }
      break;
    }
    if (!next) return;
    const authorizedStatus = this.sessions.findById(id)?.status;
    if (!authorizedStatus) return;

    // Keep ownership of this durable row until provider delivery succeeds.
    // Failed attempts leave it in place for retry instead of dropping an
    // acknowledged message.
    this.drainingSteerQueues.add(id);
    const delivered = next;
    let deliveryFailed = false;
    const work = (async () => {
      try {
        await this.steer(
          id,
          delivered.message,
          undefined,
          delivered.attachments,
          delivered.origin,
        );
      } catch (error) {
        deliveryFailed = true;
        try {
          this.steerQueue.reportFailureOnce(delivered.id, () => {
            if (delivered.failureContext) {
              let handled = false;
              let handlerError: unknown;
              for (const handler of this.backgroundSteerFailureHandlers) {
                try {
                  handler({
                    sessionId: id,
                    ...(delivered.origin ? { origin: delivered.origin } : {}),
                    context: delivered.failureContext!,
                    error,
                  });
                  handled = true;
                } catch (failure) {
                  handlerError = failure;
                }
              }
              if (!handled) {
                throw handlerError ?? new Error('No background steer failure handler is registered');
              }
            }
            const reason = error instanceof Error ? error.message : String(error);
            this.appendAndEmit(id, 'error', {
              message: `Queued message failed to send: ${reason}`,
            });
          });
        } catch {
          // Rollback keeps the failure report eligible for a later delivery retry.
        }
        return;
      }

      // Provider delivery already completed. A transient acknowledgement write
      // must retry only the delete; redelivering could repeat external effects.
      await this.acknowledgeDeliveredSteer(
        delivered.id,
        id,
        delivered.origin,
      );
    })();
    // Track so shutdown awaits it — a fire-and-forget drained steer must not write
    // to a closed DB handle after the module is destroyed.
    this.pendingWork.add(work);
    void work.finally(() => {
      this.pendingWork.delete(work);
      this.drainingSteerQueues.delete(id);
      if (this.destroyed) return;
      if (!deliveryFailed) {
        setTimeout(() => this.drainSteerQueue(id), 0);
        return;
      }
      // A user lifecycle action (especially pause/archive) wins over an older
      // delivery retry. The durable row remains for a later explicit resume.
      if (this.sessions.findById(id)?.status === authorizedStatus) {
        setTimeout(() => {
          if (
            !this.destroyed &&
            this.sessions.findById(id)?.status === authorizedStatus
          ) this.drainSteerQueue(id);
        }, 250);
      }
    });
  }

  /** Retry only the durable queue acknowledgement after provider delivery. */
  private async acknowledgeDeliveredSteer(
    rowId: number,
    sessionId: string,
    origin?: string,
  ): Promise<void> {
    while (!this.destroyed) {
      try {
        this.steerQueue.acknowledgeDelivered(rowId, (context) => {
          let handled = false;
          let handlerError: unknown;
          for (const handler of this.backgroundSteerDeliveredHandlers) {
            try {
              handler({
                sessionId,
                ...(origin ? { origin } : {}),
                context,
              });
              handled = true;
            } catch (error) {
              handlerError = error;
            }
          }
          if (!handled) {
            throw handlerError ?? new Error('No background steer recovery handler is registered');
          }
        });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  /**
   * Drop a queued task-digest wake that must not restart an ERROR/PAUSED parent,
   * atomically: the row delete and the suppression-note persist commit as one
   * transaction (both-or-neither), so a crash between them can never swallow the
   * wake. The note is fanned out to subscribers only after the commit.
   */
  private skipQueuedDigestWake(sessionId: string, rowId: number, status: SessionStatus): void {
    const note = `Auto-steer suppressed: parent status ${status}. Digest delivered as event only.`;
    const event = this.steerQueue.transaction<SessionEvent | null>(() => {
      this.steerQueue.deleteById(rowId);
      return this.persistOrchestrationEvent(sessionId, 'status', { note });
    });
    if (event) this.emitPersistedEvent(sessionId, event);
  }

  /** Grace period before a non-unwinding interrupted run is forced idle. */
  private interruptForceIdleMs = 5000;

  async interrupt(id: string): Promise<void> {
    const session = this.requirePublicMutableSession(id);
    const provider = this.agents.resolveForSession(session);
    if (!provider.capabilities.interrupt || !provider.interrupt) {
      throw new BadRequestException(`Interrupt not supported by provider ${provider.id}`);
    }
    const attempt = Symbol(id);
    const recovered = this.armInterruptForceIdle(id, attempt);
    const outcome = await Promise.race([
      provider.interrupt(id).then(
        () => ({ kind: 'provider' as const }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      ),
      recovered.then(() => ({ kind: 'recovered' as const })),
    ]);
    if (outcome.kind === 'recovered') {
      const current = this.sessions.findById(id);
      if (this.interruptAttempts.get(id) === attempt && !this.destroyed && current) {
        this.appendAndEmit(id, 'interrupted', {});
        this.interruptAttempts.delete(id);
      }
      return;
    }
    if (outcome.kind === 'error') {
      if (
        this.interruptAttempts.get(id) === attempt &&
        this.interruptRecoveriesStarted.get(id) !== attempt
      ) this.clearInterruptForceIdleWatch(id);
      throw outcome.error;
    }
    const current = this.sessions.findById(id);
    if (this.interruptAttempts.get(id) !== attempt || this.destroyed || !current) return;
    this.appendAndEmit(id, 'interrupted', {});
    if (current.status !== 'RUNNING') this.interruptAttempts.delete(id);
  }

  private armInterruptForceIdle(id: string, attempt: symbol): Promise<void> {
    this.clearInterruptForceIdleWatch(id);
    this.interruptAttempts.set(id, attempt);
    const recovered = new Promise<void>((resolve) => {
      this.interruptRecoveries.set(id, { attempt, resolve });
    });
    const transitionToIdle = () => {
      if (this.interruptAttempts.get(id) !== attempt) return;
      this.interruptForceIdleTimers.delete(id);
      if (this.destroyed) {
        this.resolveInterruptRecovery(id, attempt);
        return;
      }
      let current: SessionDto | null;
      try {
        current = this.sessions.findById(id);
      } catch {
        current = null;
      }
      if (!current) {
        const retry = setTimeout(transitionToIdle, Math.min(this.interruptForceIdleMs, 250));
        this.interruptForceIdleTimers.set(id, retry);
        return;
      }
      if (current.status !== 'RUNNING') {
        this.interruptAttempts.delete(id);
        this.interruptRecoveriesStarted.delete(id);
        this.resolveInterruptRecovery(id, attempt);
        return;
      }
      try {
        this.transition(id, 'IDLE');
      } catch {
        // The runtime is already fenced. Retry only the atomic status+event
        // transition so a transient SQLite failure cannot strand RUNNING.
        const retry = setTimeout(transitionToIdle, Math.min(this.interruptForceIdleMs, 250));
        this.interruptForceIdleTimers.set(id, retry);
        return;
      }
      this.interruptAttempts.delete(id);
      this.interruptRecoveriesStarted.delete(id);
      this.resolveInterruptRecovery(id, attempt);
    };
    // A hung provider stream can swallow the abort and leave the run pending
    // forever; if the session is still RUNNING after the grace period, drop
    // the zombie handle and force it idle so the user is never stuck.
    const forceIdle = () => {
      if (this.interruptAttempts.get(id) !== attempt) return;
      this.interruptForceIdleTimers.delete(id);
      if (this.destroyed) {
        this.resolveInterruptRecovery(id, attempt);
        return;
      }
      let current: SessionDto | null;
      try {
        current = this.sessions.findById(id);
      } catch {
        // The owning test/app database may already be closing even if this
        // timer was queued before its destroy flag became visible.
        this.resolveInterruptRecovery(id, attempt);
        return;
      }
      if (current?.status !== 'RUNNING') {
        this.resolveInterruptRecovery(id, attempt);
        return;
      }
      this.interruptRecoveriesStarted.set(id, attempt);
      try {
        this.disposeProviderSession(current, true);
      } catch (error) {
        if (error instanceof RetainedEventFlushError) {
          // A retained tail still has to commit before the lifecycle status. Retry
          // after the base buffer's short flush window; the SDK is already fenced.
          const retry = setTimeout(forceIdle, Math.min(this.interruptForceIdleMs, 250));
          this.interruptForceIdleTimers.set(id, retry);
          return;
        }
        // The runtime is already fenced as far as the provider could manage;
        // a permanent adapter error must not keep the FSM RUNNING forever.
      }
      this.locallyProducing.delete(id);
      transitionToIdle();
    };
    const timer = setTimeout(forceIdle, this.interruptForceIdleMs);
    this.interruptForceIdleTimers.set(id, timer);
    return recovered;
  }

  private clearInterruptForceIdleWatch(id: string): void {
    this.interruptAttempts.delete(id);
    this.interruptRecoveriesStarted.delete(id);
    this.cancelInterruptForceIdleTimer(id);
  }

  private cancelInterruptForceIdleTimer(id: string): void {
    const timer = this.interruptForceIdleTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.interruptForceIdleTimers.delete(id);
    }
    this.resolveInterruptRecovery(id);
  }

  private resolveInterruptRecovery(id: string, attempt?: symbol): void {
    const recovery = this.interruptRecoveries.get(id);
    if (!recovery || (attempt && recovery.attempt !== attempt)) return;
    this.interruptRecoveries.delete(id);
    recovery.resolve();
  }

  async setSessionModel(
    id: string,
    model: string,
    options?: ModelOptionsMap | null,
  ): Promise<SessionDto> {
    const session = this.requirePublicMutableSession(id);
    const trimmed = model?.trim();
    if (!trimmed) throw new BadRequestException('model is required');
    const provider = this.agents.resolveForSession(session);
    if (provider.capabilities.modelSwitch === 'in-session' && provider.setModel) {
      await provider.setModel(id, trimmed, options ?? null);
    }
    const updated = this.sessions.updateModel(id, trimmed, options ?? null);
    if (!updated) throw new NotFoundException(`Session ${id} not found`);
    return updated;
  }

  async respondInteraction(
    id: string,
    requestId: string,
    body: RespondInteractionDto,
  ): Promise<{ ok: true }> {
    const session = this.requirePublicMutableSession(id);
    const trimmedRequestId = requestId?.trim();
    if (!trimmedRequestId) {
      throw new BadRequestException('requestId is required');
    }
    if (!this.agents.supportsInteractionForSession(session)) {
      throw new HttpException(
        { error: 'Provider does not support live interaction respond' },
        HttpStatus.NOT_IMPLEMENTED,
      );
    }

    const provider = this.agents.resolveForSession(session);
    if (!provider.submitInteraction) {
      throw new HttpException(
        { error: 'Provider does not support live interaction respond' },
        HttpStatus.NOT_IMPLEMENTED,
      );
    }

    await provider.submitInteraction(id, trimmedRequestId, body, this.buildAgentRunContext(session));
    return { ok: true };
  }

  pause(id: string): SessionDto {
    const session = this.requirePublicMutableSession(id);
    if (!canTransition(session.status, 'PAUSED')) {
      throw new BadRequestException(`Cannot pause session in status ${session.status}`);
    }
    // Verification runs while the session is IDLE. Pause is a lifecycle stop,
    // so cancel that process tree even when no provider turn is active.
    this.verifierControllers.get(id)?.abort();
    const finished = this.disposeThenFinishLifecycle(session, 'pause', () => this.finishPause(id));
    if (!finished) return this.requireSession(id);
    return this.requireSession(id);
  }

  archive(id: string): SessionDto {
    const session = this.requirePublicMutableSession(id);
    if (!canTransition(session.status, 'ARCHIVED')) {
      throw new BadRequestException(`Cannot archive session in status ${session.status}`);
    }
    this.disposeThenFinishLifecycle(session, 'archive', () => this.finishArchive(id));
    return this.requireSession(id);
  }

  restore(id: string): SessionDto {
    const session = this.requirePublicMutableSession(id);
    if (session.status !== 'ARCHIVED') {
      throw new BadRequestException(`Cannot restore session in status ${session.status}`);
    }
    // Filesystem removal and SQLite cannot share a transaction. Repairing a
    // missing worktree here closes the crash window between those two writes.
    if (
      session.worktreePath &&
      session.projectPath &&
      (!existsSync(session.worktreePath) || !existsSync(join(session.worktreePath, '.git')))
    ) {
      this.sessions.clearWorktreeMetadata(id);
    }
    this.transition(id, 'IDLE', {
      immediate: true,
      beforeUpdate: () => this.sessions.detachForgeOwnershipIfReplaced(id),
    });
    return this.requireSession(id);
  }

  rename(id: string, title: string): SessionDto {
    const trimmed = title.trim();
    if (!trimmed) {
      throw new BadRequestException('Title cannot be empty');
    }
    this.requirePublicMutableSession(id);
    const updated = this.sessions.updateTitle(id, trimmed);
    if (!updated) throw new NotFoundException(`Session ${id} not found`);
    return this.enrichSession(updated);
  }

  async delete(id: string): Promise<void> {
    const session = this.requirePublicMutableSession(id);
    if (session.status !== 'ARCHIVED') {
      throw new BadRequestException(`Cannot delete session in status ${session.status}; archive first`);
    }
    const finished = this.disposeThenFinishLifecycle(session, 'delete', () => this.finishDelete(id));
    if (finished) return;

    const retry = this.lifecycleRetries.get(id);
    if (!retry) {
      throw new HttpException('Delete could not be scheduled', HttpStatus.SERVICE_UNAVAILABLE);
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      retry.promise.then(() => 'settled' as const),
      new Promise<'timeout'>((resolve) => {
        timeout = setTimeout(() => resolve('timeout'), this.deleteRetryWaitMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (outcome === 'timeout') {
      throw new HttpException(
        'Delete cleanup is still pending; retry later',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (!this.sessions.findById(id) && !this.destroyed) return;
    const reason = retry.failure instanceof Error
      ? retry.failure.message
      : retry.failure !== undefined
        ? String(retry.failure)
        : 'cleanup did not complete';
    throw new HttpException(`Delete failed: ${reason}`, HttpStatus.SERVICE_UNAVAILABLE);
  }

  private finishPause(id: string): void {
    const current = this.sessions.findById(id);
    if (!current || !canTransition(current.status, 'PAUSED')) return;
    this.cancelProviderRequests(id);
    this.transition(id, 'PAUSED');
  }

  private finishArchive(id: string): void {
    const current = this.sessions.findById(id);
    if (!current || !canTransition(current.status, 'ARCHIVED')) return;
    this.cancelProviderRequests(id);
    this.steerQueue.deleteForSession(id);
    this.transition(id, 'ARCHIVED');
  }

  private finishDelete(id: string): void {
    const current = this.sessions.findById(id);
    if (current?.status !== 'ARCHIVED') return;
    this.cancelProviderRequests(id);
    this.streams.delete(id);
    this.steerQueue.deleteForSession(id);
    try {
      this.media?.deleteSession(id);
    } catch (error) {
      throw new PermanentLifecycleCleanupError(error);
    }
    this.sessions.delete(id);
  }

  /** Keep a lifecycle operation pending until the provider's retained tail commits. */
  private disposeThenFinishLifecycle(
    session: SessionDto,
    operation: 'pause' | 'archive' | 'delete',
    finish: () => void,
  ): boolean {
    let providerDisposed = false;
    try {
      this.disposeProviderSession(session);
      providerDisposed = true;
      finish();
      this.cancelLifecycleRetry(session.id);
      return true;
    } catch (error) {
      if (this.isUnknownProviderError(error, session.provider)) {
        try {
          finish();
          return true;
        } catch {
          this.scheduleLifecycleRetry(session.id, session.status, operation, finish);
          return false;
        }
      }
      if (
        !providerDisposed &&
        !(error instanceof RetainedEventFlushError) &&
        !this.providerUsesSharedRunFence(session)
      ) throw error;
      this.scheduleLifecycleRetry(session.id, session.status, operation, finish);
      return false;
    }
  }

  private providerUsesSharedRunFence(session: SessionDto): boolean {
    try {
      return typeof this.agents.resolveForSession(session).invalidateRun === 'function';
    } catch {
      return false;
    }
  }

  private scheduleLifecycleRetry(
    id: string,
    expectedStatus: SessionStatus,
    operation: 'pause' | 'archive' | 'delete',
    finish: () => void,
  ): void {
    const existing = this.lifecycleRetries.get(id);
    if (existing) {
      // A newer user intent supersedes the older lifecycle request while both
      // still target the same persisted pre-transition status.
      existing.cancelled = true;
      this.lifecycleRetries.delete(id);
    }
    const record: LifecycleRetry = { cancelled: false, promise: Promise.resolve() };
    record.promise = (async () => {
      while (!record.cancelled) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (record.cancelled) return;
        let current: SessionDto | null;
        try {
          current = this.sessions.findById(id);
        } catch {
          // A transient read failure must not abandon a requested lifecycle
          // transition whose status row is still unchanged.
          continue;
        }
        if (!current || current.status !== expectedStatus) return;
        try {
          this.disposeProviderSession(current);
        } catch (error) {
          if (this.isUnknownProviderError(error, current.provider)) {
            // Provider-independent lifecycle work can still complete for a
            // persisted session whose adapter is no longer registered.
          } else if (!(error instanceof RetainedEventFlushError)) {
            try {
              this.surfaceLifecycleRetryFailure(current, operation, error);
              record.failure = error;
              return;
            } catch {
              // Persistence can fail independently of provider teardown. Retry
              // until the failure is durably visible or shutdown cancels us.
            }
            continue;
          } else {
            // The base provider retains failed appends; retry until persistence
            // recovers or the bounded shutdown drain explicitly cancels us.
            continue;
          }
        }
        try {
          finish();
          return;
        } catch (error) {
          if (error instanceof PermanentLifecycleCleanupError) {
            try {
              this.surfaceLifecycleRetryFailure(current, operation, error.cause);
              record.failure = error.cause;
              return;
            } catch {
              // Retry only until the permanent cleanup failure is durably visible.
              continue;
            }
          }
          // The lifecycle transition + status event commit atomically below.
          // A transient persistence failure therefore leaves the old status in
          // place and is safe to retry without losing the requested operation.
        }
      }
    })();
    this.lifecycleRetries.set(id, record);
    this.pendingWork.add(record.promise);
    void record.promise.finally(() => {
      if (this.lifecycleRetries.get(id) === record) this.lifecycleRetries.delete(id);
      this.pendingWork.delete(record.promise);
    });
  }

  private surfaceLifecycleRetryFailure(
    session: SessionDto,
    operation: 'pause' | 'archive' | 'delete',
    error: unknown,
  ): void {
    const reason = error instanceof Error ? error.message : String(error);
    this.appendAndEmit(session.id, 'error', {
      message: `Lifecycle ${operation} failed after retained output recovery: ${reason}`,
    });
    if (canTransition(session.status, 'ERROR')) this.transition(session.id, 'ERROR');
  }

  private cancelLifecycleRetry(id: string): void {
    const retry = this.lifecycleRetries.get(id);
    if (!retry) return;
    retry.cancelled = true;
    this.lifecycleRetries.delete(id);
  }

  private cancelAllLifecycleRetries(): void {
    for (const retry of this.lifecycleRetries.values()) retry.cancelled = true;
    this.lifecycleRetries.clear();
  }

  /** Preserve buffered output, fence stale callbacks, then release the SDK. */
  private disposeProviderSession(session: SessionDto, preserveInterruptAttempt = false): void {
    if (!preserveInterruptAttempt) this.clearInterruptForceIdleWatch(session.id);
    this.verifierControllers.get(session.id)?.abort();
    const provider = this.agents.resolveForSession(session);
    provider.dispose(session.id);
  }

  /** Raw bytes of a stored chat image, or null if the id is unknown/malformed. */
  readMedia(sessionId: string, mediaId: string): Buffer | null {
    return this.media?.read(sessionId, mediaId) ?? null;
  }

  subscribe(id: string, listener: StreamListener): () => void {
    const bus = this.getOrCreateBus(id);
    const handler = (event: SessionEvent) => listener(event);
    bus.on('event', handler);
    const session = this.sessions.findById(id);
    if (session) this.safeRefreshTranscript(id, session);
    this.startTranscriptWatch(id);
    return () => {
      bus.off('event', handler);
      this.stopTranscriptWatch(id);
    };
  }

  private destroyed = false;

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    for (const timer of this.orchestrationRetryTimers.values()) clearTimeout(timer);
    this.orchestrationRetryTimers.clear();
    for (const controller of this.verifierControllers.values()) controller.abort();
    this.verifierControllers.clear();
    for (const timer of this.interruptForceIdleTimers.values()) clearTimeout(timer);
    this.interruptForceIdleTimers.clear();
    this.interruptAttempts.clear();
    this.interruptRecoveriesStarted.clear();
    for (const recovery of this.interruptRecoveries.values()) recovery.resolve();
    this.interruptRecoveries.clear();
    for (const timer of this.stalledRunTimers.values()) clearTimeout(timer);
    this.stalledRunTimers.clear();
    for (const entry of this.transcriptWatchers.values()) {
      if (entry.debounce) clearTimeout(entry.debounce);
      if (entry.poller) clearInterval(entry.poller);
      try {
        entry.watcher?.close();
      } catch {
        // Ignore watcher close failures during shutdown.
      }
    }
    this.transcriptWatchers.clear();
    await this.drainInFlightForShutdown();
    this.backgroundSteerFailureHandlers.clear();
    this.backgroundSteerDeliveredHandlers.clear();
    this.pendingOrchestrationEvents.clear();
    this.cancelAllLifecycleRetries();
    this.cancelAllProviderEventRetries();
  }

  /** Hard ceiling on how long shutdown waits for in-flight turns to unwind. */
  private shutdownDrainTimeoutMs = 3000;

  /**
   * Bounded shutdown drain. `destroyed` is already set, so the loop's
   * destroyed-guards make each chain wind down at its next step. But a provider
   * turn mid-stream (real Cursor/Pi) ignores `destroyed`, so we first ask each
   * active turn to abort — interrupt() where the provider supports it, else
   * dispose() (both provider-agnostic, capability-driven) — then await the
   * in-flight promises against a HARD timeout and proceed with teardown
   * regardless. A hung provider must never hold the daemon's shutdown hostage.
   */
  private async drainInFlightForShutdown(): Promise<void> {
    this.disposeActiveTurns();
    const deadline = Date.now() + this.shutdownDrainTimeoutMs;
    while (Date.now() < deadline) {
      const retainedEvents = this.flushRetainedProviderEventsForShutdown();
      for (const id of [...this.pendingOrchestrationEvents.keys()]) {
        this.drainPendingOrchestrationEvents(id, true);
      }
      const inFlight = [...this.runPromises.values(), ...this.pendingWork];
      if (
        inFlight.length === 0 &&
        !retainedEvents &&
        this.pendingOrchestrationEvents.size === 0
      ) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      const retryDelay = Math.min(100, remaining);
      if (inFlight.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      } else {
        await Promise.race([
          Promise.allSettled(inFlight),
          new Promise((resolve) => setTimeout(resolve, retryDelay)),
        ]);
      }
      // Re-check because a run may have spawned work, or persistence may have
      // recovered for a provider tail / orchestration queue.
    }
  }

  private flushRetainedProviderEventsForShutdown(): boolean {
    let retained = false;
    for (const provider of this.registeredProviders()) {
      let sessionIds: string[];
      try {
        sessionIds = provider.pendingEventSessionIds?.() ?? [];
      } catch {
        continue;
      }
      for (const sessionId of sessionIds) {
        try {
          provider.flushPendingEvents?.(sessionId);
        } catch {
          retained = true;
        }
      }
      try {
        if ((provider.pendingEventSessionIds?.().length ?? 0) > 0) retained = true;
      } catch {
        // A provider that cannot report its queue cannot be drained further.
      }
    }
    return retained;
  }

  /** Fence and release every locally-producing provider before the DB closes. */
  private disposeActiveTurns(): void {
    for (const id of [...this.locallyProducing]) {
      try {
        const session = this.sessions.findById(id);
        if (!session) continue;
        this.disposeProviderSession(session);
      } catch {
        // Best-effort teardown — shutdown proceeds regardless.
      }
    }
  }

  private cancelAllProviderEventRetries(): void {
    for (const provider of this.registeredProviders()) {
      try {
        provider.cancelPendingEventRetries?.();
      } catch {
        // Shutdown must continue even if a provider cleanup hook fails.
      }
    }
  }

  private registeredProviders(): Set<AgentProvider> {
    // Some lean unit modules inject only the registry methods needed by their
    // scenario. Production AgentRegistry exposes both collections.
    const providers = new Set<AgentProvider>();
    if (typeof this.agents.all === 'function') {
      for (const provider of this.agents.all()) providers.add(provider);
    }
    if (typeof this.agents.cli === 'function') providers.add(this.agents.cli());
    for (const id of this.locallyProducing) {
      try {
        const session = this.sessions.findById(id);
        if (!session) continue;
        providers.add(this.agents.resolveForSession(session));
      } catch {
        // Missing providers/read failures cannot abort best-effort shutdown.
      }
    }
    return providers;
  }

  requestProviderApproval(
    sessionId: string,
    request: ProviderRequestInput,
  ): Promise<ProviderRequestResult> {
    this.requireSession(sessionId);
    const requestId = uuidv4().slice(0, 8);
    const record = this.providerRequestRecords.create({
      requestId,
      sessionId,
      provider: request.provider,
      method: request.method,
      ...(request.params !== undefined ? { params: request.params } : {}),
    });

    this.appendAndEmit(sessionId, 'provider_request', this.providerRequestPayload(record));

    return new Promise((resolve) => {
      this.providerRequests.set(requestId, {
        sessionId,
        provider: request.provider,
        method: request.method,
        ...(request.params !== undefined ? { params: request.params } : {}),
        resolve,
      });
    });
  }

  respondProviderRequest(
    sessionId: string,
    requestId: string,
    decision: unknown,
  ): ProviderRequestResult {
    if (decision !== 'approve' && decision !== 'deny') {
      throw new BadRequestException('decision must be approve or deny');
    }
    this.requirePublicMutableSession(sessionId);
    const safeDecision: ProviderRequestDecision = decision;

    if (!this.providerRequestRecords.findPending(sessionId, requestId)) {
      throw new NotFoundException('Provider request not found');
    }

    const pending = this.providerRequests.get(requestId);
    const resolved = this.providerRequestRecords.resolve(requestId, safeDecision);
    if (!resolved) {
      throw new NotFoundException('Provider request not found');
    }

    const result = { requestId, decision: safeDecision };
    this.appendAndEmit(sessionId, 'provider_request_resolved', this.providerRequestPayload(resolved));
    if (pending?.sessionId === sessionId) {
      this.providerRequests.delete(requestId);
      pending.resolve(result);
    }
    return result;
  }

  private hydrateIfNeeded(session: SessionDto): void {
    if (this.events.count(session.id) > 0) return;

    const batch = this.readTranscriptEvents(session);
    if (batch.length === 0) return;
    this.events.appendBatch(session.id, batch);
    const mtime = this.transcriptMtime(session);
    if (mtime !== null) this.transcriptMtimeCache.set(session.id, mtime);
  }

  private refreshTranscriptIfNeeded(session: SessionDto, options: { force?: boolean } = {}): void {
    const currentMtime = this.transcriptMtime(session);
    if (currentMtime === null) return;
    const cachedMtime = this.transcriptMtimeCache.get(session.id);
    if (!options.force && cachedMtime !== undefined && currentMtime === cachedMtime) return;

    const hydrated = this.readTranscriptEvents(session);
    this.transcriptMtimeCache.set(session.id, currentMtime);
    if (hydrated.length === 0) return;

    const toAppend = this.missingTranscriptEvents(session.id, hydrated);
    if (toAppend.length === 0) return;

    const appended = this.events.appendBatch(session.id, toAppend);
    for (const event of appended) {
      this.emit(session.id, event);
    }
    this.appendAndEmit(session.id, 'transcript_refreshed', { added: toAppend.length });
  }

  private readTranscriptEvents(session: SessionDto): Array<{ type: string; payload: unknown }> {
    if (session.cursorBackend === 'cli' && session.cursorChatId && session.workspace) {
      const workspace = session.worktreePath ?? session.workspace;
      return turnsToSessionEvents(this.cursorLocal.readTranscript(session.cursorChatId, workspace));
    }
    if (session.provider === 'pi' && session.providerThreadId) {
      return this.piLocal?.readTranscriptEvents(session.providerThreadId) ?? [];
    }
    return [];
  }

  private transcriptMtime(session: SessionDto): number | null {
    if (session.cursorBackend === 'cli' && session.cursorChatId && session.workspace) {
      const workspace = session.worktreePath ?? session.workspace;
      return this.cursorLocal.transcriptMtime(session.cursorChatId, workspace);
    }
    if (session.provider === 'pi' && session.providerThreadId) {
      return this.piLocal?.transcriptMtime(session.providerThreadId) ?? null;
    }
    return null;
  }

  private transcriptPath(session: SessionDto): string | null {
    if (session.provider === 'pi' && session.providerThreadId) {
      return session.providerThreadId;
    }
    if (session.cursorBackend === 'cli' && session.cursorChatId && session.workspace) {
      const workspace = session.worktreePath ?? session.workspace;
      return this.cursorLocal.transcriptPath(session.cursorChatId, workspace);
    }
    return null;
  }

  private startTranscriptWatch(id: string): void {
    const session = this.sessions.findById(id);
    if (!session) return;
    const path = this.transcriptPath(session);
    if (!path) return;

    const existing = this.transcriptWatchers.get(id);
    if (existing) {
      existing.count += 1;
      return;
    }

    if (!existsSync(path)) return;

    const watcher = this.createTranscriptWatcher(id, path);
    const poller = setInterval(() => this.refreshTranscriptFromWatch(id), 250);
    this.transcriptWatchers.set(id, { ...(watcher ? { watcher } : {}), poller, count: 1 });
  }

  private refreshTranscriptFromWatch(id: string): void {
    if (this.locallyProducing.has(id)) return;
    try {
      this.refreshTranscriptIfNeeded(this.requireSession(id), { force: true });
    } catch {
      // Ignore transient read/session errors so the stream stays alive.
    }
  }

  private createTranscriptWatcher(id: string, path: string): FSWatcher | null {
    try {
      const watcher = watch(path, (eventType) => {
        const entry = this.transcriptWatchers.get(id);
        if (!entry) return;
        if (entry.debounce) clearTimeout(entry.debounce);
        entry.debounce = setTimeout(() => {
          const current = this.transcriptWatchers.get(id);
          if (current) delete current.debounce;
          // The pi SDK may rewrite the file (rename); re-arm the watch so we
          // keep following the new inode at the same path.
          if (eventType === 'rename') {
            if (!existsSync(path)) return;
            this.rearmTranscriptWatch(id, path);
          }
          if (this.locallyProducing.has(id)) return;
          try {
            this.refreshTranscriptIfNeeded(this.requireSession(id), { force: true });
          } catch {
            // Ignore transient read/session errors so the stream stays alive.
          }
        }, 150);
      });
      watcher.on('error', () => {
        // Without this handler an FSWatcher error would crash the process.
        const entry = this.transcriptWatchers.get(id);
        if (!entry || entry.watcher !== watcher) return;
        if (entry.debounce) clearTimeout(entry.debounce);
        delete entry.debounce;
        try {
          watcher.close();
        } catch {
          // Ignore close failures.
        }
        delete entry.watcher;
        setTimeout(() => {
          const current = this.transcriptWatchers.get(id);
          if (!current || current.watcher || !existsSync(path)) return;
          const replacement = this.createTranscriptWatcher(id, path);
          if (replacement) current.watcher = replacement;
        }, 1000);
      });
      return watcher;
    } catch {
      // fs.watch may throw for unsupported or unavailable filesystems.
      return null;
    }
  }

  /** Close and re-create the watch on the same path, preserving the refcount. */
  private rearmTranscriptWatch(id: string, path: string): void {
    const entry = this.transcriptWatchers.get(id);
    if (!entry) return;
    try {
      entry.watcher?.close();
    } catch {
      // Ignore close failures.
    }
    const replacement = this.createTranscriptWatcher(id, path);
    if (replacement) {
      entry.watcher = replacement;
    } else {
      delete entry.watcher;
    }
  }

  private stopTranscriptWatch(id: string): void {
    const entry = this.transcriptWatchers.get(id);
    if (!entry) return;
    entry.count -= 1;
    if (entry.count > 0) return;
    if (entry.debounce) clearTimeout(entry.debounce);
    if (entry.poller) clearInterval(entry.poller);
    try {
      entry.watcher?.close();
    } catch {
      // Ignore watcher close failures.
    }
    this.transcriptWatchers.delete(id);
  }

  private missingTranscriptEvents(
    sessionId: string,
    hydrated: Array<{ type: string; payload: unknown }>,
  ): Array<{ type: string; payload: unknown }> {
    // Dedupe the SAME logical event across its live-stream form (already in the
    // DB) and its hydrated-from-disk form, whose payloads differ: the stream
    // carries images on user messages and richer tool output that the pi
    // transcript on disk drops. Keying on the whole payload therefore treats the
    // same message/tool as new and re-appends it — a duplicate user prompt plus
    // orphan tool_end rows. Key on stable identity only: message text, tool callId.
    // (Session files record user input as user_message, live steers as
    // steer_message — same message, so collapse them to one family.)
    const dedupeKey = (type: string, payload: unknown): string => {
      const family = type === 'steer_message' ? 'user_message' : type;
      const p = (payload ?? {}) as Record<string, unknown>;
      if (family === 'user_message' || family === 'assistant_message') {
        return typeof p.text === 'string' ? `${family}:${p.text}` : `${family}:${JSON.stringify(payload)}`;
      }
      if (family === 'tool_start' || family === 'tool_end') {
        return typeof p.callId === 'string' && p.callId
          ? `${family}:${p.callId}`
          : `${family}:${JSON.stringify(payload)}`;
      }
      return `${family}:${JSON.stringify(payload)}`;
    };
    const existing = this.events.list(sessionId, 0);
    const existingCounts = new Map<string, number>();
    for (const e of existing) {
      const key = dedupeKey(e.type, e.payload);
      existingCounts.set(key, (existingCounts.get(key) ?? 0) + 1);
    }

    const toAppend: Array<{ type: string; payload: unknown }> = [];
    const hydratedCounts = new Map<string, number>();
    for (const e of hydrated) {
      const key = dedupeKey(e.type, e.payload);
      const hydratedCount = (hydratedCounts.get(key) ?? 0) + 1;
      hydratedCounts.set(key, hydratedCount);
      if (hydratedCount > (existingCounts.get(key) ?? 0)) {
        toAppend.push(e);
      }
    }
    return toAppend;
  }

  private requireSession(id: string): SessionDto {
    const session = this.sessions.findById(id);
    if (!session) throw new NotFoundException('Session not found');
    return this.enrichSession(session);
  }

  requirePublicMutableSession(id: string): SessionDto {
    const session = this.requireSession(id);
    if (session.verifyOwner === 'crew') {
      throw new BadRequestException('Crew-owned sessions are read-only outside Crew controls');
    }
    return session;
  }

  private enrichSession(session: SessionDto): SessionDto {
    let provider;
    try {
      provider = this.agents.resolveForSession(session);
    } catch (error) {
      if (!this.isUnknownProviderError(error, session.provider)) throw error;
      return {
        ...session,
        providerAvailable: false,
        supportsInteraction: false,
        supportsInterrupt: false,
        supportsSteerWhileRunning: false,
        supportsImages: false,
        pendingInput: false,
      };
    }
    const capabilities = provider.capabilities;
    return {
      ...session,
      providerAvailable: true,
      supportsInteraction: provider.supportsInteraction?.() ?? false,
      supportsInterrupt: capabilities.interrupt,
      supportsSteerWhileRunning: capabilities.steerWhileRunning,
      supportsImages: capabilities.images,
      // Only a live run can be blocked on you; skip the tail scan otherwise.
      pendingInput:
        session.status === 'RUNNING'
          ? deriveHasPendingInput(this.events.listTail(session.id, PENDING_SCAN_TAIL))
          : false,
    };
  }

  private isUnknownProviderError(error: unknown, providerId: string): boolean {
    return error instanceof BadRequestException && error.message === `Unknown agent provider ${providerId}`;
  }

  private buildAgentRunContext(
    session: SessionDto,
    provider: AgentProvider = this.agents.resolveForSession(session),
  ): AgentRunContext {
    const workspace = session.worktreePath ?? session.workspace ?? undefined;
    const runtimePolicy = this.validateRuntimePolicy(provider, session.runtimePolicy, workspace);
    const transcriptMtimeMs =
      session.cursorBackend === 'cli' && session.cursorChatId && workspace
        ? this.cursorLocal.transcriptMtime(session.cursorChatId, workspace)
        : null;
    const chatStoreMtimeMs =
      session.cursorBackend === 'cli' && session.cursorChatId
        ? this.cursorLocal.chatStoreMtime(session.cursorChatId)
        : null;
    const transcriptTurnEnded =
      session.cursorBackend === 'cli' && session.cursorChatId && workspace
        ? this.cursorLocal.isTranscriptTurnEnded(session.cursorChatId, workspace)
        : false;

    const registeredTools = this.agentTools?.forSession({
      sessionId: session.id,
      projectPath: session.projectPath,
      provider: session.provider,
      model: session.model,
      workspace: session.worktreePath ?? workspace ?? null,
      mcpServerIds: session.mcpServerIds,
    });
    let runtimeEnvironment!: ReturnType<typeof buildAgentRuntimeEnvironment>;
    const runtimeInfoTool = createNuncioRuntimeInfoTool(() => runtimeEnvironment, runtimePolicy);
    const toolsWithRuntimeInfo = {
      ...(registeredTools?.systemPromptAppend
        ? { systemPromptAppend: registeredTools.systemPromptAppend }
        : {}),
      tools: [
        ...(registeredTools?.tools.filter((tool) => tool.name !== runtimeInfoTool.name) ?? []),
        runtimeInfoTool,
      ],
    };
    const tools = runtimeToolsForPolicy(runtimePolicy, toolsWithRuntimeInfo) ?? { tools: [] };
    const effectiveCwd = session.worktreePath ?? workspace ?? null;
    runtimeEnvironment = buildAgentRuntimeEnvironment({
      sessionId: session.id,
      provider: session.provider,
      model: session.model,
      projectPath: session.projectPath,
      cwd: effectiveCwd,
      supportsInteraction: provider.supportsInteraction?.() ?? false,
      runtimePolicy,
      runtimeTools: tools,
    });

    return {
      emit: (event) => this.onAgentEvent(session.id, event),
      requestProviderApproval: (request) => this.requestProviderApproval(session.id, request),
      model: session.model,
      modelOptions: session.modelOptions,
      mode: session.mode,
      workspace,
      cwd: session.worktreePath ?? (runtimePolicy ? workspace : undefined),
      cursorChatId: session.cursorChatId,
      transcriptMtimeMs,
      chatStoreMtimeMs,
      transcriptTurnEnded,
      tools,
      runtimeEnvironment,
      runtimePolicy,
      ...(session.provider === 'codex' ? { codexMcpConfig: this.buildCodexMcpConfig(session) } : {}),
    };
  }

  private buildCodexMcpConfig(session: SessionDto): { mcp_servers: Record<string, { enabled: false }> } | undefined {
    if (!this.mcp) return undefined;
    const resolved = this.mcp.resolveForSession({
      provider: session.provider,
      projectPath: session.projectPath,
      mcpServerIds: session.mcpServerIds,
    });
    const inherited = listInheritedCodexMcpServerNames(
      homedir(),
      session.worktreePath ?? session.projectPath ?? session.workspace,
    );
    if (inherited.length === 0) return undefined;
    const bridgeOwned = new Set(resolved.map((server) => server.name));
    const config = buildCodexMcpSuppressionConfig(inherited, bridgeOwned);
    return Object.keys(config.mcp_servers).length > 0 ? config : undefined;
  }

  private validateMcpServerIds(ids: string[] | null | undefined): string[] | null | undefined {
    if (ids === undefined || ids === null) return ids;
    if (!this.mcp) {
      throw new BadRequestException('MCP store is not available');
    }
    const known = new Set(this.mcp.list().map((server) => server.id));
    const invalid = ids.filter((id) => !known.has(id));
    if (invalid.length > 0) {
      throw new BadRequestException(`unknown MCP server id(s): ${invalid.join(', ')}`);
    }
    return [...new Set(ids)];
  }

  private validateRuntimePolicy(
    provider: AgentProvider,
    policy: AgentRuntimePolicy | null | undefined,
    workspace?: string | null,
  ): AgentRuntimePolicy | undefined {
    try {
      return assertRuntimePolicySupported(policy, provider.capabilities, workspace);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  private transition(
    id: string,
    status: SessionStatus,
    options: { immediate?: boolean; beforeUpdate?: () => void } = {},
  ): void {
    let event: SessionEvent;
    let notifyAfterCommit = false;
    if (this.database) {
      const persist = () => {
        options.beforeUpdate?.();
        this.sessions.updateStatus(id, status);
        const persisted = this.events.append(id, 'status', { status }, false);
        if (persisted.seq <= 0) throw new Error('Status event append did not commit');
        return persisted;
      };
      event = options.immediate
        ? this.database.immediateTransaction(persist)
        : this.database.transaction(persist);
      notifyAfterCommit = true;
    } else {
      options.beforeUpdate?.();
      this.sessions.updateStatus(id, status);
      event = this.events.append(id, 'status', { status });
    }
    if (notifyAfterCommit) this.events.notifyPersisted(id, event);
    this.updateStalledRunWatchForStatus(id, status);
    if (status !== 'RUNNING') this.cancelInterruptForceIdleTimer(id);
    this.emit(id, event);
    if (status === 'IDLE') {
      setTimeout(() => this.drainSteerQueue(id), 0);
    }
  }

  private appendAndEmit(id: string, type: string, payload: unknown): SessionEvent {
    const event = this.events.append(id, type, payload);
    this.emit(id, event);
    return event;
  }

  private onAgentEvent(
    id: string,
    event: { type: string; payload: unknown; seq?: number; createdAt?: number },
  ): void {
    if (
      event.type === 'status' &&
      (event.payload as { status?: unknown } | null)?.status !== 'RUNNING'
    ) {
      this.cancelInterruptForceIdleTimer(id);
    }
    if (typeof event.seq === 'number' && event.seq > 0) {
      this.emit(id, {
        seq: event.seq,
        type: event.type,
        payload: event.payload,
        createdAt: event.createdAt ?? Date.now(),
      });
    } else {
      // Emitter did not append first — fall back to fanning out the stored tail.
      const [latest] = this.events.listTail(id, 1);
      if (latest) this.emit(id, latest);
      else this.emit(id, { seq: 0, type: event.type, payload: event.payload, createdAt: Date.now() });
    }
    this.updateStalledRunWatchForEvent(id, event);
    if (event.type === 'spawn_task_proposed' || event.type === 'spawn_task_dismissed') {
      try {
        this.chipHandler?.onSpawnTaskEvent(id, event);
      } catch {
        // A chip side-effect must never break the session's event fan-out.
      }
    }
    if (event.type === 'reproduce_requested') {
      try {
        this.reproduceHandler?.onReproduceEvent(id, event);
      } catch {
        // A reproduction-gate side-effect must never break the event fan-out.
      }
    }
    if (event.type !== 'status') return;
    const status = (event.payload as { status?: SessionStatus } | null)?.status;
    if (status !== 'IDLE' && status !== 'ERROR') return;
    // Deliver after the finishing run fully unwinds (provider finally blocks).
    setTimeout(() => this.drainSteerQueue(id), 0);
  }

  private updateStalledRunWatchForEvent(
    id: string,
    event: { type: string; payload: unknown },
  ): void {
    if (event.type === 'status') {
      const status = (event.payload as { status?: SessionStatus } | null)?.status;
      if (status) this.updateStalledRunWatchForStatus(id, status);
      return;
    }
    const session = this.sessions.findById(id);
    if (session?.status === 'RUNNING') this.scheduleStalledRunWatch(id);
  }

  private updateStalledRunWatchForStatus(id: string, status: SessionStatus): void {
    if (status === 'RUNNING') {
      this.scheduleStalledRunWatch(id);
      return;
    }
    this.clearStalledRunWatch(id);
  }

  private scheduleStalledRunWatch(id: string): void {
    if (this.destroyed || this.stalledRunForceIdleMs <= 0) return;
    this.clearStalledRunWatch(id);
    const timer = setTimeout(() => this.forceIdleStalledRun(id), this.stalledRunForceIdleMs);
    this.stalledRunTimers.set(id, timer);
  }

  private clearStalledRunWatch(id: string): void {
    const timer = this.stalledRunTimers.get(id);
    if (!timer) return;
    clearTimeout(timer);
    this.stalledRunTimers.delete(id);
  }

  /**
   * Single scheduling point for stalled-run recovery retries. Isolated behind
   * one method so the retry can be driven deterministically instead of racing a
   * wall-clock timer; by default the step re-runs on a fixed backoff.
   */
  private scheduleStalledRunRetry(id: string, run: () => void): void {
    const timer = setTimeout(run, this.stalledRunRetryMs);
    this.stalledRunTimers.set(id, timer);
  }

  private forceIdleStalledRun(id: string): void {
    this.stalledRunTimers.delete(id);
    if (this.destroyed) return;
    const session = this.sessions.findById(id);
    if (!session || session.status !== 'RUNNING') return;
    if (deriveHasPendingInput(this.events.listTail(id, PENDING_SCAN_TAIL))) {
      this.scheduleStalledRunWatch(id);
      return;
    }
    try {
      this.disposeProviderSession(session);
    } catch (error) {
      if (error instanceof RetainedEventFlushError) {
        // Keep the accepted tail before the eventual runtime_stalled/status rows.
        this.scheduleStalledRunRetry(id, () => this.forceIdleStalledRun(id));
        return;
      }
      // Permanent adapter teardown failures must not hot-loop or wedge RUNNING.
    }
    this.locallyProducing.delete(id);
    try {
      this.sessions.updateProviderRuntimeState(id, { providerActiveTurnId: null });
    } catch {
      // Session may have been deleted while the timer was pending.
    }
    this.appendAndEmit(id, 'runtime_stalled', {
      timeoutMs: this.stalledRunForceIdleMs,
      resumable: this.isResumableAfterRestart(session),
    });
    this.finishStalledRunTransition(id);
  }

  private finishStalledRunTransition(id: string): void {
    this.stalledRunTimers.delete(id);
    if (this.destroyed) return;
    let current: SessionDto | null;
    try {
      current = this.sessions.findById(id);
    } catch {
      current = null;
    }
    if (!current) {
      this.scheduleStalledRunRetry(id, () => this.finishStalledRunTransition(id));
      return;
    }
    if (current.status !== 'RUNNING') return;
    try {
      this.transition(id, 'IDLE');
    } catch {
      // runtime_stalled is already durable; retry only the atomic transition to
      // avoid both a zombie RUNNING row and duplicate recovery annotations.
      this.scheduleStalledRunRetry(id, () => this.finishStalledRunTransition(id));
    }
  }

  private getOrCreateBus(id: string): EventEmitter {
    let bus = this.streams.get(id);
    if (!bus) {
      bus = new EventEmitter();
      bus.setMaxListeners(50);
      this.streams.set(id, bus);
    }
    return bus;
  }

  private emit(id: string, event: SessionEvent): void {
    this.getOrCreateBus(id).emit('event', event);
  }

  /** Resolves when the in-flight local run — including post-turn verification — settles. */
  awaitRun(id: string): Promise<void> {
    return this.runPromises.get(id) ?? Promise.resolve();
  }

  /** TasksModule registers the multitask coordinator at boot (one-way edge). */
  registerMultitaskCoordinator(coordinator: MultitaskCoordinator): void {
    this.multitaskCoordinator = coordinator;
  }

  /**
   * Register the spawn-task chip handler (ChipsService). onAgentEvent forwards
   * spawn-task provider events to it so the session layer never imports the
   * chips module — a one-directional edge like the multitask coordinator.
   */
  registerChipHandler(handler: SpawnTaskEventHandler): void {
    this.chipHandler = handler;
  }

  /**
   * Register the reproduction-gate handler (ReproduceService). onAgentEvent
   * forwards `reproduce_requested` provider events to it so the session layer
   * never imports the reproduce module — a one-directional edge like the chips
   * handler.
   */
  registerReproduceHandler(handler: ReproduceEventHandler): void {
    this.reproduceHandler = handler;
  }

  /**
   * A multitask parent's coordinating turn. Holds the parent in RUNNING while
   * the coordinator decomposes the goal, fans children out, and waits for them
   * to settle or the parent to detach — then lands IDLE. Mirrors startRun's
   * run-promise + locallyProducing bookkeeping so awaitRun and shutdown behave.
   * A coordination throw lands the parent in ERROR with a transcript note.
   */
  private startMultitaskRun(session: SessionDto): void {
    const coordinator = this.multitaskCoordinator;
    if (!coordinator) {
      void this.startRun(session);
      return;
    }
    this.locallyProducing.add(session.id);
    const run = (async () => {
      try {
        this.transition(session.id, 'RUNNING');
        await coordinator.coordinate(session, {
          emitParentEvent: (type, payload) => {
            this.appendOrchestrationEvent(session.id, type, payload);
          },
          parentDetached: () => this.sessions.findById(session.id)?.status !== 'RUNNING',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.appendAndEmit(session.id, 'error', { message: `Multitask decomposition failed: ${message}` });
        const current = this.sessions.findById(session.id);
        if (current && canTransition(current.status, 'ERROR')) this.transition(session.id, 'ERROR');
        return;
      } finally {
        this.locallyProducing.delete(session.id);
      }
      // Only settle to IDLE if we still own a RUNNING parent; a detach may have
      // already moved it to PAUSED/ARCHIVED/ERROR, where IDLE is invalid.
      if (this.sessions.findById(session.id)?.status === 'RUNNING') this.transition(session.id, 'IDLE');
    })();
    this.runPromises.set(session.id, run);
    run
      .catch(() => undefined)
      .finally(() => {
        this.settleVerify(session.id);
        if (this.runPromises.get(session.id) === run) this.runPromises.delete(session.id);
      });
  }

  private startRun(session: SessionDto, attachments?: AgentAttachment[]): void {
    if (session.cursorBackend === 'cli') return;
    const persisted = this.persistImageAttachments(session.id, attachments);
    const crewStart = this.beginCrewStart(session);
    this.locallyProducing.add(session.id);
    // Arm loop settlement before the run so a task can awaitVerifySettled and
    // wait for the whole verify-feedback loop, not just the first turn+verify.
    this.armVerifySettlement(session.id);
    const run = (async () => {
      try {
        if (!this.canStartCrewAttempt(crewStart)) return;
        const provider = await this.agents.resolveAvailableForSession(session);
        if (!this.canStartCrewAttempt(crewStart)) return;
        await provider.run(session.id, session.prompt, {
          ...this.buildAgentRunContext(session),
          attachments: persisted,
        });
      } finally {
        this.endCrewStart(session.id, crewStart);
        this.locallyProducing.delete(session.id);
      }
      await this.maybeVerify(session.id);
    })();
    this.runPromises.set(session.id, run);
    // Subscribe a guard so a rejection without an awaitRun caller can't
    // surface as an unhandled rejection; awaiters still see the rejection.
    run
      .catch(() => undefined)
      .finally(() => {
        // The whole loop chain (run + maybeVerify + recursive auto-steers) has
        // unwound here — settle unconditionally so awaitVerifySettled can never
        // hang, even when a run errors (ERROR status skips the IDLE verify path)
        // or the session vanished mid-flight. settleVerify is idempotent.
        this.settleVerify(session.id);
        if (this.runPromises.get(session.id) === run) this.runPromises.delete(session.id);
      });
  }

  /**
   * Post-turn verification: annotate, never block. Runs the project's check
   * command after a local turn settles on IDLE and appends the outcome to the
   * event log; the FSM is untouched so a red suite can't wedge the session.
   */
  private async maybeVerify(sessionId: string): Promise<void> {
    // A shutting-down service must not keep the loop writing events (the DB may be
    // closing/replaced). Settle any waiter and stop.
    if (this.destroyed) {
      this.settleVerify(sessionId);
      return;
    }
    if (this.verifying.has(sessionId)) return;
    const session = this.sessions.findById(sessionId);
    if (!session || session.status !== 'IDLE') {
      this.settleVerify(sessionId);
      return;
    }
    if (session.verifyOwner === 'crew') {
      this.settleVerify(sessionId);
      return;
    }
    const cwd = session.worktreePath ?? session.workspace ?? session.projectPath;
    if (!cwd) {
      this.settleVerify(sessionId);
      return;
    }
    // Per-project override wins over .nuncio/verify + global setting (same
    // precedence as the auto-steer resolution). Falls back to the global chain
    // when no resolver is wired (lean test modules).
    const command = this.projectDefaults
      ? this.projectDefaults.resolveVerifyCommandFor(session.projectPath ?? null, cwd)
      : resolveVerifyCommand(cwd, this.settings?.resolve('NUNCIO_VERIFY_COMMAND'));
    if (!command) {
      this.settleVerify(sessionId);
      return;
    }

    // Skip-on-clean: when the workspace fingerprint has not moved since the
    // last GREEN verify, the result is already known — emit nothing. A red pin
    // never skips (the feedback loop keeps its re-verify semantics) and a
    // non-git workspace (null snapshot) always verifies. The pin's HEAD widens
    // files/classes to work the agent COMMITTED since that green run.
    const pin = latestGreenVerifyPin(this.events.list(sessionId));
    const preSnapshot = await captureWorkspaceDiffSnapshot(cwd, pin?.head);
    // The snapshot await opened a gap since the entry guards: another pass may
    // own the verifier now, or the session may have left IDLE.
    if (this.destroyed || this.verifying.has(sessionId)) return;
    if (this.sessions.findById(sessionId)?.status !== 'IDLE') {
      this.settleVerify(sessionId);
      return;
    }
    if (preSnapshot && pin !== null && pin.fingerprint === preSnapshot.fingerprint) {
      this.settleVerify(sessionId);
      return;
    }

    let result: VerifyResultPayload | null = null;
    const controller = new AbortController();
    this.verifierControllers.set(sessionId, controller);
    this.verifying.add(sessionId);
    try {
      this.appendAndEmit(sessionId, 'verify_start', {
        command: command.display,
        ...(preSnapshot
          ? {
              files: preSnapshot.files,
              filesTotal: preSnapshot.filesTotal,
              classes: preSnapshot.classes,
            }
          : {}),
      });
      const run = await runVerifyCommand(command, cwd, VERIFY_TIMEOUT_MS, controller.signal);
      // The verify command is a spawned shell that can outlive a shutdown; after
      // it resolves the DB handle may be closed. Lifecycle cancellation is not a
      // failed check, so also require the same IDLE session that started it.
      if (
        this.destroyed ||
        controller.signal.aborted ||
        this.sessions.findById(sessionId)?.status !== 'IDLE'
      ) return;
      // The pin fingerprint is captured AFTER the command ran, so state the
      // command itself writes (build outputs, counters) is folded in and a
      // no-op follow-up turn compares equal. The capture is another await gap:
      // re-apply the same discard conditions before appending, or a steer that
      // started mid-capture could freeze its half-edited workspace into a
      // green pin and silently skip its own verify later.
      const postSnapshot = await captureWorkspaceDiffSnapshot(cwd, pin?.head);
      if (
        this.destroyed ||
        controller.signal.aborted ||
        this.sessions.findById(sessionId)?.status !== 'IDLE'
      ) return;
      result = {
        command: command.display,
        ...run,
        ...(postSnapshot
          ? {
              fingerprint: postSnapshot.fingerprint,
              head: postSnapshot.head,
              classes: postSnapshot.classes,
            }
          : {}),
      };
      this.appendAndEmit(sessionId, 'verify_result', result);
    } catch (error) {
      if (
        this.destroyed ||
        controller.signal.aborted ||
        this.sessions.findById(sessionId)?.status !== 'IDLE'
      ) return;
      const message = error instanceof Error ? error.message : String(error);
      result = {
        command: command.display,
        ok: false,
        exitCode: null,
        durationMs: 0,
        outputTail: message,
        timedOut: false,
      };
      this.appendAndEmit(sessionId, 'verify_result', result);
    } finally {
      if (this.verifierControllers.get(sessionId) === controller) {
        this.verifierControllers.delete(sessionId);
      }
      this.verifying.delete(sessionId);
    }

    if (this.destroyed) {
      this.settleVerify(sessionId);
      return;
    }
    if (result && !result.ok) {
      await this.driveVerifyFeedback(sessionId);
    } else {
      // A green verify on a ui-touching turn earns after-evidence. Deliberately
      // NOT awaited: capture can take seconds and must never delay loop
      // settlement (fail-open, annotate-don't-block).
      if (result?.ok && result.classes?.includes('ui')) {
        this.trackPendingWork(this.captureVerifyEvidence(sessionId));
      }
      // Green verify (or nothing to drive): the loop, if any, has settled.
      this.settleVerify(sessionId);
    }
  }

  /**
   * Evidence auto-fallback (doc layer 3): after a green verify on a turn whose
   * dirty classes include `ui`, capture after-evidence — the session's known
   * target first, else the `NUNCIO_EVIDENCE_URL` fallback. Every failure path
   * logs and returns; the verify loop and session status are never touched.
   */
  private async captureVerifyEvidence(sessionId: string): Promise<void> {
    if (!this.evidence || this.destroyed) return;
    const session = this.sessions.findById(sessionId);
    if (!session) return;
    try {
      let outcome = await this.evidence.captureKnown(session, 'after');
      if (outcome === null) {
        const url = this.settings?.resolve('NUNCIO_EVIDENCE_URL')?.trim();
        if (!url) return;
        outcome = await this.evidence.capture(session, { url, phase: 'after' });
      }
      if (this.destroyed || !outcome) return;
      if ('unavailable' in outcome && outcome.unavailable === true) {
        console.warn(`[sessions] verify evidence unavailable for ${sessionId}: ${outcome.reason}`);
        return;
      }
      this.appendAndEmit(sessionId, 'evidence_captured', outcome);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[sessions] verify evidence capture failed for ${sessionId}: ${reason}`);
    }
  }

  /**
   * Whether the auto-fix loop is enabled and its round budget, resolved for the
   * session's project. The per-project override (auto-steer tri-state / max
   * rounds) wins over the global setting; with no resolver or no project row it
   * falls back to the global parse — exactly today's behavior.
   */
  private verifyFeedbackConfig(projectPath: string | null): { enabled: boolean; maxRounds: number } {
    if (this.projectDefaults) {
      return {
        enabled: this.projectDefaults.resolveAutoSteerEnabled(projectPath),
        maxRounds: this.projectDefaults.resolveMaxRounds(projectPath),
      };
    }
    return {
      enabled: parseAutoSteerEnabled(this.settings?.resolve('NUNCIO_VERIFY_AUTO_STEER')),
      maxRounds: parseMaxRounds(this.settings?.resolve('NUNCIO_VERIFY_MAX_ROUNDS')),
    };
  }

  /**
   * Evaluate the verify-feedback loop after a failing verify and take the next
   * step: emit a verify_retry + auto-steer, or emit verify_needs_attention, or
   * do nothing (disabled / already surfaced). Decision folds the durable log, so
   * it is identical live and on boot.
   */
  private async driveVerifyFeedback(sessionId: string): Promise<void> {
    if (this.destroyed) {
      this.settleVerify(sessionId);
      return;
    }
    const session = this.sessions.findById(sessionId);
    if (!session || session.status !== 'IDLE') {
      this.settleVerify(sessionId);
      return;
    }
    if (session.verifyOwner === 'crew') {
      this.settleVerify(sessionId);
      return;
    }
    const { enabled, maxRounds } = this.verifyFeedbackConfig(session.projectPath ?? null);
    if (!enabled) {
      this.settleVerify(sessionId);
      return;
    }

    const state = foldLoopState(this.events.list(sessionId, 0));
    const decision = decideNextStep(state, maxRounds);

    if (decision.kind === 'none') {
      this.settleVerify(sessionId);
      return;
    }
    if (decision.kind === 'needs_attention') {
      this.appendAndEmit(sessionId, 'verify_needs_attention', {
        rounds: decision.rounds,
        reason: decision.reason,
        lastOutputTail: state.lastFail?.outputTail ?? '',
      });
      this.settleVerify(sessionId);
      return;
    }

    // retry: mark the round then auto-steer with the failure output.
    const retryId = uuidv4().slice(0, 12);
    const fail = state.lastFail!;
    this.appendAndEmit(sessionId, 'verify_retry', {
      round: decision.round,
      reason: 'verify_failed',
      command: fail.command,
      outputTail: fail.outputTail,
      retryId,
    });
    await this.autoSteer(sessionId, buildFeedbackMessage(fail), retryId);
  }

  /**
   * Deliver an auto-steer through the normal steer machinery, tagged with its
   * origin/retryId so consumers classify it explicitly. The session must be
   * CLAIMED synchronously (provider.steer's IDLE→RUNNING transition runs before
   * its first await) so a human steer entering concurrently sees RUNNING and
   * queues instead of racing a second turn. A provider failure is surfaced
   * (BaseAgentProvider maps the throw to status:ERROR + error event); the loop
   * then settles rather than spinning.
   */
  private async autoSteer(sessionId: string, message: string, retryId: string): Promise<void> {
    if (this.destroyed) {
      this.settleVerify(sessionId);
      return;
    }
    const session = this.sessions.findById(sessionId);
    if (!session || session.status !== 'IDLE') {
      this.settleVerify(sessionId);
      return;
    }
    if (session.verifyOwner === 'crew') {
      this.settleVerify(sessionId);
      return;
    }
    let provider;
    try {
      // Sync resolve — no availability await before the claim, so the RUNNING
      // transition inside provider.steer lands in this tick and closes the race
      // window. Availability is enforced by the provider's own run path.
      provider = this.agents.resolveForSession(session);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.appendAndEmit(sessionId, 'error', { message: `Auto-steer could not start: ${reason}` });
      this.settleVerify(sessionId);
      return;
    }

    this.locallyProducing.add(sessionId);
    // Kick the steer WITHOUT awaiting yet: provider.steer synchronously claims
    // RUNNING before returning its promise, so any concurrent human steer queues.
    const steering = provider.steer(sessionId, message, {
      ...this.buildAgentRunContext(session),
      steerMeta: { origin: 'verify_retry', retryId },
    });
    try {
      await steering;
    } catch (error) {
      this.locallyProducing.delete(sessionId);
      // Mirror the success path: a shutdown (or deleted session) during the steer
      // means the DB handle may be gone — never touch it after the await.
      if (this.destroyed) {
        this.settleVerify(sessionId);
        return;
      }
      const reason = error instanceof Error ? error.message : String(error);
      if (this.sessions.findById(sessionId)) {
        this.appendAndEmit(sessionId, 'error', { message: `Auto-steer failed: ${reason}` });
      }
      this.settleVerify(sessionId);
      return;
    }
    this.locallyProducing.delete(sessionId);
    // The steer settled IDLE; run the next verify, which continues the loop.
    await this.maybeVerify(sessionId);
  }

  /**
   * Boot scan: resume any verify-feedback loop the durable log shows as live but
   * that no in-process run is driving (the daemon died mid-loop). Idempotent —
   * a pure function of the log — so it is safe every boot.
   */
  private resumeVerifyLoops(): void {
    for (const session of this.sessions.list(false)) {
      if (session.status !== 'IDLE') continue;
      if (session.verifyOwner === 'crew') continue;
      // Per-session gate: a project override may enable the loop even when the
      // global setting is off (and vice versa). resumeOneVerifyLoop re-checks via
      // driveVerifyFeedback, but skipping the disabled ones here avoids needless
      // scheduling.
      if (!this.verifyFeedbackConfig(session.projectPath ?? null).enabled) continue;
      // A durable queued human steer takes precedence (human wins, resets the
      // loop): defer to the steer-queue drain rather than racing an auto-retry
      // ahead of the human steer. The drained steer runs, then its own verify
      // re-evaluates the loop from a fresh boundary.
      if (this.steerQueue.count(session.id) > 0) continue;
      const events = this.events.list(session.id, 0);
      if (events.length === 0) continue;
      const state = foldLoopState(events);
      // A green tail or an already-surfaced loop needs no resume.
      if (!state.lastFail) continue;
      const last = events[events.length - 1]!;
      if (last.type === 'verify_needs_attention' || last.type === 'steer_message') continue;
      const id = session.id;
      setTimeout(() => {
        if (this.destroyed) return;
        // Track the resume chain in pendingWork so the bounded shutdown drain
        // covers it — an untracked boot-resumed auto-steer could otherwise write
        // to a torn-down DB.
        const work = this.resumeOneVerifyLoop(id).catch(() => undefined);
        this.pendingWork.add(work);
        void work.finally(() => this.pendingWork.delete(work));
      }, 0);
    }
  }

  private async resumeOneVerifyLoop(sessionId: string): Promise<void> {
    if (this.destroyed) return;
    const session = this.sessions.findById(sessionId);
    if (!session || session.status !== 'IDLE') return;
    const state = foldLoopState(this.events.list(sessionId, 0));
    // Crash point: a retry marker was written but its auto-steer never sent —
    // re-send exactly that steer (idempotent, keyed on retryId).
    if (state.danglingRetryId && state.lastFail) {
      await this.autoSteer(sessionId, buildFeedbackMessage(state.lastFail), state.danglingRetryId);
      return;
    }
    // Otherwise evaluate the failed verify as if it had just landed.
    await this.driveVerifyFeedback(sessionId);
  }

  /** Resolves once the verify-feedback loop settles (green / needs-attention / no-op). */
  awaitVerifySettled(sessionId: string): Promise<void> {
    return this.verifySettled.get(sessionId)?.promise ?? Promise.resolve();
  }

  /** Arm a fresh settlement deferred at the start of a run/loop. */
  private armVerifySettlement(sessionId: string): void {
    if (this.verifySettled.has(sessionId)) return;
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    this.verifySettled.set(sessionId, { promise, resolve });
  }

  /** Resolve and clear the settlement deferred; the loop reached a terminal state. */
  private settleVerify(sessionId: string): void {
    const entry = this.verifySettled.get(sessionId);
    if (!entry) return;
    this.verifySettled.delete(sessionId);
    entry.resolve();
  }

  private cancelProviderRequests(id: string): void {
    const resolved = this.providerRequestRecords.resolvePendingForSession(
      id,
      'deny',
      'session_disposed',
    );
    for (const record of resolved) {
      const pending = this.providerRequests.get(record.requestId);
      if (pending?.sessionId === id) {
        this.providerRequests.delete(record.requestId);
        pending.resolve({ requestId: record.requestId, decision: 'deny' });
      }
      this.appendAndEmit(id, 'provider_request_resolved', this.providerRequestPayload(record));
    }
  }

  /**
   * A RUNNING row at boot means the previous daemon died mid-turn — no
   * in-process run survives a process replacement. Make the state honest:
   * clear the active turn, record what happened, and settle on IDLE so the
   * user can steer (resumable threads) or restart the task.
   */
  private reconcileInterruptedSessions(): void {
    for (const session of this.sessions.list(false)) {
      if (session.status !== 'RUNNING') continue;
      this.sessions.updateProviderRuntimeState(session.id, { providerActiveTurnId: null });
      this.appendAndEmit(session.id, 'runtime_restarted', {
        resumable: this.isResumableAfterRestart(session),
      });
      this.transition(session.id, 'IDLE');
    }
  }

  /**
   * Queued steers live in SQLite, so they survive a process replacement.
   * Sessions already settled (IDLE/ERROR) get their drain scheduled here;
   * RUNNING sessions drain via the reconcile IDLE transition, and PAUSED
   * sessions keep their queue until the next IDLE, as they would live.
   */
  private restorePendingSteerQueues(): void {
    for (const id of this.steerQueue.sessionIdsWithPending()) {
      const session = this.sessions.findById(id);
      if (!session) continue;
      if (session.status !== 'IDLE' && session.status !== 'ERROR') continue;
      setTimeout(() => this.drainSteerQueue(id), 0);
    }
  }

  private isResumableAfterRestart(session: SessionDto): boolean {
    if (session.cursorBackend === 'cli') return Boolean(session.cursorChatId);
    try {
      return this.agents.resolveForSession(session).canResumeThread?.(session) ?? false;
    } catch {
      return false;
    }
  }

  private resolveStaleProviderRequests(): void {
    const resolved = this.providerRequestRecords.resolveAllPending(
      'deny',
      'server_restarted',
    );
    for (const record of resolved) {
      this.appendAndEmit(
        record.sessionId,
        'provider_request_resolved',
        this.providerRequestPayload(record),
      );
    }
  }

  private providerRequestPayload(record: {
    requestId: string;
    provider: string;
    method: string;
    params?: unknown;
    status: string;
    decision?: ProviderRequestDecision | null;
    reason?: string | null;
  }): Record<string, unknown> {
    return {
      requestId: record.requestId,
      provider: record.provider,
      method: record.method,
      status: record.status,
      ...(record.params !== undefined ? { params: record.params } : {}),
      ...(record.decision ? { decision: record.decision } : {}),
      ...(record.reason ? { reason: record.reason } : {}),
    };
  }
}
