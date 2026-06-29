import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';

export interface CodexServerNotification {
  method: string;
  params?: unknown;
}

export interface CodexServerRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

interface CodexResponse {
  id: string | number;
  result?: unknown;
  error?: {
    message?: string;
    code?: number;
  };
}

interface PendingRequest {
  method: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface CodexAppServerTransport {
  send(message: unknown): void;
  close(): void;
  on(event: 'line', listener: (line: string) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface CodexAppServerClientLike {
  initialize(): Promise<void>;
  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
  onNotification(listener: (notification: CodexServerNotification) => void): () => void;
  onServerRequest(listener: (request: CodexServerRequest) => void): () => void;
  onClose(listener: (error: Error) => void): () => void;
  respond(id: string | number, result: unknown): void;
  close(): void;
}

export class CodexStdioTransport extends EventEmitter implements CodexAppServerTransport {
  private readonly output: readline.Interface;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    super();
    this.output = readline.createInterface({ input: child.stdout });
    this.output.on('line', (line) => this.emit('line', line));
    child.stderr.on('data', () => undefined);
    child.on('error', (error) => this.emit('error', error));
    child.on('exit', (code, signal) => this.emit('exit', code, signal));
  }

  static spawn(input: {
    binaryPath: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
  }): CodexStdioTransport {
    return new CodexStdioTransport(
      spawn(input.binaryPath, ['app-server'], {
        cwd: input.cwd,
        env: input.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
  }

  send(message: unknown): void {
    if (!this.child.stdin.writable) {
      throw new Error('Cannot write to codex app-server stdin.');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  close(): void {
    this.output.close();
    if (!this.child.killed) {
      this.child.kill();
    }
  }
}

export class CodexAppServerClient implements CodexAppServerClientLike {
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly notifications = new Set<(notification: CodexServerNotification) => void>();
  private readonly serverRequests = new Set<(request: CodexServerRequest) => void>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private closeError?: Error;

  constructor(private readonly transport: CodexAppServerTransport) {
    transport.on('line', (line) => this.handleLine(line));
    transport.on('error', (error) => this.handleClose(error));
    transport.on('exit', (code, signal) => {
      this.handleClose(new Error(`codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`));
    });
  }

  initialize(): Promise<void> {
    return this.request('initialize', {
      clientInfo: {
        name: 'nuncio',
        version: '0.1.0',
      },
      experimentalApi: true,
    }).then(() => {
      this.transport.send({ method: 'initialized' });
    });
  }

  request<T>(method: string, params: unknown, timeoutMs = 20_000): Promise<T> {
    const id = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);
      timeout.unref?.();

      this.pending.set(String(id), {
        method,
        timeout,
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.transport.send({ id, method, params });
    });
  }

  onNotification(listener: (notification: CodexServerNotification) => void): () => void {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  onServerRequest(listener: (request: CodexServerRequest) => void): () => void {
    this.serverRequests.add(listener);
    return () => this.serverRequests.delete(listener);
  }

  onClose(listener: (error: Error) => void): () => void {
    if (this.closeError) {
      queueMicrotask(() => listener(this.closeError!));
      return () => undefined;
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  respond(id: string | number, result: unknown): void {
    this.transport.send({ id, result });
  }

  close(): void {
    this.handleClose(new Error('codex app-server client closed.'));
    this.transport.close();
  }

  private handleLine(line: string): void {
    if (!line.trim() || line.startsWith('^CToken usage:')) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== 'object') {
      return;
    }

    const message = parsed as Record<string, unknown>;
    if ((typeof message.id === 'string' || typeof message.id === 'number') && typeof message.method === 'string') {
      this.emitServerRequest({
        id: message.id,
        method: message.method,
        ...(message.params !== undefined ? { params: message.params } : {}),
      });
      return;
    }

    if (typeof message.method === 'string') {
      this.emitNotification({
        method: message.method,
        ...(message.params !== undefined ? { params: message.params } : {}),
      });
      return;
    }

    if (typeof message.id === 'string' || typeof message.id === 'number') {
      const response: CodexResponse = { id: message.id };
      if (message.result !== undefined) {
        response.result = message.result;
      }
      if (isCodexResponseError(message.error)) {
        response.error = message.error;
      }
      this.handleResponse(response);
    }
  }

  private handleResponse(response: CodexResponse): void {
    const key = String(response.id);
    const pending = this.pending.get(key);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(key);
    if (response.error) {
      pending.reject(new Error(`${pending.method} failed: ${response.error.message ?? 'unknown error'}`));
      return;
    }

    pending.resolve(response.result);
  }

  private emitNotification(notification: CodexServerNotification): void {
    for (const listener of this.notifications) listener(notification);
  }

  private emitServerRequest(request: CodexServerRequest): void {
    for (const listener of this.serverRequests) listener(request);
  }

  private handleClose(error: Error): void {
    if (this.closeError) return;
    this.closeError = error;
    this.rejectAll(error);
    for (const listener of this.closeListeners) listener(error);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function isCodexResponseError(value: unknown): value is CodexResponse['error'] {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const error = value as Record<string, unknown>;
  return (
    (error.message === undefined || typeof error.message === 'string') &&
    (error.code === undefined || typeof error.code === 'number')
  );
}
