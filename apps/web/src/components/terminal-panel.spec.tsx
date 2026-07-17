import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { TerminalPanel, readTerminalTheme, shouldUseDesktopTerminal } from './terminal-panel';

const xtermMocks = vi.hoisted(() => {
  const instances: Array<{ onData: ReturnType<typeof vi.fn>; loadAddon: ReturnType<typeof vi.fn>; open: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; cols: number; rows: number; options: { theme?: { background: string; foreground: string } } }> = [];
  class Terminal {
    cols = 80;
    rows = 24;
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn();
    dispose = vi.fn();
    options: { theme?: { background: string; foreground: string } };
    constructor(opts: { theme?: { background: string; foreground: string } }) {
      this.options = opts;
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

describe('terminal theme tokens', () => {
  it('derives the xterm theme from the --terminal-bg / --terminal-fg CSS vars', () => {
    const el = document.createElement('div');
    // Stub the computed style so we can assert the resolver reads the tokens,
    // not literal hex — jsdom does not resolve real CSS custom properties.
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: (name: string) =>
        name === '--terminal-bg' ? 'oklch(0.5 0 0)' : name === '--terminal-fg' ? 'oklch(0.9 0 0)' : '',
    } as unknown as CSSStyleDeclaration);

    expect(readTerminalTheme(el)).toEqual({
      background: 'oklch(0.5 0 0)',
      foreground: 'oklch(0.9 0 0)',
    });
  });

  it('passes the token-derived theme into the xterm constructor', async () => {
    render(<TerminalPanel cwd="/tmp" />);
    await waitFor(() => expect(xtermMocks.instances).toHaveLength(1));
    const term = xtermMocks.instances[0];
    // The theme is token-derived (reads --terminal-bg / --terminal-fg); when the
    // computed vars are unavailable (jsdom), it falls back to the dark content
    // surface hex so xterm always gets a concrete, parseable color.
    expect(term.options.theme?.background).toBe('#181818');
    expect(term.options.theme?.foreground).toBe('#E6E6E6');
  });
});

describe('shouldUseDesktopTerminal', () => {
  it('allows the desktop node-pty backend only on loopback origins', () => {
    expect(shouldUseDesktopTerminal('localhost')).toBe(true);
    expect(shouldUseDesktopTerminal('127.0.0.1')).toBe(true);
    expect(shouldUseDesktopTerminal('[::1]')).toBe(true);
  });

  it('forces the server WebSocket backend for remote origins', () => {
    // Connected to a remote nuncio server: a local node-pty shell would open
    // on the wrong machine — the project lives on the server.
    expect(shouldUseDesktopTerminal('oscars-macbook-pro.tailf08532.ts.net')).toBe(false);
    expect(shouldUseDesktopTerminal('100.111.98.6')).toBe(false);
    expect(shouldUseDesktopTerminal('192.168.1.20')).toBe(false);
  });
});
