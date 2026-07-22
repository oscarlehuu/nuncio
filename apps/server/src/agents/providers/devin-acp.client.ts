import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';

export interface DevinAcpNotification { method: string; params?: unknown }
export interface DevinAcpRequest { id: string | number; method: string; params?: unknown }
export interface DevinAcpError { code: number; message: string; data?: unknown }

export class DevinAcpRequestError extends Error {
  constructor(
    readonly method: string,
    readonly rpcError: DevinAcpError,
  ) {
    super(rpcError.message);
    this.name = 'DevinAcpRequestError';
  }
}

interface Pending {
  method: string;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}
interface Transport {
  send(message: unknown): void;
  close(): void;
  on(event: 'line', listener: (line: string) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface DevinAcpClientLike {
  initialize(): Promise<void>;
  request<T>(method: string, params: unknown, timeoutMs?: number | null): Promise<T>;
  onNotification(listener: (notification: DevinAcpNotification) => void): () => void;
  onServerRequest(listener: (request: DevinAcpRequest) => void): () => void;
  onClose(listener: (error: Error) => void): () => void;
  respond(id: string | number, result: unknown): void;
  respondError(id: string | number, error: DevinAcpError): void;
  close(): void;
}

export class DevinAcpStdioTransport extends EventEmitter implements Transport {
  private readonly output: readline.Interface;
  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    super();
    this.output = readline.createInterface({ input: child.stdout });
    this.output.on('line', (line) => this.emit('line', line));
    child.stderr.on('data', () => undefined);
    child.on('error', (error) => this.emit('error', error));
    child.on('exit', (code, signal) => this.emit('exit', code, signal));
  }
  static spawn(input: { binaryPath: string; cwd: string; env: NodeJS.ProcessEnv }): DevinAcpStdioTransport {
    return new DevinAcpStdioTransport(spawn(input.binaryPath, ['acp'], {
      cwd: input.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe'],
    }));
  }
  send(message: unknown): void {
    if (!this.child.stdin.writable) throw new Error('Cannot write to Devin ACP stdin.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  close(): void {
    this.output.close();
    if (!this.child.killed) this.child.kill();
  }
}

export class DevinAcpClient implements DevinAcpClientLike {
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private readonly notifications = new Set<(notification: DevinAcpNotification) => void>();
  private readonly requests = new Set<(request: DevinAcpRequest) => void>();
  private readonly closes = new Set<(error: Error) => void>();
  private closeError?: Error;
  private transportClosed = false;
  constructor(private readonly transport: Transport) {
    transport.on('line', (line) => this.handleLine(line));
    transport.on('error', (error) => this.handleClose(error));
    transport.on('exit', (code, signal) => this.handleClose(new Error(`Devin ACP exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`)));
  }
  initialize(): Promise<void> {
    return this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    }).then(() => undefined);
  }
  request<T>(method: string, params: unknown, timeoutMs: number | null = 120_000): Promise<T> {
    if (this.closeError) return Promise.reject(this.closeError);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs !== null) {
        const delayMs = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0;
        timer = setTimeout(() => {
          this.pending.delete(String(id));
          reject(new Error(`Timed out waiting for ${method}.`));
        }, delayMs);
        timer.unref?.();
      }
      this.pending.set(String(id), {
        method,
        ...(timer ? { timer } : {}),
        resolve: (value) => resolve(value as T),
        reject,
      });
      try {
        this.transport.send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.pending.delete(String(id));
        if (timer) clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  onNotification(listener: (notification: DevinAcpNotification) => void): () => void {
    this.notifications.add(listener); return () => this.notifications.delete(listener);
  }
  onServerRequest(listener: (request: DevinAcpRequest) => void): () => void {
    this.requests.add(listener); return () => this.requests.delete(listener);
  }
  onClose(listener: (error: Error) => void): () => void {
    if (this.closeError) queueMicrotask(() => listener(this.closeError!));
    else this.closes.add(listener);
    return () => this.closes.delete(listener);
  }
  respond(id: string | number, result: unknown): void {
    this.transport.send({ jsonrpc: '2.0', id, result });
  }
  respondError(id: string | number, error: DevinAcpError): void {
    this.transport.send({ jsonrpc: '2.0', id, error });
  }
  close(): void {
    this.handleClose(new Error('Devin ACP client closed.'));
    if (this.transportClosed) return;
    this.transportClosed = true;
    this.transport.close();
  }
  private handleLine(line: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return; }
    if (!parsed || typeof parsed !== 'object') return;
    const message = parsed as Record<string, unknown>;
    const id = message.id;
    if ((typeof id === 'string' || typeof id === 'number') && typeof message.method === 'string') {
      this.requests.forEach((listener) => listener({ id, method: message.method as string, ...(message.params !== undefined ? { params: message.params } : {}) }));
    } else if (typeof message.method === 'string') {
      this.notifications.forEach((listener) => listener({ method: message.method as string, ...(message.params !== undefined ? { params: message.params } : {}) }));
    } else if (typeof id === 'string' || typeof id === 'number') {
      const pending = this.pending.get(String(id));
      if (!pending) return;
      this.pending.delete(String(id));
      if (pending.timer) clearTimeout(pending.timer);
      const error = message.error;
      if (error && typeof error === 'object') {
        const rpcError = error as Record<string, unknown>;
        pending.reject(new DevinAcpRequestError(pending.method, {
          code: typeof rpcError.code === 'number' ? rpcError.code : -32603,
          message: String(rpcError.message ?? `ACP request ${pending.method} failed.`),
          ...(rpcError.data !== undefined ? { data: rpcError.data } : {}),
        }));
      } else pending.resolve(message.result);
    }
  }
  private handleClose(error: Error): void {
    if (this.closeError) return;
    this.closeError = error;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear(); this.closes.forEach((listener) => listener(error));
  }
}
