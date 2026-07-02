import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TerminalDock } from './terminal-dock';

const xtermMocks = vi.hoisted(() => {
  class Terminal {
    cols = 80;
    rows = 24;
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn();
    dispose = vi.fn();
  }
  return { Terminal };
});

vi.mock('@xterm/xterm', () => ({ Terminal: xtermMocks.Terminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class FitAddon { fit = vi.fn(); } }));

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
  MockWebSocket.instances.length = 0;
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    writable: true,
    value: MockWebSocket,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    writable: true,
    value: originalWebSocket,
  });
});

describe('TerminalDock', () => {
  it('renders a single terminal tab and panel by default', async () => {
    render(<TerminalDock cwd="/tmp" />);
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    expect(screen.getAllByTestId('terminal-panel')).toHaveLength(1);
    expect(screen.getAllByRole('tab')).toHaveLength(1);
  });

  it('adds a second tab and panel when clicking New terminal', async () => {
    render(<TerminalDock cwd="/tmp" />);
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));

    await userEvent.click(screen.getByRole('button', { name: 'New terminal' }));

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    expect(screen.getAllByTestId('terminal-panel')).toHaveLength(2);
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  it('only shows the active tab panel; others are display:none', async () => {
    render(<TerminalDock cwd="/tmp" />);
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));

    await userEvent.click(screen.getByRole('button', { name: 'New terminal' }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));

    const panels = screen.getAllByTestId('terminal-panel');
    const wrappers = panels.map((panel) => panel.parentElement?.parentElement as HTMLElement);

    expect(wrappers[0]).toHaveStyle({ display: 'none' });
    expect(wrappers[1]).not.toHaveStyle({ display: 'none' });
  });

  it('removes a tab and panel when clicking its close button', async () => {
    render(<TerminalDock cwd="/tmp" />);
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));

    await userEvent.click(screen.getByRole('button', { name: 'New terminal' }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    expect(screen.getAllByTestId('terminal-panel')).toHaveLength(2);

    const closeButtons = screen.getAllByRole('button', { name: /^Close Terminal/ });
    await userEvent.click(closeButtons[closeButtons.length - 1]!);

    expect(screen.getAllByTestId('terminal-panel')).toHaveLength(1);
  });

  it('labels new tabs sequentially without skipping numbers (StrictMode)', async () => {
    render(
      <StrictMode>
        <TerminalDock cwd="/tmp" />
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByText('Terminal 1')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'New terminal' }));
    await waitFor(() => expect(screen.getByText('Terminal 2')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'New terminal' }));
    await waitFor(() => expect(screen.getByText('Terminal 3')).toBeInTheDocument());
  });

  it('removes a tab when its panel reports onExit', async () => {
    render(<TerminalDock cwd="/tmp" />);
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));

    const ws = MockWebSocket.instances[0]!;
    ws.onmessage?.({ data: JSON.stringify({ type: 'exit' }) } as MessageEvent);

    await waitFor(() => expect(screen.getAllByTestId('terminal-panel')).toHaveLength(1));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
  });
});
