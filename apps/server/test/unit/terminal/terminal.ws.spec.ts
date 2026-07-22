import { describe, expect, it } from 'bun:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket as WsClient } from 'ws';
import { TerminalService } from '../../../src/terminal/terminal.service';
import { attachTerminalWebSocketServer } from '../../../src/terminal/terminal.ws';

interface FakeTerminal {
  creates: Array<{ id: string; cwd?: string; cols: number; rows: number }>;
  kills: string[];
  writes: Array<{ id: string; data: string }>;
  resizes: Array<{ id: string; cols: number; rows: number }>;
  setOutputSink(id: string, sink: (data: string) => void): void;
  setExitSink(id: string, sink: (code: number) => void): void;
  create(options: { id: string; cwd?: string; cols: number; rows: number }): void;
  kill(id: string): void;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
}

function makeFakeTerminal(): FakeTerminal {
  return {
    creates: [],
    kills: [],
    writes: [],
    resizes: [],
    setOutputSink: () => {},
    setExitSink: () => {},
    create(options) {
      this.creates.push(options);
    },
    kill(id) {
      this.kills.push(id);
    },
    write(id, data) {
      this.writes.push({ id, data });
    },
    resize(id, cols, rows) {
      this.resizes.push({ id, cols, rows });
    },
  };
}

async function startTerminalServer(fake: FakeTerminal): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer();
  attachTerminalWebSocketServer(server, fake as unknown as TerminalService);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function connect(port: number): Promise<WsClient> {
  const ws = new WsClient(`ws://127.0.0.1:${port}/api/terminal`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timeout');
}

async function closeClient(ws: WsClient): Promise<void> {
  if (ws.readyState === WsClient.CLOSED) return;
  await new Promise<void>((resolve) => {
    ws.once('close', resolve);
    ws.close();
  });
}

describe('terminal WebSocket messages', () => {
  it.each([
    { label: 'null', value: null },
    { label: 'an empty array', value: [] },
    { label: 'a populated array', value: [{ type: 'start' }] },
    { label: 'a string', value: 'start' },
    { label: 'a Unicode string', value: '终端' },
    { label: 'zero', value: 0 },
    { label: 'a negative number', value: -1 },
    { label: 'false', value: false },
  ])('rejects $label JSON and still accepts a valid start', async ({ value }) => {
    const fake = makeFakeTerminal();
    const server = await startTerminalServer(fake);
    const ws = await connect(server.port);

    try {
      ws.send(JSON.stringify(value));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fake.creates).toEqual([]);

      ws.send(JSON.stringify({ type: 'start', cwd: '/tmp', cols: 80, rows: 24 }));
      await waitFor(() => fake.creates.length === 1);
      expect(fake.creates[0]).toMatchObject({ cwd: '/tmp', cols: 80, rows: 24 });
    } finally {
      await closeClient(ws);
      await server.close();
    }
  });
});
