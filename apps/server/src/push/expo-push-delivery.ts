export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound: 'default';
  categoryId?: 'QUESTION' | 'APPROVAL';
}

interface PushTicket {
  status: string;
  id?: string;
  message?: string;
  details?: unknown;
}

interface PushReceipt {
  status: string;
  message?: string;
  details?: unknown;
}

export interface ExpoSdkClient {
  isExpoPushToken(token: string): boolean;
  chunkPushNotifications(messages: PushMessage[]): PushMessage[][];
  sendPushNotificationsAsync(messages: PushMessage[]): Promise<PushTicket[]>;
  chunkPushNotificationReceiptIds(ids: string[]): string[][];
  getPushNotificationReceiptsAsync(ids: string[]): Promise<Record<string, PushReceipt>>;
}

export type PushTransport = (messages: PushMessage[]) => Promise<void>;
type LogFailure = (context: string, error: unknown) => void;

const LEGACY_CHUNK_SIZE = 100;
const SDK_MODULE = 'expo-server-sdk';

async function loadExpoSdk(): Promise<ExpoSdkClient> {
  const module = (await import(SDK_MODULE)) as {
    Expo: {
      new (): Omit<ExpoSdkClient, 'isExpoPushToken'>;
      isExpoPushToken(token: string): boolean;
    };
  };
  const client = new module.Expo();
  return {
    isExpoPushToken: module.Expo.isExpoPushToken,
    chunkPushNotifications: client.chunkPushNotifications.bind(client),
    sendPushNotificationsAsync: client.sendPushNotificationsAsync.bind(client),
    chunkPushNotificationReceiptIds: client.chunkPushNotificationReceiptIds.bind(client),
    getPushNotificationReceiptsAsync: client.getPushNotificationReceiptsAsync.bind(client),
  };
}

export class ExpoPushDelivery {
  private sdkPromise: Promise<ExpoSdkClient> | null = null;
  private transportOverride: PushTransport | null = null;

  constructor(private readonly logFailure: LogFailure) {}

  setSdk(sdk: ExpoSdkClient): void {
    this.sdkPromise = Promise.resolve(sdk);
    this.transportOverride = null;
  }

  setTransport(transport: PushTransport): void {
    this.transportOverride = transport;
  }

  async isValidToken(token: string): Promise<boolean> {
    return (await this.sdk()).isExpoPushToken(token);
  }

  async send(messages: PushMessage[]): Promise<void> {
    if (messages.length === 0) return;
    if (this.transportOverride) {
      await this.sendUsingOverride(messages, this.transportOverride);
      return;
    }

    let sdk: ExpoSdkClient;
    try {
      sdk = await this.sdk();
    } catch (error) {
      this.logFailure('load Expo SDK', error);
      return;
    }

    let chunks: PushMessage[][];
    try {
      chunks = sdk.chunkPushNotifications(messages);
    } catch (error) {
      this.logFailure('chunk Expo push messages', error);
      return;
    }

    const receiptIds: string[] = [];
    for (const chunk of chunks) {
      try {
        const tickets = await sdk.sendPushNotificationsAsync(chunk);
        for (const ticket of tickets) {
          if (ticket.status === 'ok' && ticket.id) {
            receiptIds.push(ticket.id);
          } else if (ticket.status !== 'ok') {
            this.logFailure(
              'enqueue Expo push',
              new Error(ticket.message ?? JSON.stringify(ticket.details ?? 'Unknown ticket error')),
            );
          }
        }
      } catch (error) {
        this.logFailure('send Expo push batch', error);
      }
    }
    if (receiptIds.length > 0) void this.readReceipts(sdk, receiptIds);
  }

  private sdk(): Promise<ExpoSdkClient> {
    this.sdkPromise ??= loadExpoSdk();
    return this.sdkPromise;
  }

  private async sendUsingOverride(messages: PushMessage[], transport: PushTransport): Promise<void> {
    for (let index = 0; index < messages.length; index += LEGACY_CHUNK_SIZE) {
      try {
        await transport(messages.slice(index, index + LEGACY_CHUNK_SIZE));
      } catch (error) {
        this.logFailure('send push batch', error);
      }
    }
  }

  private async readReceipts(sdk: ExpoSdkClient, ids: string[]): Promise<void> {
    let chunks: string[][];
    try {
      chunks = sdk.chunkPushNotificationReceiptIds(ids);
    } catch (error) {
      this.logFailure('chunk Expo push receipt ids', error);
      return;
    }
    for (const chunk of chunks) {
      try {
        const receipts = await sdk.getPushNotificationReceiptsAsync(chunk);
        for (const [id, receipt] of Object.entries(receipts)) {
          if (receipt.status === 'ok') continue;
          this.logFailure(
            `deliver Expo push receipt ${id}`,
            new Error(receipt.message ?? JSON.stringify(receipt.details ?? 'Unknown receipt error')),
          );
        }
      } catch (error) {
        this.logFailure('read Expo push receipts', error);
      }
    }
  }
}
