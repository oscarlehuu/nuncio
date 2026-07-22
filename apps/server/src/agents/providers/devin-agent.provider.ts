import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { accessSync, constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ModelProviderDto } from '../../models/models.types';
import { EventsRepository } from '../../sessions/persistence/events.repository';
import { SessionsRepository } from '../../sessions/persistence/sessions.repository';
import { SettingsService } from '../../settings/settings.service';
import { AgentRunCancelledError, BaseAgentProvider } from '../agents.base-provider';
import type { AgentRunContext, EventEmitter } from '../agents.types';
import {
  DevinAcpClient,
  DevinAcpRequestError,
  DevinAcpStdioTransport,
  type DevinAcpClientLike,
  type DevinAcpError,
  type DevinAcpNotification,
  type DevinAcpRequest,
} from './devin-acp.client';
import {
  isAcpToolTerminal,
  mapAcpPlan,
  mapAcpToolCall,
  mapPermissionDecision,
} from './devin-acp.mappers';

interface ActiveTurn {
  generation: number;
  emit?: EventEmitter;
  approval?: AgentRunContext['requestProviderApproval'];
  text: string;
  interrupting: boolean;
  settlement: 'pending' | 'completed' | 'cancelled' | 'failed';
  done?: {
    resolve: () => void;
    reject: (error: Error) => void;
  };
}

interface PendingCancel {
  promise: Promise<void>;
}

interface Active {
  client: DevinAcpClientLike;
  threadId: string;
  cwd: string;
  nextTurnGeneration: number;
  turn?: ActiveTurn;
  cancelInFlight?: PendingCancel;
  unsub: Array<() => void>;
}

const MODELS = [
  'swe-1-7',
  'swe-1-7-medium',
  'swe-1-7-lightning',
  'adaptive',
  'claude-opus-4-8-medium',
  'claude-sonnet-5-medium',
  'gpt-5-6-sol-medium',
].map((id) => ({
  id: `devin:${id}`,
  name: id === 'swe-1-7' ? 'SWE-1.7 Max' : id,
  sub: 'Devin ACP model',
}));

const MODEL_CATALOG: ModelProviderDto[] = [
  {
    id: 'devin',
    name: 'Devin',
    sub: 'Devin CLI via ACP',
    icon: '◆',
    groups: [
      {
        id: 'devin',
        name: 'Devin',
        models: MODELS,
      },
    ],
  },
];

@Injectable()
export class DevinAgentProvider extends BaseAgentProvider implements OnModuleDestroy {
  readonly id = 'devin';
  readonly name = 'Devin';
  readonly capabilities = {
    interrupt: true,
    modelSwitch: 'in-session',
    effortSwitch: 'none',
    images: true,
    steerWhileRunning: false,
  } as const;
  private readonly active = new Map<string, Active>();
  private availableCache?: boolean;
  clientFactory?: (input: { binaryPath: string; cwd: string; env: NodeJS.ProcessEnv }) => DevinAcpClientLike;
  commandRunner: (
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ) => { status: number | null } = (command, args, env) =>
    spawnSync(command, args, { env, stdio: 'ignore' });
  constructor(
    sessions: SessionsRepository,
    events: EventsRepository,
    private readonly settings: SettingsService,
  ) {
    super(sessions, events);
  }

  async isAvailable(): Promise<boolean> {
    if (this.availableCache !== undefined) return this.availableCache;
    const binary = this.binaryPath();
    const creds =
      process.env.WINDSURF_API_KEY ||
      join(homedir(), '.local/share/devin/credentials.toml');
    this.availableCache = Boolean(
      binary &&
        (process.env.WINDSURF_API_KEY || existsSync(creds)) &&
        this.commandRunner(binary, ['auth', 'status'], { ...process.env }).status === 0,
    );
    return this.availableCache;
  }

  bustCache(): void {
    this.availableCache = undefined;
  }

  canResumeThread(session: { providerThreadId: string | null }): boolean {
    return Boolean(session.providerThreadId);
  }

  async listModels(): Promise<ModelProviderDto[]> {
    return (await this.isAvailable()) ? MODEL_CATALOG : [];
  }

  onModuleDestroy(): void {
    for (const id of this.active.keys()) this.dispose(id);
  }

  async interrupt(sessionId: string): Promise<void> {
    const active = this.active.get(sessionId);
    if (!active) return;
    if (active.cancelInFlight) return active.cancelInFlight.promise;
    const turn = active.turn;
    if (!turn) return;
    turn.interrupting = true;

    let operation!: PendingCancel;
    const promise = this.cancelTurn(sessionId, active, turn).finally(() => {
      if (active.cancelInFlight === operation) active.cancelInFlight = undefined;
    });
    operation = { promise };
    active.cancelInFlight = operation;
    return promise;
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    const active = this.active.get(sessionId);
    if (!active) return;
    await active.client.request('session/set_config_option', {
      sessionId: active.threadId,
      configId: 'model',
      value: this.model(model),
    });
  }

  protected disposeRuntime(sessionId: string): void {
    const active = this.active.get(sessionId);
    if (active) this.close(sessionId, active);
  }

  protected async executePrompt(
    sessionId: string,
    text: string,
    isSteer: boolean,
    context: AgentRunContext,
  ): Promise<void> {
    const active = await this.ensure(sessionId, context);
    await this.waitForCancel(sessionId, active);
    if (isSteer && !active.threadId) throw new Error('Devin session is not resumable.');

    const turn: ActiveTurn = {
      generation: ++active.nextTurnGeneration,
      emit: context.emit,
      approval: context.requestProviderApproval,
      text: '',
      interrupting: false,
      settlement: 'pending',
    };
    let done!: NonNullable<ActiveTurn['done']>;
    const completion = new Promise<void>((resolve, reject) => {
      done = {
        resolve: () => resolve(),
        reject: (error) => reject(error),
      };
      turn.done = done;
    });
    active.turn = turn;
    const prompt = [
      { type: 'text', text },
      ...(context.attachments ?? []).map((attachment) => ({
        type: 'image',
        data: attachment.data,
        mimeType: attachment.mimeType,
      })),
    ];
    try {
      await Promise.all([
        active.client.request('session/prompt', {
          sessionId: active.threadId,
          prompt,
        }, null),
        completion,
      ]);
      turn.settlement = 'completed';
    } catch (error) {
      if (turn.interrupting && this.isPromptCancellation(error)) {
        turn.settlement = 'cancelled';
        try {
          await active.cancelInFlight?.promise;
        } catch (cancelError) {
          turn.settlement = 'failed';
          throw cancelError;
        }
        throw new AgentRunCancelledError('Devin ACP turn interrupted.');
      }
      turn.settlement = 'failed';
      throw error;
    } finally {
      if (turn.done === done) turn.done = undefined;
      if (
        this.ownsTurn(active, turn.generation) &&
        (turn.settlement !== 'cancelled' || !turn.interrupting)
      ) {
        active.turn = undefined;
      }
    }
  }

  private async ensure(sessionId: string, context: AgentRunContext): Promise<Active> {
    const current = this.active.get(sessionId);
    if (current) return current;
    const cwd = context.cwd ?? context.workspace ?? process.cwd();
    const binary = this.binaryPath() ?? 'devin';
    const env = {
      ...process.env,
      PATH: `${homedir()}/.local/bin:${process.env.PATH ?? ''}`,
    };
    const client =
      this.clientFactory?.({ binaryPath: binary, cwd, env }) ??
      new DevinAcpClient(
        DevinAcpStdioTransport.spawn({ binaryPath: binary, cwd, env }),
      );
    const active: Active = {
      client,
      threadId: '',
      cwd,
      nextTurnGeneration: 0,
      unsub: [],
    };
    try {
      active.unsub.push(
        client.onNotification((n) => this.notification(sessionId, active, n)),
      );
      active.unsub.push(
        client.onServerRequest((r) => {
          void this.serverRequest(sessionId, active, r).catch((error) => {
            this.respondServerError(active, r.id, error);
          });
        }),
      );
      active.unsub.push(
        client.onClose((error) => this.close(sessionId, active, error)),
      );
      await client.initialize();
      const persisted = this.sessions.findById(sessionId)?.providerThreadId;
      let response: { sessionId?: string };
      let resumed = persisted;
      if (persisted) {
        try {
          response = await client.request<{ sessionId?: string }>('session/load', {
            sessionId: persisted,
            cwd,
            mcpServers: [],
          });
        } catch (error) {
          if (!this.isMissingResume(error)) throw error;
          this.sessions.updateProviderRuntimeState(sessionId, { providerThreadId: null });
          resumed = null;
          response = await client.request<{ sessionId?: string }>('session/new', {
            cwd,
            mcpServers: [],
          });
        }
      } else {
        response = await client.request<{ sessionId?: string }>('session/new', {
          cwd,
          mcpServers: [],
        });
      }
      active.threadId = response.sessionId ?? resumed ?? '';
      if (!active.threadId) throw new Error('Devin ACP session response did not include a session id.');
      const model = this.model(context.model);
      this.sessions.updateProviderRuntimeState(sessionId, {
        providerThreadId: active.threadId,
        providerState: {
          ...(this.sessions.findById(sessionId)?.providerState ?? {}),
          model,
        },
      });
      // Default ACP mode is accept-edits; Nuncio sets the configured permission
      // mode (bypass by default) so solo sessions do not stall on every shell call.
      await client.request('session/set_config_option', {
        sessionId: active.threadId,
        configId: 'mode',
        value: this.permissionMode(),
      });
      if (model !== 'swe-1-7') {
        await client.request('session/set_config_option', {
          sessionId: active.threadId,
          configId: 'model',
          value: model,
        });
      }
      this.active.set(sessionId, active);
      return active;
    } catch (error) {
      try {
        this.releaseClient(active);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Devin ACP setup and cleanup failed.');
      }
      throw error;
    }
  }
  private notification(sessionId: string, active: Active, n: DevinAcpNotification): void {
    const p = n.params as
      | {
          update?: {
            sessionUpdate?: string;
            content?: { text?: string } | unknown;
            toolCallId?: string;
            title?: string;
            kind?: string;
            status?: string;
            rawInput?: unknown;
            entries?: unknown;
          };
          sessionId?: string;
        }
      | undefined;
    const u = p?.update;
    const turn = active.turn;
    if (n.method === '_cognition.ai/agent_stopped') {
      const done = turn?.done;
      if (turn) turn.done = undefined;
      if (turn && done) {
        if (!turn.interrupting) {
          this.pushEvent(
            sessionId,
            'assistant_message',
            { text: turn.text || '(no response)' },
            turn.emit,
          );
        }
        done.resolve();
      }
      return;
    }
    if (!u || !turn) return;
    const text =
      u.content && typeof u.content === 'object' && !Array.isArray(u.content)
        ? (u.content as { text?: string }).text
        : undefined;
    if (u.sessionUpdate === 'agent_message_chunk' && text) {
      turn.text += text;
      this.pushEvent(sessionId, 'assistant_delta', { delta: text }, turn.emit);
    } else if (u.sessionUpdate === 'agent_thought_chunk' && text) {
      this.pushEvent(sessionId, 'thinking_delta', { delta: text }, turn.emit);
    } else if (u.sessionUpdate === 'tool_call') {
      const mapped = mapAcpToolCall(u);
      if (mapped) {
        this.pushEvent(
          sessionId,
          'tool_start',
          {
            callId: mapped.callId,
            tool: mapped.tool,
            ...(mapped.input !== undefined ? { input: mapped.input } : {}),
          },
          turn.emit,
        );
      }
    } else if (u.sessionUpdate === 'tool_call_update') {
      if (!isAcpToolTerminal(u.status)) return;
      const mapped = mapAcpToolCall(u);
      if (mapped) {
        this.pushEvent(
          sessionId,
          'tool_end',
          {
            callId: mapped.callId,
            tool: mapped.tool,
            ...(mapped.isError ? { isError: true } : {}),
            ...(mapped.output !== undefined ? { output: mapped.output } : {}),
          },
          turn.emit,
        );
      }
    } else if (u.sessionUpdate === 'plan') {
      const plan = mapAcpPlan(u);
      if (plan) this.pushEvent(sessionId, 'plan_updated', plan, turn.emit);
    } else if (u.sessionUpdate === 'session_info_update' && u.title) {
      this.pushEvent(sessionId, 'session_title', { title: u.title }, turn.emit);
    }
  }

  private async serverRequest(sessionId: string, active: Active, request: DevinAcpRequest): Promise<void> {
    if (request.method === 'fs/read_text_file' || request.method === 'fs/write_text_file') {
      const p = request.params as { path?: unknown; content?: unknown } | undefined;
      if (!p || typeof p.path !== 'string' || p.path.length === 0) {
        this.respondServerError(active, request.id, {
          code: -32602,
          message: 'File path is required',
        });
        return;
      }
      const path = resolve(active.cwd, p.path);
      try {
        if (request.method === 'fs/read_text_file') {
          const { readFile } = await import('node:fs/promises');
          active.client.respond(request.id, {
            content: await readFile(path, 'utf8'),
          });
        } else {
          if (p.content !== undefined && typeof p.content !== 'string') {
            this.respondServerError(active, request.id, {
              code: -32602,
              message: 'File content must be text',
            });
            return;
          }
          const { writeFile } = await import('node:fs/promises');
          await writeFile(path, p.content ?? '', 'utf8');
          active.client.respond(request.id, {});
        }
      } catch (error) {
        this.respondServerError(active, request.id, error);
      }
      return;
    }

    // Mirror Codex: the SessionsService approval hook owns the transcript card.
    // Emitting provider_request here as well duplicates the UI and desyncs requestIds.
    const turn = active.turn;
    const result = turn?.approval
      ? await turn.approval({
          provider: this.id,
          method: request.method,
          ...(request.params !== undefined ? { params: request.params } : {}),
        })
      : { requestId: String(request.id), decision: 'deny' as const };

    active.client.respond(request.id, mapPermissionDecision(result.decision, request.params));

    if (!turn?.approval) {
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
        turn?.emit,
      );
      this.pushEvent(
        sessionId,
        'provider_request_resolved',
        {
          requestId: String(request.id),
          provider: this.id,
          method: request.method,
          status: 'resolved',
          decision: result.decision,
        },
        turn?.emit,
      );
    }
  }

  private async cancelTurn(
    sessionId: string,
    active: Active,
    turn: ActiveTurn,
  ): Promise<void> {
    try {
      await active.client.request('session/cancel', {
        sessionId: active.threadId,
      });
    } catch (error) {
      if (this.active.get(sessionId) === active && this.ownsTurn(active, turn.generation)) {
        turn.interrupting = false;
        if (turn.settlement !== 'pending') active.turn = undefined;
      }
      throw error;
    }

    if (
      this.active.get(sessionId) !== active ||
      !this.ownsTurn(active, turn.generation) ||
      turn.settlement === 'completed' ||
      turn.settlement === 'failed'
    ) {
      return;
    }
    this.close(
      sessionId,
      active,
      new AgentRunCancelledError('Devin ACP turn interrupted.'),
    );
    this.pushEvent(sessionId, 'status', { status: 'IDLE' }, turn.emit);
  }

  private async waitForCancel(sessionId: string, active: Active): Promise<void> {
    while (active.cancelInFlight) {
      const operation = active.cancelInFlight;
      try {
        await operation.promise;
      } catch {
        // The caller that requested cancellation receives its error. A turn that
        // already settled naturally may continue once the control RPC is done.
      }
    }
    if (this.active.get(sessionId) !== active) {
      throw new AgentRunCancelledError('Devin ACP session closed before the next turn.');
    }
  }

  private ownsTurn(active: Active, generation: number): boolean {
    return active.turn?.generation === generation;
  }

  private isPromptCancellation(error: unknown): boolean {
    if (error instanceof AgentRunCancelledError) return true;
    if (error instanceof DevinAcpRequestError && error.rpcError.code === -32800) return true;
    return error instanceof Error && /cancel|interrupt/i.test(error.message);
  }

  private isMissingResume(error: unknown): boolean {
    return error instanceof DevinAcpRequestError &&
      error.rpcError.code === -32602 &&
      /^Session not found\.?$/i.test(error.rpcError.message.trim());
  }

  private releaseClient(active: Active): void {
    const unsubscribers = active.unsub.splice(0);
    try {
      for (const unsubscribe of unsubscribers) unsubscribe();
    } finally {
      active.client.close();
    }
  }

  private respondServerError(
    active: Active,
    id: string | number,
    error: unknown,
  ): void {
    let rpcError: DevinAcpError;
    if (
      error &&
      typeof error === 'object' &&
      typeof (error as { code?: unknown }).code === 'number' &&
      typeof (error as { message?: unknown }).message === 'string'
    ) {
      const value = error as { code: number; message: string; data?: unknown };
      rpcError = {
        code: value.code,
        message: value.message,
        ...(value.data !== undefined ? { data: value.data } : {}),
      };
    } else {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      rpcError = code === 'ENOENT'
        ? { code: -32002, message: 'File not found' }
        : typeof code === 'string'
          ? { code: -32603, message: 'Filesystem request failed' }
          : { code: -32603, message: 'ACP client request failed' };
    }
    try {
      active.client.respondError(id, rpcError);
    } catch {
      // The ACP process is already gone; its close callback owns turn teardown.
    }
  }

  private close(sessionId: string, active: Active, error?: Error): void {
    if (this.active.get(sessionId) !== active) return;
    this.active.delete(sessionId);
    const turn = active.turn;
    active.turn = undefined;
    const done = turn?.done;
    if (turn) turn.done = undefined;
    if (done) {
      done.reject(error ?? new Error('Devin ACP session closed.'));
    }
    this.releaseClient(active);
  }

  private model(value: string | null | undefined): string {
    return value?.startsWith('devin:') ? value.slice(6) : value || 'swe-1-7';
  }

  /** ACP session modes advertised by `devin acp` (configId `mode`). */
  private permissionMode(): 'bypass' | 'accept-edits' | 'ask' | 'plan' {
    const value = this.settings.resolve('NUNCIO_DEVIN_PERMISSION_MODE')?.trim();
    switch (value) {
      case 'bypass':
      case 'accept-edits':
      case 'ask':
      case 'plan':
        return value;
      default:
        return 'bypass';
    }
  }

  private binaryPath(): string | undefined {
    const configured =
      this.settings.resolve('NUNCIO_DEVIN_BIN')?.trim() || process.env.NUNCIO_DEVIN_BIN?.trim();
    const candidates = [
      configured,
      `${homedir()}/.local/bin/devin`,
      ...(process.env.PATH ?? '').split(':').map((dir) => join(dir, 'devin')),
    ].filter((value): value is string => Boolean(value));
    return candidates.find((path) => {
      try {
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  }
}
