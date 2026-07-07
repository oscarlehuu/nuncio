import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { registerSessionEventHook } from '../sessions/domain/session-event-hooks';
import type { SessionEvent } from '../sessions/domain/sessions.types';
import { PushRepository } from './push.repository';

const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';
/** Expo's documented max messages per request. */
const CHUNK_SIZE = 100;

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, string>;
  sound: 'default';
}

export type PushTransport = (messages: PushMessage[]) => Promise<void>;

const defaultTransport: PushTransport = async (messages) => {
  await fetch(EXPO_PUSH_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(messages),
  });
};

/** What a persisted session event should push, if anything. */
export function pushContentFor(event: SessionEvent, title: string): { title: string; body: string } | null {
  if (event.type === 'status') {
    const status = (event.payload as { status?: string }).status;
    if (status === 'IDLE') return { title: 'Agent finished', body: title };
    if (status === 'ERROR') return { title: 'Session error', body: title };
    return null;
  }
  if (event.type === 'user_input_requested') {
    return { title: 'Agent needs your input', body: title };
  }
  return null;
}

@Injectable()
export class PushService implements OnModuleInit, OnModuleDestroy {
  private unhook: (() => void) | null = null;
  private transport: PushTransport = defaultTransport;

  constructor(
    private readonly tokens: PushRepository,
    private readonly database: DatabaseService,
  ) {}

  /** Test seam — production always talks to Expo's push endpoint. */
  setTransport(transport: PushTransport): void {
    this.transport = transport;
  }

  onModuleInit(): void {
    this.unhook = registerSessionEventHook((sessionId, event) => {
      void this.onSessionEvent(sessionId, event);
    });
  }

  onModuleDestroy(): void {
    this.unhook?.();
    this.unhook = null;
  }

  register(token: string, platform?: string, deviceName?: string): void {
    this.tokens.register(token, platform, deviceName);
  }

  /**
   * Broadcast a standalone push to every registered device — used by the rung-3
   * heartbeat digest (a push not tied to a session event). Best-effort, chunked,
   * same transport. RED until the sub-phase B wiring lands.
   */
  async broadcast(content: { title: string; body: string; data?: Record<string, string> }): Promise<void> {
    const recipients = this.tokens.list();
    if (recipients.length === 0) return; // no device registered → nothing to send
    const messages: PushMessage[] = recipients.map((r) => ({
      to: r.token,
      title: content.title,
      body: content.body,
      data: content.data ?? {},
      sound: 'default',
    }));
    for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
      try {
        await this.transport(messages.slice(i, i + CHUNK_SIZE));
      } catch {
        // Push is best-effort; a failed batch must never wedge the heartbeat.
      }
    }
  }

  unregister(token: string): void {
    this.tokens.unregister(token);
  }

  async onSessionEvent(sessionId: string, event: SessionEvent): Promise<void> {
    // Cheap type gate first — only lifecycle-relevant events read the DB.
    if (event.type !== 'status' && event.type !== 'user_input_requested') return;
    const recipients = this.tokens.list();
    if (recipients.length === 0) return;

    const row = this.database.db
      .prepare<{ title: string }, [string]>('SELECT title FROM sessions WHERE id = ?')
      .get(sessionId);
    const content = pushContentFor(event, row?.title ?? 'Session');
    if (!content) return;

    const messages: PushMessage[] = recipients.map((r) => ({
      to: r.token,
      title: content.title,
      body: content.body,
      data: { sessionId },
      sound: 'default',
    }));
    for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
      try {
        await this.transport(messages.slice(i, i + CHUNK_SIZE));
      } catch {
        // Push is best-effort; a failed batch must not affect the session.
      }
    }
  }
}
