import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter } from 'events';
import type { CreateSessionDto, SessionDto, SessionEvent, SessionStatus } from './session.types';
import { canTransition } from './session-fsm';
import { EventsRepository } from './events.repository';
import { PiAgentService } from './pi-agent.service';
import { SessionsRepository } from './sessions.repository';

type StreamListener = (event: SessionEvent) => void;

@Injectable()
export class SessionsService {
  private readonly streams = new Map<string, EventEmitter>();

  constructor(
    private readonly sessions: SessionsRepository,
    private readonly events: EventsRepository,
    private readonly piAgent: PiAgentService,
  ) {}

  list(includeArchived = false): SessionDto[] {
    return this.sessions.list(includeArchived);
  }

  get(id: string): SessionDto | null {
    return this.sessions.findById(id);
  }

  getEvents(id: string, since = 0): SessionEvent[] {
    return this.events.list(id, since);
  }

  create(input: CreateSessionDto): SessionDto {
    const session = this.sessions.create(input);
    void this.startRun(session.id, input.prompt);
    return session;
  }

  async steer(id: string, message: string): Promise<SessionDto> {
    this.requireSession(id);
    const trimmed = message?.trim();
    if (!trimmed) {
      throw new BadRequestException('message is required');
    }

    const current = this.requireSession(id);
    if (!canTransition(current.status, 'RUNNING')) {
      throw new BadRequestException(`Cannot steer session in status ${current.status}`);
    }

    await this.piAgent.steer(id, trimmed, (event) => this.onAgentEvent(id, event));
    return this.requireSession(id);
  }

  pause(id: string): SessionDto {
    const session = this.requireSession(id);
    if (!canTransition(session.status, 'PAUSED')) {
      throw new BadRequestException(`Cannot pause session in status ${session.status}`);
    }
    this.transition(id, 'PAUSED');
    return this.requireSession(id);
  }

  archive(id: string): SessionDto {
    const session = this.requireSession(id);
    if (!canTransition(session.status, 'ARCHIVED')) {
      throw new BadRequestException(`Cannot archive session in status ${session.status}`);
    }
    this.piAgent.dispose(id);
    this.transition(id, 'ARCHIVED');
    return this.requireSession(id);
  }

  subscribe(id: string, listener: StreamListener): () => void {
    const bus = this.getOrCreateBus(id);
    const handler = (event: SessionEvent) => listener(event);
    bus.on('event', handler);
    return () => bus.off('event', handler);
  }

  private requireSession(id: string): SessionDto {
    const session = this.sessions.findById(id);
    if (!session) throw new NotFoundException('Session not found');
    return session;
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

  private startRun(sessionId: string, prompt: string): void {
    void this.piAgent.run(sessionId, prompt, (event) => this.onAgentEvent(sessionId, event));
  }
}
