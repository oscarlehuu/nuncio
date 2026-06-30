import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Subprocess } from 'bun';
import type { ModelProviderDto } from '../../models/models.types';
import { SettingsService } from '../../settings/settings.service';
import { EventsRepository } from '../../sessions/persistence/events.repository';
import { SessionsRepository } from '../../sessions/persistence/sessions.repository';
import type { AgentRunContext } from '../agents.types';
import { BaseAgentProvider } from '../agents.base-provider';
import {
  buildCursorCliArgs,
  parseCursorCliStreamLine,
  resolveCursorAgentBin,
} from './cursor-cli.helpers';
import { isCursorCliRecentlyActive } from './cursor-cli.active-run';
import { formatInteractionAnswers } from '../../sessions/domain/format-interaction-answers';
import {
  buildUserInputRequestedPayload,
  type UserInputRequestedEventPayload,
} from '../../sessions/domain/interactive-tool-events';
import { isInteractiveTool } from '../tool-interaction.registry';
import type { InteractionResponse } from '../agents.types';

@Injectable()
export class CursorCliProvider extends BaseAgentProvider {
  readonly id = 'cursor-cli';
  readonly name = 'Cursor CLI';

  private readonly activeProcesses = new Map<string, Subprocess>();

  /** Test hook: inject a stub runner instead of spawning agent. */
  runOverride?: (
    sessionId: string,
    args: string[],
    context: AgentRunContext,
  ) => Promise<number>;

  constructor(
    sessions: SessionsRepository,
    events: EventsRepository,
    private readonly settings: SettingsService,
  ) {
    super(sessions, events);
  }

  async isAvailable(): Promise<boolean> {
    return this.resolveAgentBin() !== null;
  }

  async listModels(): Promise<ModelProviderDto[]> {
    return [];
  }

  dispose(sessionId: string): void {
    const proc = this.activeProcesses.get(sessionId);
    if (proc) {
      proc.kill();
      this.activeProcesses.delete(sessionId);
    }
  }

  disposeAll(): void {
    for (const id of [...this.activeProcesses.keys()]) this.dispose(id);
  }

  bustCache(): void {}

  supportsInteraction(): boolean {
    return true;
  }

  async submitInteraction(
    sessionId: string,
    requestId: string,
    response: InteractionResponse,
    context: AgentRunContext,
  ): Promise<void> {
    const requested = this.findOpenUserInputRequest(sessionId, requestId);
    if (!requested) {
      throw new Error(`No pending user input request ${requestId}`);
    }

    this.pushEvent(
      sessionId,
      'user_input_resolved',
      { requestId, resolvedBy: response.resolvedBy },
      context.emit,
    );

    const formatted = formatInteractionAnswers(requested.questions, response);
    await this.steer(sessionId, formatted, context);
  }

  async run(sessionId: string, prompt: string, context: AgentRunContext): Promise<void> {
    this.assertNotRecentlyActive(context);
    await super.run(sessionId, prompt, context);
  }

  async steer(sessionId: string, message: string, context: AgentRunContext): Promise<void> {
    this.assertNotRecentlyActive(context);
    await super.steer(sessionId, message, context);
  }

  protected async executePrompt(
    sessionId: string,
    text: string,
    _isSteer: boolean,
    context: AgentRunContext,
  ): Promise<void> {
    const chatId = context.cursorChatId?.trim();
    const workspace = context.workspace?.trim();
    if (!chatId) throw new Error('cursorChatId is required for CLI handoff sessions');
    if (!workspace) throw new Error('workspace is required for CLI handoff sessions');

    const agentBin = this.resolveAgentBin();
    if (!agentBin) {
      throw new ServiceUnavailableException(
        'Cursor CLI (agent) not found. Install via Cursor or set NUNCIO_CURSOR_AGENT_BIN.',
      );
    }

    const args = buildCursorCliArgs({ agentBin, workspace, chatId, message: text });

    let exitCode: number;
    if (this.runOverride) {
      exitCode = await this.runOverride(sessionId, args, {
        ...context,
        emit: (event) => this.pushEvent(sessionId, event.type, event.payload, context.emit),
      });
    } else {
      exitCode = await this.spawnAndStream(sessionId, agentBin, args, context);
    }

    if (exitCode !== 0) {
      throw new Error(`Cursor CLI exited with code ${exitCode}`);
    }
  }

  private assertNotRecentlyActive(context: AgentRunContext): void {
    if (context.forceResume) return;

    if (
      isCursorCliRecentlyActive(
        context.transcriptMtimeMs,
        context.chatStoreMtimeMs,
        context.transcriptTurnEnded,
      )
    ) {
      throw new ConflictException(
        'Cursor may still be running this chat on your Mac. Pause it in Cursor, then retry.',
      );
    }
  }

  private resolveAgentBin(): string | null {
    const setting = this.settings.resolve('NUNCIO_CURSOR_AGENT_BIN');
    const candidates: string[] = [];
    if (setting?.trim()) candidates.push(setting.trim());
    candidates.push(`${homedir()}/.local/bin/agent`);
    const pathEnv = process.env.PATH ?? '';
    for (const dir of pathEnv.split(':')) {
      if (dir) candidates.push(`${dir}/agent`);
    }
    for (const bin of candidates) {
      if (existsSync(bin)) return bin;
    }
    return null;
  }

  private async spawnAndStream(
    sessionId: string,
    agentBin: string,
    args: string[],
    context: AgentRunContext,
  ): Promise<number> {
    const proc = Bun.spawn([agentBin, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    });
    this.activeProcesses.set(sessionId, proc);

    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) this.handleStreamLine(sessionId, line, context);
      }
      if (buffer.trim()) this.handleStreamLine(sessionId, buffer, context);

      const stderr = await new Response(proc.stderr).text();
      if (stderr.trim()) {
        console.warn(`[cursor-cli] stderr session=${sessionId}:`, stderr.slice(0, 500));
      }

      return await proc.exited;
    } finally {
      this.activeProcesses.delete(sessionId);
    }
  }

  private handleStreamLine(sessionId: string, line: string, context: AgentRunContext): void {
    const event = parseCursorCliStreamLine(line);
    switch (event.kind) {
      case 'assistant_delta':
        this.pushEvent(sessionId, 'assistant_delta', { delta: event.delta }, context.emit);
        break;
      case 'assistant_message':
        this.pushEvent(sessionId, 'assistant_message', { text: event.text }, context.emit);
        this.sessions.touchPreview(sessionId, event.text);
        break;
      case 'tool_start': {
        const userInputPayload = buildUserInputRequestedPayload(
          event.tool,
          event.input,
          event.callId,
        );
        if (userInputPayload) {
          this.pushEvent(sessionId, 'user_input_requested', userInputPayload, context.emit);
          break;
        }
        this.pushEvent(
          sessionId,
          'tool_start',
          {
            callId: event.callId,
            tool: event.tool,
            ...(event.input !== undefined ? { input: event.input } : {}),
          },
          context.emit,
        );
        break;
      }
      case 'tool_end':
        if (isInteractiveTool(event.tool) && event.callId) {
          break;
        }
        this.pushEvent(
          sessionId,
          'tool_end',
          {
            callId: event.callId,
            tool: event.tool,
            isError: event.isError ?? false,
            ...(event.output !== undefined ? { output: event.output } : {}),
          },
          context.emit,
        );
        break;
      case 'error':
        throw new Error(event.message);
      case 'skip':
        break;
      default: {
        const _exhaustive: never = event;
        void _exhaustive;
      }
    }
  }

  private findOpenUserInputRequest(
    sessionId: string,
    requestId: string,
  ): UserInputRequestedEventPayload | undefined {
    let requested: UserInputRequestedEventPayload | undefined;
    let resolved = false;

    for (const event of this.events.list(sessionId, 0)) {
      if (event.type === 'user_input_requested') {
        const payload = event.payload as UserInputRequestedEventPayload;
        if (payload.requestId === requestId) requested = payload;
      }
      if (event.type === 'user_input_resolved') {
        const payload = event.payload as { requestId?: string };
        if (payload.requestId === requestId) resolved = true;
      }
    }

    if (!requested || resolved) return undefined;
    return requested;
  }
}
