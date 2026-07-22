import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { isUserInputRequestedEvent } from '../sessions/domain/events.types';
import { registerSessionEventHook } from '../sessions/domain/session-event-hooks';
import type { SessionEvent } from '../sessions/domain/sessions.types';
import {
  ExpoPushDelivery,
  type ExpoSdkClient,
  type PushMessage,
  type PushTransport,
} from './expo-push-delivery';
import { PushRepository } from './push.repository';

export type { ExpoSdkClient, PushMessage, PushTransport } from './expo-push-delivery';

interface SessionRow {
  title: string;
  verify_owner: string;
}

interface ApprovalPayload {
  requestId: string;
}

export function pushContentFor(
  event: SessionEvent,
  title: string,
): { title: string; body: string } | null {
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

function approvalPayload(event: SessionEvent): ApprovalPayload | null {
  if (event.type !== 'provider_request' || typeof event.payload !== 'object' || !event.payload) {
    return null;
  }
  const requestId = (event.payload as { requestId?: unknown }).requestId;
  return typeof requestId === 'string' && requestId ? { requestId } : null;
}

@Injectable()
export class PushService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PushService.name);
  private readonly delivery = new ExpoPushDelivery((context, error) => {
    const reason = error instanceof Error ? error.message : String(error);
    this.logger.warn(`Could not ${context}: ${reason}`);
  });
  private unhook: (() => void) | null = null;

  constructor(
    private readonly tokens: PushRepository,
    private readonly database: DatabaseService,
  ) {}

  setTransport(transport: PushTransport): void {
    this.delivery.setTransport(transport);
  }

  setExpoSdk(sdk: ExpoSdkClient): void {
    this.delivery.setSdk(sdk);
  }

  onModuleInit(): void {
    this.unhook = registerSessionEventHook((sessionId, event) => {
      void this.onSessionEvent(sessionId, event).catch((error) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Push event handling failed: ${reason}`);
      });
    });
  }

  onModuleDestroy(): void {
    this.unhook?.();
    this.unhook = null;
  }

  register(token: string, platform?: string, deviceName?: string): void {
    this.tokens.register(token, platform, deviceName);
  }

  async registerForDevice(deviceId: string, token: string, platform: string): Promise<void> {
    if (!(await this.delivery.isValidToken(token))) {
      throw new BadRequestException('token must be a valid ExpoPushToken');
    }
    this.tokens.registerForDevice(deviceId, token, platform);
  }

  unregister(token: string): void {
    this.tokens.unregister(token);
  }

  async broadcast(content: {
    title: string;
    body: string;
    data?: Record<string, unknown>;
  }): Promise<void> {
    const messages = this.tokens.listEnabledIncludingLegacyUnbound().map((recipient) => ({
      to: recipient.token,
      title: content.title,
      body: content.body,
      data: content.data ?? {},
      sound: 'default' as const,
    }));
    await this.delivery.send(messages);
  }

  async onSessionEvent(sessionId: string, event: SessionEvent): Promise<void> {
    if (!['status', 'user_input_requested', 'provider_request'].includes(event.type)) return;
    const recipients = event.type === 'status'
      ? this.tokens.listEnabledIncludingLegacyUnbound()
      : this.tokens.listEnabled();
    if (recipients.length === 0) return;

    const row = this.database.db
      .prepare<SessionRow, [string]>('SELECT title FROM sessions WHERE id = ?')
      .get(sessionId);
    const title = row?.title ?? 'Session';
    const message = this.messageFor(sessionId, event, title);
    if (!message) return;
    await this.delivery.send(recipients.map((recipient) => ({ ...message, to: recipient.token })));
  }

  private messageFor(
    sessionId: string,
    event: SessionEvent,
    sessionTitle: string,
  ): Omit<PushMessage, 'to'> | null {
    if (isUserInputRequestedEvent(event)) {
      const payload = event.payload;
      const title = payload.title?.trim() || sessionTitle;
      const firstQuestion = payload.questions[0];
      return {
        title,
        body: firstQuestion?.prompt ?? title,
        sound: 'default',
        categoryId: 'QUESTION',
        data: {
          type: 'question',
          sessionId,
          requestId: payload.requestId,
          title,
          questionCount: payload.questions.length,
          options: (firstQuestion?.options ?? []).slice(0, 4).map((option, index) => ({
            n: index + 1,
            label: option.label,
          })),
          categoryId: 'QUESTION',
          deepLink: `nuncio://session/${sessionId}`,
        },
      };
    }

    const approval = approvalPayload(event);
    if (approval) {
      return {
        title: sessionTitle,
        body: 'Approval required',
        sound: 'default',
        categoryId: 'APPROVAL',
        data: {
          type: 'approval',
          sessionId,
          requestId: approval.requestId,
          title: sessionTitle,
          categoryId: 'APPROVAL',
          deepLink: `nuncio://session/${sessionId}`,
        },
      };
    }

    const content = pushContentFor(event, sessionTitle);
    return content
      ? { ...content, data: { sessionId }, sound: 'default' }
      : null;
  }
}
