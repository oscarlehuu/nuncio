import type { BrowserPageClient } from './browser.service';
import type { BrowserKeyInputDto, BrowserStateDto } from './browser.types';

type CdpResponse = {
  id?: number;
  result?: unknown;
  error?: { message?: string };
};

type RuntimeWebSocket = {
  send(data: string): void;
  close(): void;
  addEventListener(event: 'open' | 'message' | 'error' | 'close', listener: (event: unknown) => void): void;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function boolValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export class CdpPageClient implements BrowserPageClient {
  private readonly socket: RuntimeWebSocket;
  private nextId = 1;
  private screenshotVersion = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly ready: Promise<void>;

  private constructor(webSocketDebuggerUrl: string) {
    const ctor = (globalThis as unknown as {
      WebSocket?: new (url: string) => RuntimeWebSocket;
    }).WebSocket;
    if (!ctor) throw new Error('WebSocket is not available in this runtime');

    this.socket = new ctor(webSocketDebuggerUrl);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve());
      this.socket.addEventListener('error', () => reject(new Error('Chrome DevTools socket failed')));
    });
    this.socket.addEventListener('message', (event) => this.handleMessage(event));
    this.socket.addEventListener('close', () => this.rejectAll(new Error('Chrome DevTools socket closed')));
  }

  static async connect(webSocketDebuggerUrl: string): Promise<CdpPageClient> {
    const client = new CdpPageClient(webSocketDebuggerUrl);
    await client.ready;
    await client.sendCdp('Page.enable');
    await client.sendCdp('Runtime.enable');
    return client;
  }

  async navigate(url: string): Promise<void> {
    await this.sendCdp('Page.navigate', { url });
    this.screenshotVersion += 1;
  }

  async state(): Promise<BrowserStateDto> {
    const response = await this.sendCdp('Runtime.evaluate', {
      expression: `({
        url: window.location.href,
        title: document.title,
        loading: document.readyState !== "complete"
      })`,
      returnByValue: true,
    });
    const result = asRecord(response);
    const value = asRecord(asRecord(result?.result)?.value);
    return {
      connected: true,
      url: stringValue(value?.url),
      title: stringValue(value?.title),
      loading: boolValue(value?.loading) ?? false,
      screenshotVersion: this.screenshotVersion,
    };
  }

  async screenshot(): Promise<Buffer> {
    const response = await this.sendCdp('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const data = stringValue(asRecord(response)?.data);
    if (!data) throw new Error('Chrome did not return screenshot data');
    return Buffer.from(data, 'base64');
  }

  async click(x: number, y: number): Promise<void> {
    await this.sendCdp('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    await this.sendCdp('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    this.screenshotVersion += 1;
  }

  async typeText(text: string): Promise<void> {
    await this.sendCdp('Input.insertText', { text });
    this.screenshotVersion += 1;
  }

  async pressKey(input: BrowserKeyInputDto): Promise<void> {
    const params = keyEventParams(input);
    await this.sendCdp('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
    await this.sendCdp('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
    this.screenshotVersion += 1;
  }

  async scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    await this.sendCdp('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX,
      deltaY,
    });
    this.screenshotVersion += 1;
  }

  close(): void {
    this.socket.close();
  }

  private async sendCdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
    await this.ready;
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, ...(params ? { params } : {}) });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(payload);
    });
  }

  private handleMessage(event: unknown): void {
    const data = asRecord(event)?.data;
    const text =
      typeof data === 'string'
        ? data
        : data instanceof Buffer
          ? data.toString('utf8')
          : null;
    if (!text) return;

    let parsed: CdpResponse;
    try {
      parsed = JSON.parse(text) as CdpResponse;
    } catch {
      return;
    }
    if (parsed.id === undefined) return;

    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    this.pending.delete(parsed.id);
    if (parsed.error) {
      pending.reject(new Error(parsed.error.message ?? 'Chrome DevTools command failed'));
      return;
    }
    pending.resolve(parsed.result);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}

function keyEventParams(input: BrowserKeyInputDto): Record<string, unknown> {
  const text = printableKey(input) ? input.key : undefined;
  return {
    key: input.key,
    ...(input.code ? { code: input.code } : {}),
    ...(text ? { text, unmodifiedText: text } : {}),
    modifiers: keyModifiers(input),
  };
}

function printableKey(input: BrowserKeyInputDto): boolean {
  return input.key.length === 1 && !input.metaKey && !input.ctrlKey;
}

function keyModifiers(input: BrowserKeyInputDto): number {
  return (input.altKey ? 1 : 0)
    | (input.ctrlKey ? 2 : 0)
    | (input.metaKey ? 4 : 0)
    | (input.shiftKey ? 8 : 0);
}
