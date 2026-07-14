import type { SessionEvent } from './api';
import type {
  SessionSubscription,
  SessionSubscriptionOptions,
  WebSocketFactory,
  WebSocketLike,
} from './session-relay-client';

const RECONNECT_MS = 2000;
const RESYNC_ACK_TIMEOUT_MS = 2000;

type ChannelOptions = Pick<SessionSubscriptionOptions, 'sessionId' | 'since' | 'tail' | 'onEvent'>;
type Consumer = ChannelOptions & { id: number; lastSeq: number; pending: Set<number>; closed: boolean };
type Pending = { ownerId: number; resolve: (value: unknown) => void; reject: (error: unknown) => void };

export class SharedSessionRelayConnection {
  private socket: WebSocketLike | null = null;
  private socketOpen = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnecting = false;
  private closed = false;
  private nextConsumerId = 1;
  private nextRpcId = 1;
  private readonly channels = new Map<string, Map<number, Consumer>>();
  private readonly pending = new Map<number, Pending>();
  private readonly url: string;
  private readonly factory: WebSocketFactory;
  private readonly onIdle: () => void;

  constructor(
    url: string,
    factory: WebSocketFactory,
    onIdle: () => void,
  ) {
    this.url = url;
    this.factory = factory;
    this.onIdle = onIdle;
    this.connect();
  }

  subscribe(options: ChannelOptions): SessionSubscription {
    const id = this.nextConsumerId++;
    const consumer: Consumer = {
      ...options,
      id,
      lastSeq: options.since ?? 0,
      pending: new Set(),
      closed: false,
    };
    const consumers = this.channels.get(options.sessionId) ?? new Map<number, Consumer>();
    consumers.set(id, consumer);
    this.channels.set(options.sessionId, consumers);
    if (this.socketOpen) this.sendSubscribe(options.sessionId);

    return {
      resync: () => {
        if (!consumer.closed) this.resync(options.sessionId);
      },
      confirmResync: (timeoutMs = RESYNC_ACK_TIMEOUT_MS) =>
        consumer.closed ? Promise.resolve(false) : this.confirmSubscribe(consumer, timeoutMs),
      call: (method, params) => this.call(consumer, method, params),
      close: () => this.removeConsumer(consumer),
    };
  }

  close(): void {
    if (!this.closed) this.dispose();
  }

  isIdle(): boolean {
    return this.channels.size === 0;
  }

  private connect(): void {
    if (this.closed) return;
    const ws = this.factory(this.url);
    this.socket = ws;
    this.socketOpen = false;
    ws.addEventListener('open', () => {
      if (this.closed || this.socket !== ws) return;
      this.socketOpen = true;
      for (const sessionId of this.channels.keys()) this.sendSubscribe(sessionId);
    });
    ws.addEventListener('message', (message) => this.handleMessage(ws, message.data));
    ws.addEventListener('close', () => this.handleClose(ws));
  }

  private handleMessage(ws: WebSocketLike, data: unknown): void {
    if (this.closed || this.socket !== ws) return;
    let frame: {
      id?: number;
      result?: unknown;
      error?: { code: number; message: string };
      channel?: string;
      event?: SessionEvent;
      behind?: boolean;
      notice?: string;
    };
    try {
      frame = JSON.parse(String(data));
    } catch {
      return;
    }
    if (frame.channel !== undefined) {
      const consumers = this.channels.get(frame.channel);
      if (!consumers) return;
      if (frame.behind) {
        this.sendSubscribe(frame.channel);
        return;
      }
      if (!frame.event) return;
      for (const consumer of consumers.values()) {
        if (frame.event.seq <= consumer.lastSeq) continue;
        consumer.lastSeq = Math.max(consumer.lastSeq, frame.event.seq);
        consumer.onEvent(frame.event);
      }
      return;
    }
    // Top-level notice (e.g. graceful `server_shutdown`). While the socket is
    // still up, resubscribe from each channel's lastSeq so clients catch up
    // before the connection drops. If the socket is already down, the next
    // open path re-subscribes all channels as usual.
    if (typeof frame.notice === 'string') {
      if (frame.notice === 'server_shutdown' && this.socketOpen) {
        for (const sessionId of this.channels.keys()) this.sendSubscribe(sessionId);
      }
      return;
    }
    if (typeof frame.id !== 'number') return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    this.consumerById(pending.ownerId)?.pending.delete(frame.id);
    if (frame.error) pending.reject(frame.error);
    else pending.resolve(frame.result);
  }

  private handleClose(ws: WebSocketLike): void {
    if (this.socket !== ws) return;
    this.socketOpen = false;
    this.rejectAllPending();
    if (this.closed || this.reconnecting || this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_MS);
  }

  private sendSubscribe(sessionId: string, pending?: Pending): number | null {
    if (!this.socketOpen || !this.socket) return null;
    const consumers = this.channels.get(sessionId);
    if (!consumers?.size) return null;
    const values = [...consumers.values()];
    const since = Math.min(...values.map((consumer) => consumer.lastSeq));
    const tails = values.map((consumer) => consumer.tail);
    const tail = since === 0 && tails.every((value) => Number.isFinite(value) && (value ?? 0) > 0)
      ? Math.max(...tails.map((value) => Math.floor(value!)))
      : undefined;
    const id = this.nextRpcId++;
    if (pending) {
      this.pending.set(id, pending);
      this.consumerById(pending.ownerId)?.pending.add(id);
    }
    try {
      this.socket.send(JSON.stringify({
        id,
        method: 'subscribe',
        params: { sessionId, since, ...(tail !== undefined ? { tail } : {}) },
      }));
    } catch (error) {
      this.pending.delete(id);
      this.consumerById(pending?.ownerId ?? -1)?.pending.delete(id);
      pending?.reject(error);
      return null;
    }
    return id;
  }

  private resync(sessionId: string): void {
    if (this.closed) return;
    if (this.socketOpen) {
      this.sendSubscribe(sessionId);
      return;
    }
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnecting = true;
    try {
      this.socket?.close();
    } finally {
      this.reconnecting = false;
    }
    this.connect();
  }

  private confirmSubscribe(consumer: Consumer, timeoutMs: number): Promise<boolean> {
    if (!this.socketOpen) return Promise.resolve(false);
    return new Promise((resolve) => {
      let id: number | null = null;
      const timer = setTimeout(() => {
        if (id === null || !this.pending.delete(id)) return;
        consumer.pending.delete(id);
        resolve(false);
      }, timeoutMs);
      const pending: Pending = {
        ownerId: consumer.id,
        resolve: () => { clearTimeout(timer); resolve(true); },
        reject: () => { clearTimeout(timer); resolve(false); },
      };
      id = this.sendSubscribe(consumer.sessionId, pending);
      if (id === null) {
        clearTimeout(timer);
        resolve(false);
      }
    });
  }

  private call(consumer: Consumer, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (consumer.closed || this.closed || !this.socketOpen || !this.socket) {
      return Promise.reject(new Error('connection closed'));
    }
    const id = this.nextRpcId++;
    consumer.pending.add(id);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { ownerId: consumer.id, resolve, reject });
      try {
        this.socket!.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        consumer.pending.delete(id);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private removeConsumer(consumer: Consumer): void {
    if (consumer.closed) return;
    consumer.closed = true;
    const consumers = this.channels.get(consumer.sessionId);
    if (!consumers?.delete(consumer.id)) return;
    for (const id of consumer.pending) {
      this.pending.get(id)?.reject(new Error('connection closed'));
      this.pending.delete(id);
    }
    consumer.pending.clear();
    if (consumers.size === 0) {
      this.channels.delete(consumer.sessionId);
      this.send('unsubscribe', { sessionId: consumer.sessionId });
    }
    if (this.channels.size === 0) this.onIdle();
  }

  private send(method: string, params: Record<string, unknown>): void {
    if (!this.socketOpen || !this.socket) return;
    this.socket.send(JSON.stringify({ id: this.nextRpcId++, method, params }));
  }

  private consumerById(id: number): Consumer | undefined {
    for (const consumers of this.channels.values()) {
      const consumer = consumers.get(id);
      if (consumer) return consumer;
    }
    return undefined;
  }

  private rejectAllPending(): void {
    for (const pending of this.pending.values()) pending.reject(new Error('connection closed'));
    this.pending.clear();
    for (const consumers of this.channels.values()) {
      for (const consumer of consumers.values()) consumer.pending.clear();
    }
  }

  private dispose(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.rejectAllPending();
    this.channels.clear();
    this.socket?.close();
    this.socket = null;
  }
}
