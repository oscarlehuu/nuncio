import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';
import type { CreateSessionDto, SessionDto, SessionEvent } from './session.types';
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

  list(): SessionDto[] {
    return this.sessions.list();
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

  subscribe(id: string, listener: StreamListener): () => void {
    const bus = this.getOrCreateBus(id);
    const handler = (event: SessionEvent) => listener(event);
    bus.on('event', handler);
    return () => bus.off('event', handler);
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
    void this.piAgent.run(sessionId, prompt, ({ type, payload }) => {
      const events = this.events.list(sessionId);
      const latest = events[events.length - 1];
      if (latest) this.emit(sessionId, latest);
      else this.emit(sessionId, { seq: 0, type, payload, createdAt: Date.now() });
    });
  }
}
