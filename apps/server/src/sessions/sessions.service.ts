import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter } from 'events';
import { homedir } from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { AgentRegistry } from '../agents/agents.registry';
import type { AgentRunContext } from '../agents/agents.types';
import { CursorLocalSessionsService } from '../cursor-local/cursor-local-sessions.service';
import { turnsToSessionEvents } from '../cursor-local/cursor-transcript-hydrate';
import { readCursorChatMetadata } from '../cursor-local/cursor-chat-store';
import { GitService } from '../git/git.service';
import { canTransition } from './domain/sessions.fsm';
import type {
  CreateSessionDto,
  HandoffSessionDto,
  ProviderRequestDecision,
  ProviderRequestInput,
  ProviderRequestResult,
  RespondInteractionDto,
  SessionDto,
  SessionEvent,
  SessionStatus,
} from './domain/sessions.types';
import { isCursorCliRecentlyActive } from '../agents/providers/cursor-cli.active-run';
import { EventsRepository } from './persistence/events.repository';
import { ProviderRequestsRepository } from './persistence/provider-requests.repository';
import { SessionsRepository } from './persistence/sessions.repository';

type StreamListener = (event: SessionEvent) => void;

interface PendingProviderRequest {
  sessionId: string;
  provider: string;
  method: string;
  params?: unknown;
  resolve: (result: ProviderRequestResult) => void;
}

@Injectable()
export class SessionsService {
  private readonly streams = new Map<string, EventEmitter>();
  private readonly providerRequests = new Map<string, PendingProviderRequest>();
  private readonly transcriptMtimeCache = new Map<string, number>();

  constructor(
    private readonly sessions: SessionsRepository,
    private readonly events: EventsRepository,
    private readonly providerRequestRecords: ProviderRequestsRepository,
    private readonly agents: AgentRegistry,
    private readonly git: GitService,
    private readonly cursorLocal: CursorLocalSessionsService,
  ) {
    this.resolveStaleProviderRequests();
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

  getEvents(id: string, since = 0): SessionEvent[] {
    const session = this.requireSession(id);
    this.hydrateIfNeeded(session);
    return this.events.list(id, since);
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
      } else {
        workspace = workspace ?? projectPath;
      }
    }

    const session = this.sessions.create({
      ...input,
      id,
      provider: providerId,
      workspace,
      projectPath,
      baseBranch,
      worktreePath,
      branch,
      cursorBackend: 'sdk',
    });
    void this.startRun(session);
    return this.enrichSession(session);
  }

  async handoff(input: HandoffSessionDto): Promise<SessionDto> {
    const chatId = input.cursorChatId?.trim();
    const workspace = input.workspace?.trim();
    if (!chatId) throw new BadRequestException('cursorChatId is required');
    if (!workspace) throw new BadRequestException('workspace is required');

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
    });
    this.hydrateIfNeeded(session);
    const refreshed = this.sessions.findById(session.id)!;
    return this.enrichSession(refreshed);
  }

  async steer(id: string, message: string, forceResume?: boolean): Promise<SessionDto> {
    this.requireSession(id);
    const trimmed = message?.trim();
    if (!trimmed) {
      throw new BadRequestException('message is required');
    }

    const current = this.requireSession(id);
    if (!canTransition(current.status, 'RUNNING')) {
      throw new BadRequestException(`Cannot steer session in status ${current.status}`);
    }

    this.refreshTranscriptIfNeeded(current);

    const provider = await this.agents.resolveAvailableForSession(current);

    await provider.steer(id, trimmed, {
      ...this.buildAgentRunContext(current),
      forceResume: forceResume === true,
    });
    return this.requireSession(id);
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
      this.agents.resolveForSession(session).dispose(id);
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
    this.agents.resolveForSession(session).dispose(id);
    this.cancelProviderRequests(id);
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
    this.agents.resolveForSession(session).dispose(id);
    this.cancelProviderRequests(id);
    this.streams.delete(id);
    this.sessions.delete(id);
  }

  subscribe(id: string, listener: StreamListener): () => void {
    const bus = this.getOrCreateBus(id);
    const handler = (event: SessionEvent) => listener(event);
    bus.on('event', handler);
    return () => bus.off('event', handler);
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
    if (session.cursorBackend !== 'cli' || !session.cursorChatId || !session.workspace) return;
    if (this.events.count(session.id) > 0) return;

    const turns = this.cursorLocal.readTranscript(session.cursorChatId, session.workspace);
    const batch = turnsToSessionEvents(turns);
    if (batch.length === 0) return;
    this.events.appendBatch(session.id, batch);
    const workspace = session.worktreePath ?? session.workspace;
    const mtime = this.cursorLocal.transcriptMtime(session.cursorChatId, workspace);
    if (mtime !== null) this.transcriptMtimeCache.set(session.id, mtime);
  }

  private refreshTranscriptIfNeeded(session: SessionDto): void {
    if (session.cursorBackend !== 'cli' || !session.cursorChatId || !session.workspace) return;

    const workspace = session.worktreePath ?? session.workspace;
    const currentMtime = this.cursorLocal.transcriptMtime(session.cursorChatId, workspace);
    if (currentMtime === null) return;
    const cachedMtime = this.transcriptMtimeCache.get(session.id);
    if (cachedMtime !== undefined && currentMtime === cachedMtime) return;

    const turns = this.cursorLocal.readTranscript(session.cursorChatId, workspace);
    const hydrated = turnsToSessionEvents(turns);
    this.transcriptMtimeCache.set(session.id, currentMtime);
    if (hydrated.length === 0) return;

    const existing = this.events.list(session.id, 0);
    const existingCounts = new Map<string, number>();
    for (const e of existing) {
      const key = `${e.type}:${JSON.stringify(e.payload)}`;
      existingCounts.set(key, (existingCounts.get(key) ?? 0) + 1);
    }

    const toAppend: Array<{ type: string; payload: unknown }> = [];
    const hydratedCounts = new Map<string, number>();
    for (const e of hydrated) {
      const key = `${e.type}:${JSON.stringify(e.payload)}`;
      const hydratedCount = (hydratedCounts.get(key) ?? 0) + 1;
      hydratedCounts.set(key, hydratedCount);
      if (hydratedCount > (existingCounts.get(key) ?? 0)) {
        toAppend.push(e);
      }
    }
    if (toAppend.length === 0) return;

    const appended = this.events.appendBatch(session.id, toAppend);
    for (const event of appended) {
      this.emit(session.id, event);
    }
    this.appendAndEmit(session.id, 'transcript_refreshed', { added: toAppend.length });
  }

  private requireSession(id: string): SessionDto {
    const session = this.sessions.findById(id);
    if (!session) throw new NotFoundException('Session not found');
    return this.enrichSession(session);
  }

  private enrichSession(session: SessionDto): SessionDto {
    return {
      ...session,
      supportsInteraction: this.agents.supportsInteractionForSession(session),
    };
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
    };
  }

  private transition(id: string, status: SessionStatus): void {
    this.sessions.updateStatus(id, status);
    this.appendAndEmit(id, 'status', { status });
  }

  private appendAndEmit(id: string, type: string, payload: unknown): SessionEvent {
    const event = this.events.append(id, type, payload);
    this.emit(id, event);
    return event;
  }

  private onAgentEvent(id: string, event: { type: string; payload: unknown }): void {
    const events = this.events.list(id);
    const latest = events[events.length - 1];
    if (latest) this.emit(id, latest);
    else this.emit(id, { seq: 0, type: event.type, payload: event.payload, createdAt: Date.now() });
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

  private startRun(session: SessionDto): void {
    if (session.cursorBackend === 'cli') return;
    void (async () => {
      const provider = await this.agents.resolveAvailableForSession(session);
      await provider.run(session.id, session.prompt, {
        emit: (event) => this.onAgentEvent(session.id, event),
        requestProviderApproval: (request) =>
          this.requestProviderApproval(session.id, request),
        model: session.model,
        modelOptions: session.modelOptions,
        workspace: session.worktreePath ?? session.workspace ?? undefined,
        cwd: session.worktreePath ?? undefined,
        cursorChatId: session.cursorChatId,
      });
    })();
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
