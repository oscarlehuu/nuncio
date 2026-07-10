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
import { v4 as uuidv4 } from 'uuid';
import { AgentRegistry } from '../agents/agents.registry';
import type { AgentAttachment, AgentRunContext } from '../agents/agents.types';
import { AgentToolRegistry } from '../agents/tools/agent-tool-registry';
import { MediaStore } from './media.store';
import { CursorLocalSessionsService } from '../cursor-local/cursor-local-sessions.service';
import { turnsToSessionEvents } from '../cursor-local/cursor-transcript-hydrate';
import { readCursorChatMetadata } from '../cursor-local/cursor-chat-store';
import { ContextFactsService } from '../context/context-facts.service';
import { renderContextFacts } from '../context/context-facts.renderer';
import { materializeContextFile } from '../context/context-file.materializer';
import { GitService } from '../git/git.service';
import type { ModelOptionsMap } from '../models/model-options.types';
import { renderHandoffBrief } from '../orchestration/handoff-brief.renderer';
import { composeSessionPreamble } from '../orchestration/session-preamble';
import { PromptProfileService } from '../prompts/prompt-profile.service';
import { PiLocalSessionsService } from '../pi-local/pi-local-sessions.service';
import { canTransition } from './domain/sessions.fsm';
import { deriveHasPendingInput } from './domain/derive-pending-input';
import type { SessionEventType } from './domain/events.types';
import type {
  CreateSessionDto,
  HandoffSessionDto,
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
  parseAutoSteerEnabled,
  parseMaxRounds,
  type VerifyResultPayload,
} from './verify-feedback';
import { SettingsService } from '../settings/settings.service';
import { ProjectDefaultsResolver } from '../projects/project-defaults-resolver';

type StreamListener = (event: SessionEvent) => void;

const DEFAULT_BACKFILL_LIMIT = 200;

/** Trailing events scanned to decide whether a run is blocked on your input. */
const PENDING_SCAN_TAIL = 200;
const DEFAULT_STALLED_RUN_FORCE_IDLE_MS = 30 * 60 * 1000;

/** Ancestor walk depth cap — bounds cost and survives a manufactured cycle. */
const ANCESTOR_WALK_CAP = 10;

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

@Injectable()
export class SessionsService implements OnModuleDestroy {
  private readonly streams = new Map<string, EventEmitter>();
  private readonly providerRequests = new Map<string, PendingProviderRequest>();
  private readonly transcriptMtimeCache = new Map<string, number>();
  private readonly locallyProducing = new Set<string>();
  private readonly verifying = new Set<string>();
  private readonly runPromises = new Map<string, Promise<void>>();
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
  private readonly interruptRecoveries = new Map<
    string,
    { attempt: symbol; resolve: () => void }
  >();
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
    return this.sessions.list(includeArchived).map((session) => this.enrichSession(session));
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
    if (opts?.tail !== undefined) {
      return this.events.listTail(id, opts.tail);
    }
    if (opts?.before !== undefined) {
      return this.events.listBefore(id, opts.before, opts.limit ?? DEFAULT_BACKFILL_LIMIT);
    }
    return this.events.list(id, since, opts?.limit);
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
    const session = this.requireSession(id);
    if (this.locallyProducing.has(id)) return { added: 0 };
    const before = this.events.list(id, 0).length;
    this.refreshTranscriptIfNeeded(session);
    const after = this.events.list(id, 0).length;
    return { added: Math.max(0, after - before) };
  }

  async create(input: CreateSessionDto): Promise<SessionDto> {
    const providerId = input.provider?.trim() || (await this.agents.defaultId());
    await this.agents.getAvailable(providerId);

    const id = uuidv4().slice(0, 8);
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
        branch = worktree.branch;
        baseBranch = worktree.baseBranch;
      } else {
        workspace = workspace ?? projectPath;
      }
    }

    // The single choke point for the first prompt: handoff brief → project
    // facts → the user's prompt. Both this path and TasksService.execute() (via
    // input.contextBrief) compose here, so the order is guaranteed in one place.
    const prompt = composeSessionPreamble({
      ...(input.contextBrief ? { brief: renderHandoffBrief(input.contextBrief) } : {}),
      ...(projectPath ? { facts: this.renderProjectFacts(projectPath, id) } : {}),
      prompt: input.prompt,
      ...(profile ? { profile } : {}),
    });

    const session = this.sessions.create({
      ...input,
      id,
      prompt,
      provider: providerId,
      workspace,
      projectPath,
      baseBranch,
      worktreePath,
      branch,
      cursorBackend: 'sdk',
    });
    // B4: materialize the engine's native context file into the worktree now
    // that the session row exists (so a skip note can be recorded). Opt-in per
    // project; the preamble injection above is the guarantee, this reinforces it.
    if (worktreePath && projectPath) {
      this.materializeWorktreeContextFile(worktreePath, projectPath, profile?.contextFileName, session.id);
    }
    void this.startRun(session, input.attachments);
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

  async steer(
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
    if (!canTransition(current.status, 'RUNNING')) {
      throw new BadRequestException(`Cannot steer session in status ${current.status}`);
    }

    this.refreshTranscriptIfNeeded(current);

    const provider = await this.agents.resolveAvailableForSession(current);

    this.locallyProducing.add(id);
    try {
      const steering = provider.steer(id, trimmed, {
        ...this.buildAgentRunContext(current),
        attachments: persisted,
        forceResume: forceResume === true,
        ...(origin ? { steerOrigin: origin } : {}),
      });
      this.trackPendingWork(steering);
      await steering;
    } finally {
      this.locallyProducing.delete(id);
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

  private enqueueSteer(
    id: string,
    message: string,
    attachments?: AgentAttachment[],
    origin?: string,
  ): void {
    this.steerQueue.enqueue(id, message, attachments, origin);
    this.appendAndEmit(id, 'steer_queued', { text: message });
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
   * No-op for non-RUNNING sessions or a missing/unavailable provider.
   */
  flushParentBuffer(sessionId: string): void {
    const session = this.sessions.findById(sessionId);
    if (!session || session.status !== 'RUNNING') return;
    try {
      this.agents.resolveForSession(session).flushPendingEvents?.(sessionId);
    } catch {
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
    this.flushParentBuffer(sessionId);
    const event = this.persistOrchestrationEvent(sessionId, type, payload);
    if (event) this.emit(sessionId, event);
    return event;
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

  /** Deliver the next queued steer once the foreground run has settled. */
  private drainSteerQueue(id: string): void {
    // Drain timers can outlive the service; after shutdown the database is
    // closed, so touching the queue would throw from a detached timer.
    if (this.destroyed) return;

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

    // Deliver exactly this row (dequeue removes it); one-per-pass semantics for
    // real steers are preserved.
    this.steerQueue.deleteById(next.id);
    const delivered = next;
    const work = this.steer(id, delivered.message, undefined, delivered.attachments, delivered.origin).catch((error) => {
      const reason = error instanceof Error ? error.message : String(error);
      try {
        this.appendAndEmit(id, 'error', { message: `Queued message failed to send: ${reason}` });
      } catch {
        // Session gone (deleted/archived mid-drain) — nothing left to notify.
      }
    });
    // Track so shutdown awaits it — a fire-and-forget drained steer must not write
    // to a closed DB handle after the module is destroyed.
    this.pendingWork.add(work);
    void work.finally(() => this.pendingWork.delete(work));
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
    const session = this.requireSession(id);
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
    if (outcome.kind === 'recovered') return;
    if (outcome.kind === 'error') {
      if (this.interruptAttempts.get(id) === attempt) this.clearInterruptForceIdleWatch(id);
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
    // A hung provider stream can swallow the abort and leave the run pending
    // forever; if the session is still RUNNING after the grace period, drop
    // the zombie handle and force it idle so the user is never stuck.
    const forceIdle = () => {
      if (this.interruptAttempts.get(id) !== attempt) return;
      this.interruptForceIdleTimers.delete(id);
      try {
        const current = this.sessions.findById(id);
        if (current?.status !== 'RUNNING') {
          this.resolveInterruptRecovery(id, attempt);
          return;
        }
        this.disposeProviderSession(current, true);
        this.locallyProducing.delete(id);
        this.transition(id, 'IDLE');
      } catch {
        // A retained tail still has to commit before the lifecycle status. Retry
        // after the base buffer's short flush window; the SDK is already fenced.
        const retry = setTimeout(forceIdle, Math.min(this.interruptForceIdleMs, 250));
        this.interruptForceIdleTimers.set(id, retry);
        return;
      }
      this.interruptAttempts.delete(id);
      this.resolveInterruptRecovery(id, attempt);
    };
    const timer = setTimeout(forceIdle, this.interruptForceIdleMs);
    this.interruptForceIdleTimers.set(id, timer);
    return recovered;
  }

  private clearInterruptForceIdleWatch(id: string): void {
    this.interruptAttempts.delete(id);
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
    const session = this.requireSession(id);
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
    const session = this.requireSession(id);
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
    const session = this.requireSession(id);
    if (!canTransition(session.status, 'PAUSED')) {
      throw new BadRequestException(`Cannot pause session in status ${session.status}`);
    }
    if (session.status === 'RUNNING') {
      this.disposeProviderSession(session);
    }
    this.cancelProviderRequests(id);
    this.transition(id, 'PAUSED');
    return this.requireSession(id);
  }

  archive(id: string): SessionDto {
    const session = this.requireSession(id);
    if (!canTransition(session.status, 'ARCHIVED')) {
      throw new BadRequestException(`Cannot archive session in status ${session.status}`);
    }
    this.disposeProviderSession(session);
    this.cancelProviderRequests(id);
    this.steerQueue.deleteForSession(id);
    this.transition(id, 'ARCHIVED');
    return this.requireSession(id);
  }

  restore(id: string): SessionDto {
    const session = this.requireSession(id);
    if (session.status !== 'ARCHIVED') {
      throw new BadRequestException(`Cannot restore session in status ${session.status}`);
    }
    this.transition(id, 'IDLE');
    return this.requireSession(id);
  }

  rename(id: string, title: string): SessionDto {
    const trimmed = title.trim();
    if (!trimmed) {
      throw new BadRequestException('Title cannot be empty');
    }
    this.requireSession(id);
    const updated = this.sessions.updateTitle(id, trimmed);
    if (!updated) throw new NotFoundException(`Session ${id} not found`);
    return this.enrichSession(updated);
  }

  delete(id: string): void {
    const session = this.requireSession(id);
    if (session.status !== 'ARCHIVED') {
      throw new BadRequestException(`Cannot delete session in status ${session.status}; archive first`);
    }
    this.disposeProviderSession(session);
    this.cancelProviderRequests(id);
    this.streams.delete(id);
    this.steerQueue.deleteForSession(id);
    this.media?.deleteSession(id);
    this.sessions.delete(id);
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
    for (const controller of this.verifierControllers.values()) controller.abort();
    this.verifierControllers.clear();
    for (const timer of this.interruptForceIdleTimers.values()) clearTimeout(timer);
    this.interruptForceIdleTimers.clear();
    this.interruptAttempts.clear();
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
      const inFlight = [...this.runPromises.values(), ...this.pendingWork];
      if (inFlight.length === 0) return;
      const remaining = deadline - Date.now();
      const timedOut = Symbol('timeout');
      const outcome = await Promise.race([
        Promise.allSettled(inFlight).then(() => 'settled'),
        new Promise((resolve) => setTimeout(() => resolve(timedOut), remaining)),
      ]);
      if (outcome === timedOut) return; // proceed with teardown regardless
      // else loop: awaiting a run may have spawned a drained steer — re-check.
    }
  }

  /** Fence and release every locally-producing provider before the DB closes. */
  private disposeActiveTurns(): void {
    for (const id of [...this.locallyProducing]) {
      const session = this.sessions.findById(id);
      if (!session) continue;
      try {
        this.disposeProviderSession(session);
      } catch {
        // Best-effort teardown — shutdown proceeds regardless.
      }
    }
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

  private buildAgentRunContext(session: SessionDto): AgentRunContext {
    const workspace = session.worktreePath ?? session.workspace ?? undefined;
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

    return {
      emit: (event) => this.onAgentEvent(session.id, event),
      requestProviderApproval: (request) => this.requestProviderApproval(session.id, request),
      model: session.model,
      modelOptions: session.modelOptions,
      workspace,
      cwd: session.worktreePath ?? undefined,
      cursorChatId: session.cursorChatId,
      transcriptMtimeMs,
      chatStoreMtimeMs,
      transcriptTurnEnded,
      tools: this.agentTools?.forSession({
        sessionId: session.id,
        projectPath: session.projectPath,
        provider: session.provider,
        model: session.model,
      }),
    };
  }

  private transition(id: string, status: SessionStatus): void {
    this.sessions.updateStatus(id, status);
    this.updateStalledRunWatchForStatus(id, status);
    if (status !== 'RUNNING') this.cancelInterruptForceIdleTimer(id);
    this.appendAndEmit(id, 'status', { status });
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
    } catch {
      // Keep the accepted tail before the eventual runtime_stalled/status rows.
      const retry = setTimeout(() => this.forceIdleStalledRun(id), 250);
      this.stalledRunTimers.set(id, retry);
      return;
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
    this.transition(id, 'IDLE');
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

  private startRun(session: SessionDto, attachments?: AgentAttachment[]): void {
    if (session.cursorBackend === 'cli') return;
    const persisted = this.persistImageAttachments(session.id, attachments);
    this.locallyProducing.add(session.id);
    // Arm loop settlement before the run so a task can awaitVerifySettled and
    // wait for the whole verify-feedback loop, not just the first turn+verify.
    this.armVerifySettlement(session.id);
    const run = (async () => {
      try {
        const provider = await this.agents.resolveAvailableForSession(session);
        await provider.run(session.id, session.prompt, {
          ...this.buildAgentRunContext(session),
          attachments: persisted,
        });
      } finally {
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

    let result: VerifyResultPayload | null = null;
    const controller = new AbortController();
    this.verifierControllers.set(sessionId, controller);
    this.verifying.add(sessionId);
    try {
      this.appendAndEmit(sessionId, 'verify_start', { command: command.display });
      const run = await runVerifyCommand(command, cwd, VERIFY_TIMEOUT_MS, controller.signal);
      // The verify command is a spawned shell that can outlive a shutdown; after
      // it resolves the DB handle may be closed. Lifecycle cancellation is not a
      // failed check, so also require the same IDLE session that started it.
      if (
        this.destroyed ||
        controller.signal.aborted ||
        this.sessions.findById(sessionId)?.status !== 'IDLE'
      ) return;
      result = { command: command.display, ...run };
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
      // Green verify (or nothing to drive): the loop, if any, has settled.
      this.settleVerify(sessionId);
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
