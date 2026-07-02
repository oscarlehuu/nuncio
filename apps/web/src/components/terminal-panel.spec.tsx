import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { TerminalPanel } from './terminal-panel';

const xtermMocks = vi.hoisted(() => {
  const instances: Array<{ onData: ReturnType<typeof vi.fn>; loadAddon: ReturnType<typeof vi.fn>; open: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; cols: number; rows: number }> = [];
  class Terminal {
    cols = 80;
    rows = 24;
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn();
    dispose = vi.fn();
    constructor() {
      instances.push(this);
    }
  }
  return { instances, Terminal };
});

const fitMocks = vi.hoisted(() => {
  class FitAddon {
    fit = vi.fn();
  }
  return { FitAddon };
});

vi.mock('@xterm/xterm', () => ({ Terminal: xtermMocks.Terminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: fitMocks.FitAddon }));

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  readyState = 1;
  url: string;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
}

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  xtermMocks.instances.length = 0;
  MockWebSocket.instances.length = 0;
  delete window.nuncioDesktop;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete window.nuncioDesktop;
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    writable: true,
    value: originalWebSocket,
  });
});

describe('TerminalPanel', () => {
  it('uses the desktop terminal bridge when available', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const onData = vi.fn(() => vi.fn());
    window.nuncioDesktop = {
      terminal: {
        create,
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        onData,
        onExit: vi.fn(() => vi.fn()),
      },
    };

    render(<TerminalPanel cwd="/tmp" />);

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/tmp', cols: 80, rows: 24 }));
    expect(onData).toHaveBeenCalledWith(expect.any(Function));
  });

  it('opens the loopback server WebSocket and starts a PTY without the desktop bridge', async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: MockWebSocket,
    });

    render(<TerminalPanel cwd="/workspace" />);

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0];
    expect(ws.url).toBe('ws://localhost/api/terminal');

    ws.onopen?.(new Event('open'));

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'start', cwd: '/workspace', cols: 80, rows: 24 }));
  });
});
