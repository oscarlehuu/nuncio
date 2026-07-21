import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { accessSync, constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ModelProviderDto } from '../../models/models.types';
import { EventsRepository } from '../../sessions/persistence/events.repository';
import { SessionsRepository } from '../../sessions/persistence/sessions.repository';
import { SettingsService } from '../../settings/settings.service';
import { BaseAgentProvider } from '../agents.base-provider';
import type { AgentRunContext, EventEmitter } from '../agents.types';
import {
  DevinAcpClient,
  DevinAcpStdioTransport,
  type DevinAcpClientLike,
  type DevinAcpNotification,
  type DevinAcpRequest,
} from './devin-acp.client';
import {
  isAcpToolTerminal,
  mapAcpToolCall,
  mapPermissionDecision,
} from './devin-acp.mappers';

interface Active {
  client: DevinAcpClientLike;
  threadId: string;
  cwd: string;
  emit?: EventEmitter;
  approval?: AgentRunContext['requestProviderApproval'];
  text: string;
  done?: {
    resolve: () => void;
    reject: (error: Error) => void;
  };
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
    try {
      await active.client.request('session/cancel', {
        sessionId: active.threadId,
      });
    } finally {
      this.close(sessionId, active);
    }
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
    active.emit = context.emit;
    active.approval = context.requestProviderApproval;
    active.text = '';
    if (isSteer && !active.threadId) throw new Error('Devin session is not resumable.');
    const completion = new Promise<void>((resolve, reject) => {
      active.done = { resolve, reject };
    });
    await active.client.request('session/prompt', {
      sessionId: active.threadId,
      prompt: [{ type: 'text', text }],
    });
    await completion;
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
      text: '',
      unsub: [],
    };
    active.unsub.push(
      client.onNotification((n) => this.notification(sessionId, active, n)),
      client.onServerRequest((r) => void this.serverRequest(sessionId, active, r)),
      client.onClose((error) => this.close(sessionId, active, error)),
    );
    await client.initialize();
    const persisted = this.sessions.findById(sessionId)?.providerThreadId;
    const response = persisted
      ? await client.request<{ sessionId?: string }>('session/load', {
          sessionId: persisted,
        })
      : await client.request<{ sessionId?: string }>('session/new', {
          cwd,
          mcpServers: [],
        });
    active.threadId = response.sessionId ?? persisted ?? '';
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
          };
          sessionId?: string;
        }
      | undefined;
    const u = p?.update;
    if (n.method === '_cognition.ai/agent_stopped') {
      const done = active.done;
      active.done = undefined;
      if (done) {
        this.pushEvent(
          sessionId,
          'assistant_message',
          { text: active.text || '(no response)' },
          active.emit,
        );
        done.resolve();
      }
      return;
    }
    if (!u) return;
    const text =
      u.content && typeof u.content === 'object' && !Array.isArray(u.content)
        ? (u.content as { text?: string }).text
        : undefined;
    if (u.sessionUpdate === 'agent_message_chunk' && text) {
      active.text += text;
      this.pushEvent(sessionId, 'assistant_delta', { delta: text }, active.emit);
    } else if (u.sessionUpdate === 'agent_thought_chunk' && text) {
      this.pushEvent(sessionId, 'thinking_delta', { delta: text }, active.emit);
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
          active.emit,
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
          active.emit,
        );
      }
    } else if (u.sessionUpdate === 'plan') {
      this.pushEvent(sessionId, 'plan_updated', { plan: u }, active.emit);
    } else if (u.sessionUpdate === 'session_info_update' && u.title) {
      this.pushEvent(sessionId, 'session_title', { title: u.title }, active.emit);
    }
  }

  private async serverRequest(sessionId: string, active: Active, request: DevinAcpRequest): Promise<void> {
    if (request.method === 'fs/read_text_file' || request.method === 'fs/write_text_file') {
      const p = request.params as { path?: string; content?: string } | undefined;
      const path = resolve(active.cwd, p?.path ?? '');
      if (request.method === 'fs/read_text_file') {
        const { readFile } = await import('node:fs/promises');
        active.client.respond(request.id, {
          content: await readFile(path, 'utf8'),
        });
      } else {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(path, p?.content ?? '', 'utf8');
        active.client.respond(request.id, {});
      }
      return;
    }

    // Mirror Codex: the SessionsService approval hook owns the transcript card.
    // Emitting provider_request here as well duplicates the UI and desyncs requestIds.
    const result = active.approval
      ? await active.approval({
          provider: this.id,
          method: request.method,
          ...(request.params !== undefined ? { params: request.params } : {}),
        })
      : { requestId: String(request.id), decision: 'deny' as const };

    active.client.respond(request.id, mapPermissionDecision(result.decision, request.params));

    if (!active.approval) {
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
        active.emit,
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
        active.emit,
      );
    }
  }

  private close(sessionId: string, active: Active, error?: Error): void {
    if (this.active.get(sessionId) !== active) return;
    this.active.delete(sessionId);
    const done = active.done;
    active.done = undefined;
    if (done) {
      done.reject(error ?? new Error('Devin ACP session closed.'));
    }
    active.unsub.forEach((unsubscribe) => unsubscribe());
    active.client.close();
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
