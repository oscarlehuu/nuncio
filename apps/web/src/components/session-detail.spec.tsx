import type { ComponentProps } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionDetail } from './session-detail';
import { INSPECTOR_PREFERENCE_STORAGE_KEY } from '../lib/inspector-preference';
import { fetchGitStatus } from '../lib/api';
import type { Session, SessionEvent } from '../lib/api';
import type { ModelProvider } from '../lib/model-providers';

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
vi.mock('./browser-panel', () => ({
  getDesktopBrowserBridge: () => (
    window as Window & { nuncioDesktop?: { browser?: unknown } }
  ).nuncioDesktop?.browser,
  BrowserPanel: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="browser-panel">Browser {sessionId}</div>
  ),
}));

vi.mock('./file-explorer-panel', () => ({
  FileExplorerPanel: ({ root }: { root?: string }) => (
    <div data-testid="file-explorer-panel">Files {root}</div>
  ),
}));

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

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    fetchGitStatus: vi.fn(async () => ({
      branch: 'nuncio/s1-fix-auth',
      ahead: 0,
      behind: 0,
      clean: true,
      files: [],
    })),
    fetchGitDiff: vi.fn(async () => ({ diff: '', truncated: false })),
    fetchPullRequest: vi.fn(async () => null),
    commitSession: vi.fn(),
    pushSession: vi.fn(),
    openPullRequest: vi.fn(),
  };
});

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    title: 'Build feature X',
    status: 'IDLE',
    provider: 'pi',
    model: 'claude-fable-5',
    modelOptions: null,
    prompt: 'do it',
    preview: null,
    workspace: null,
    projectPath: null,
    baseBranch: null,
    worktreePath: null,
    branch: null,
    cursorBackend: null,
    cursorChatId: null,
    supportsInteraction: false,
    createdAt: Date.now() - 3_600_000,
    updatedAt: Date.now() - 120_000,
    ...overrides,
  };
}

const NO_EVENTS: SessionEvent[] = [];

async function renderDetail(
  overrides: Partial<Session> = {},
  events: SessionEvent[] = NO_EVENTS,
  providers?: ModelProvider[],
  extraProps: Partial<ComponentProps<typeof SessionDetail>> = {},
) {
  const onSteer = vi.fn();
  const onPause = vi.fn();
  const onArchive = vi.fn();
  const view = render(
    <SessionDetail
      session={makeSession(overrides)}
      events={events}
      providers={providers}
      onSteer={onSteer}
      onPause={onPause}
      onArchive={onArchive}
      {...extraProps}
    />,
  );
  return { onSteer, onPause, onArchive, ...view };
}

describe('SessionDetail', () => {
  beforeEach(() => {
    delete (window as Window & { nuncioDesktop?: unknown }).nuncioDesktop;
    // The inspector dock persists open/tab state per device; isolate tests.
    localStorage.clear();
    MockWebSocket.instances.length = 0;
  });

  afterEach(() => {
    delete (window as Window & { nuncioDesktop?: unknown }).nuncioDesktop;
  });

  it('calls onSteer with the message when send is clicked', async () => {
    const { onSteer } = await renderDetail();
    const textarea = screen.getByPlaceholderText(/steer the agent/i);
    await userEvent.type(textarea, 'Use the cache layer');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(onSteer).toHaveBeenCalledWith('Use the cache layer');
  });

  it('clears the composer immediately after sending while steer is still settling', async () => {
    let resolveSteer!: () => void;
    const onSteer = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSteer = resolve;
        }),
    );
    render(
      <SessionDetail
        session={makeSession()}
        events={NO_EVENTS}
        onSteer={onSteer}
        onPause={vi.fn()}
        onArchive={vi.fn()}
      />,
    );

    const textarea = screen.getByPlaceholderText(/steer the agent/i);
    await userEvent.type(textarea, 'Use the cache layer');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(onSteer).toHaveBeenCalledWith('Use the cache layer');
    expect(textarea).toHaveValue('');
    resolveSteer();
  });

  it('shows a load-earlier control when older history exists and forwards clicks', async () => {
    const onLoadEarlier = vi.fn();
    await renderDetail({}, NO_EVENTS, undefined, { hasEarlier: true, onLoadEarlier });

    const button = screen.getByRole('button', { name: /load earlier/i });
    await userEvent.click(button);
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
  });

  it('hides the load-earlier control when the full history is loaded', async () => {
    await renderDetail({}, NO_EVENTS, undefined, { hasEarlier: false, onLoadEarlier: vi.fn() });
    expect(screen.queryByRole('button', { name: /load earlier/i })).toBeNull();
  });

  it('shows the verify chip from the latest verify events', async () => {
    const events: SessionEvent[] = [
      { seq: 1, type: 'status', payload: { status: 'IDLE' }, createdAt: 1 },
      {
        seq: 2,
        type: 'verify_result',
        payload: { command: '.nuncio/verify', ok: true, exitCode: 0 },
        createdAt: 2,
      },
    ];
    await renderDetail({}, events);
    expect(screen.getByLabelText(/checks passed/i)).toBeInTheDocument();
  });

  it('shows a running verify chip while checks are in flight', async () => {
    const events: SessionEvent[] = [
      { seq: 1, type: 'verify_start', payload: { command: 'bun test' }, createdAt: 1 },
    ];
    await renderDetail({}, events);
    expect(screen.getByLabelText(/checks running/i)).toBeInTheDocument();
  });

  it('calls onPause when the pause button is clicked while IDLE', async () => {
    const { onPause } = await renderDetail({ status: 'IDLE' });
    await userEvent.click(screen.getByRole('button', { name: /session actions/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: /pause session/i }));
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it('calls onArchive when the archive button is clicked', async () => {
    const { onArchive } = await renderDetail();
    await userEvent.click(screen.getByRole('button', { name: /session actions/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: /archive session/i }));
    expect(onArchive).toHaveBeenCalledTimes(1);
  });

  it('shows Send alongside Stop while RUNNING; Stop falls back to onPause', async () => {
    const { onPause } = await renderDetail({ status: 'RUNNING' });
    // The composer stays available while running — sends queue or steer live.
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
    const stop = screen.getByRole('button', { name: /stop session/i });
    expect(stop).toBeEnabled();
    await userEvent.click(stop);
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it('Stop calls onInterrupt when the provider supports interrupt', async () => {
    const onInterrupt = vi.fn();
    const { onPause } = await renderDetail(
      { status: 'RUNNING', supportsInterrupt: true },
      NO_EVENTS,
      undefined,
      { onInterrupt },
    );
    await userEvent.click(screen.getByRole('button', { name: /stop session/i }));
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(onPause).not.toHaveBeenCalled();
  });

  it('sends a steer while RUNNING instead of blocking the input', async () => {
    const { onSteer } = await renderDetail({
      status: 'RUNNING',
      supportsSteerWhileRunning: true,
    });
    const textarea = screen.getByPlaceholderText(/steer the live run/i);
    expect(textarea).toBeEnabled();
    await userEvent.type(textarea, 'change direction');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(onSteer).toHaveBeenCalledWith('change direction');
  });

  it('keeps archive button when RUNNING', async () => {
    await renderDetail({ status: 'RUNNING' });
    await userEvent.click(screen.getByRole('button', { name: /session actions/i }));
    expect(screen.getByRole('menuitem', { name: /archive session/i })).toBeInTheDocument();
  });

  it('does not show a pause button when ARCHIVED', async () => {
    await renderDetail({ status: 'ARCHIVED' });
    const actions = screen.queryByRole('button', { name: /session actions/i });
    if (actions) await userEvent.click(actions);
    expect(screen.queryByRole('menuitem', { name: /pause session/i })).toBeNull();
  });

  it('shows Nuncio is working indicator when RUNNING with no content', async () => {
    await renderDetail({ status: 'RUNNING' });
    expect(screen.getByTestId('working-indicator')).toHaveTextContent(/Nuncio is working/i);
  });

  it('shows Nuncio is writing when RUNNING with streaming deltas', async () => {
    const events: SessionEvent[] = [
      { seq: 1, type: 'assistant_delta', payload: { delta: 'Hello' }, createdAt: Date.now() },
    ];
    await renderDetail({ status: 'RUNNING' }, events);
    expect(screen.getByTestId('working-indicator')).toHaveTextContent(/Nuncio is writing/i);
  });

  it('renders the working indicator BELOW the user message, not above it', async () => {
    const events: SessionEvent[] = [
      { seq: 1, type: 'user_message', payload: { text: 'do the thing' }, createdAt: Date.now() },
    ];
    await renderDetail({ status: 'RUNNING' }, events);
    const indicator = screen.getByTestId('working-indicator');
    const userMsg = screen.getByText('do the thing');
    // Indicator must follow the user message in DOM order (below, not above).
    const position = userMsg.compareDocumentPosition(indicator);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // And it must NOT precede the user message.
    expect(position & Node.DOCUMENT_POSITION_PRECEDING).toBeFalsy();
  });

  it('renders the working indicator after the last user message when deltas exist', async () => {
    const events: SessionEvent[] = [
      { seq: 1, type: 'user_message', payload: { text: 'first prompt' }, createdAt: Date.now() },
      { seq: 2, type: 'assistant_delta', payload: { delta: 'streaming reply' }, createdAt: Date.now() },
    ];
    await renderDetail({ status: 'RUNNING' }, events);
    const indicator = screen.getByTestId('working-indicator');
    const userMsg = screen.getByText('first prompt');
    const position = userMsg.compareDocumentPosition(indicator);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders provider approval requests and sends an approve decision', async () => {
    const onRespondProviderRequest = vi.fn();
    const events: SessionEvent[] = [
      {
        seq: 1,
        type: 'provider_request',
        payload: {
          requestId: 'req-1',
          provider: 'codex',
          method: 'exec/approval',
          status: 'pending',
          params: { command: 'git status' },
        },
        createdAt: Date.now(),
      },
    ];

    await renderDetail(
      { status: 'RUNNING', provider: 'codex' },
      events,
      undefined,
      { onRespondProviderRequest },
    );

    expect(screen.getByText('git status')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /approve request/i }));
    expect(onRespondProviderRequest).toHaveBeenCalledWith('req-1', 'approve');
  });

  it('marks provider approval requests as resolved', async () => {
    const events: SessionEvent[] = [
      {
        seq: 1,
        type: 'provider_request',
        payload: {
          requestId: 'req-1',
          provider: 'codex',
          method: 'exec/approval',
          status: 'pending',
          params: { command: 'git status' },
        },
        createdAt: Date.now(),
      },
      {
        seq: 2,
        type: 'provider_request_resolved',
        payload: { requestId: 'req-1', decision: 'deny', status: 'resolved' },
        createdAt: Date.now(),
      },
    ];

    await renderDetail({ status: 'RUNNING', provider: 'codex' }, events);

    expect(screen.getByText(/denied/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve request/i })).toBeNull();
  });

  it('does not render a Home button or Home text in the session header', async () => {
    await renderDetail();
    expect(screen.queryByRole('button', { name: /home/i })).toBeNull();
    expect(screen.queryByText(/^home$/i)).toBeNull();
  });

  it('does not auto-scroll transcript on delta updates', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const events: SessionEvent[] = [
      { seq: 1, type: 'user_message', payload: { text: 'Hi' }, createdAt: Date.now() },
    ];
    const { rerender } = await renderDetail({ status: 'RUNNING' }, events);

    const scrollEl = document.querySelector('.overflow-y-auto') as HTMLDivElement;
    expect(scrollEl).toBeTruthy();
    scrollEl.scrollTop = 0;

    const moreEvents: SessionEvent[] = [
      ...events,
      { seq: 2, type: 'assistant_delta', payload: { delta: 'A'.repeat(200) }, createdAt: Date.now() },
    ];
    rerender(
      <SessionDetail
        session={makeSession({ status: 'RUNNING' })}
        events={moreEvents}
        onSteer={vi.fn()}
        onPause={vi.fn()}
        onArchive={vi.fn()}
      />,
    );

    expect(scrollEl.scrollTop).toBe(0);
    vi.useRealTimers();
  });

  it('toggles the source control dock open and closed', async () => {
    await renderDetail({
      projectPath: '/Users/dev/code/nuncio',
      branch: 'nuncio/s1-fix-auth',
    });
    expect(screen.queryByText('Source Control')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /toggle panel/i }));
    expect(await screen.findByText('Source Control')).toBeInTheDocument();

    const close = screen.getByRole('button', { name: /close panel/i });
    await userEvent.click(close);
    expect(screen.queryByText('Source Control')).toBeNull();
  });

  it('opens source control with an empty commit message instead of the session title', async () => {
    vi.mocked(fetchGitStatus).mockResolvedValueOnce({
      branch: 'nuncio/s1-fix-auth',
      ahead: 0,
      behind: 0,
      clean: false,
      files: [
        { path: 'src/app.ts', index: 'M', workTree: ' ', staged: true, insertions: 1, deletions: 0 },
      ],
    });

    await renderDetail({
      title: 'Session title should not prefill commits',
      projectPath: '/Users/dev/code/nuncio',
      branch: 'nuncio/s1-fix-auth',
    });

    await userEvent.click(screen.getByRole('button', { name: /toggle panel/i }));
    const message = await screen.findByPlaceholderText(/commit message/i);

    expect(message).toHaveValue('');
    expect(screen.getByRole('button', { name: /^commit/i })).toBeDisabled();
  });

  it('does not show the source control toggle when there is no git context', async () => {
    await renderDetail();
    await userEvent.click(screen.getByRole('button', { name: /toggle panel/i }));
    expect(screen.queryByRole('button', { name: /toggle source control/i })).toBeNull();
  });

  it('does not show the browser dock in the web/PWA app', async () => {
    await renderDetail();
    const panelToggle = screen.getByRole('button', { name: /toggle panel/i });
    await userEvent.click(panelToggle);
    expect(screen.queryByRole('button', { name: /toggle browser/i })).toBeNull();
    expect(screen.queryByTestId('browser-panel')).toBeNull();
  });

  it('toggles the browser dock open and closed in the desktop app', async () => {
    (window as Window & { nuncioDesktop?: unknown }).nuncioDesktop = {
      browser: {
        show: vi.fn(),
        navigate: vi.fn(),
        reload: vi.fn(),
        resize: vi.fn(),
        hide: vi.fn(),
      },
    };

    await renderDetail();
    expect(screen.queryByTestId('browser-panel')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /toggle panel/i }));
    await userEvent.click(screen.getByRole('button', { name: /toggle browser/i }));
    expect(screen.getByText('Browser')).toBeInTheDocument();
    expect(screen.getByTestId('browser-panel')).toHaveTextContent('Browser s1');

    await userEvent.click(screen.getByRole('button', { name: /close panel/i }));
    expect(screen.queryByTestId('browser-panel')).toBeNull();
  });

  it('shows the files toggle for a working directory and keeps side panels mutually exclusive', async () => {
    (window as Window & { nuncioDesktop?: unknown }).nuncioDesktop = {
      browser: {
        show: vi.fn(),
        navigate: vi.fn(),
        reload: vi.fn(),
        resize: vi.fn(),
        hide: vi.fn(),
      },
    };

    await renderDetail({
      projectPath: '/Users/dev/code/nuncio',
      worktreePath: '/Users/dev/code/nuncio/.worktrees/s1',
      branch: 'nuncio/s1-fix-auth',
    });

    await userEvent.click(screen.getByRole('button', { name: /toggle panel/i }));
    const filesToggle = screen.getByRole('button', { name: /toggle files/i });
    await userEvent.click(screen.getByRole('button', { name: /toggle browser/i }));
    expect(screen.getByTestId('browser-panel')).toBeInTheDocument();

    await userEvent.click(filesToggle);
    expect(screen.getByText('Files')).toBeInTheDocument();
    expect(screen.getByTestId('file-explorer-panel')).toHaveTextContent('Files /Users/dev/code/nuncio/.worktrees/s1');
    expect(screen.queryByTestId('browser-panel')).toBeNull();
    expect(filesToggle).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(screen.getByRole('button', { name: /toggle source control/i }));
    expect(await screen.findByText('Source Control')).toBeInTheDocument();
    expect(screen.queryByTestId('file-explorer-panel')).toBeNull();
  });

  it('keeps the terminal mounted (hidden, not unmounted) after closing it', async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: MockWebSocket,
    });

    await renderDetail();

    expect(screen.queryByTestId('terminal-panel')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /toggle panel/i }));
    const toggle = screen.getByRole('button', { name: /toggle terminal/i });
    await userEvent.click(toggle);

    const panel = await screen.findByTestId('terminal-panel');
    expect(panel).toBeInTheDocument();
    let wrapper: HTMLElement | null = panel.parentElement;
    while (wrapper && !wrapper.className.includes('bg-card/60')) {
      wrapper = wrapper.parentElement;
    }
    expect(wrapper).not.toBeNull();
    expect(wrapper).not.toHaveStyle({ display: 'none' });

    await userEvent.click(toggle);

    expect(screen.getByTestId('terminal-panel')).toBeInTheDocument();
    expect(wrapper).toHaveStyle({ display: 'none' });

    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: originalWebSocket,
    });
  });

  it('keeps the terminal (and its backend socket) alive when the whole panel is closed', async () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: MockWebSocket,
    });

    await renderDetail();

    await userEvent.click(screen.getByRole('button', { name: /toggle panel/i }));
    await userEvent.click(screen.getByRole('button', { name: /toggle terminal/i }));

    await screen.findByTestId('terminal-panel');
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const ws = MockWebSocket.instances[0]!;

    const closePanel = screen.getByRole('button', { name: /close panel/i });
    await userEvent.click(closePanel);

    // Panel chrome (e.g. Source Control label / active-tool header) is gone…
    expect(screen.queryByText('Terminal')).toBeNull();
    // …but the terminal DOM and its backend socket must survive.
    expect(screen.getByTestId('terminal-panel')).toBeInTheDocument();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(ws.close).not.toHaveBeenCalled();

    let wrapper: HTMLElement | null = screen.getByTestId('terminal-panel').parentElement;
    while (wrapper && !wrapper.className.includes('bg-card/60')) {
      wrapper = wrapper.parentElement;
    }
    expect(wrapper).not.toBeNull();
    expect(wrapper).toHaveStyle({ display: 'none' });

    // Reopening the panel shows the same live terminal without spawning a new socket.
    await userEvent.click(screen.getByRole('button', { name: /toggle panel/i }));
    await screen.findByTestId('terminal-panel');
    expect(MockWebSocket.instances).toHaveLength(1);

    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: originalWebSocket,
    });
  });

  describe('inspector dock persistence', () => {
    it('restores the last-open dock tab from localStorage', async () => {
      Object.defineProperty(globalThis, 'WebSocket', {
        configurable: true,
        writable: true,
        value: MockWebSocket,
      });
      localStorage.setItem(
        INSPECTOR_PREFERENCE_STORAGE_KEY,
        JSON.stringify({ version: 1, open: true, tool: 'terminal' }),
      );

      await renderDetail();

      expect(await screen.findByTestId('terminal-panel')).toBeInTheDocument();

      Object.defineProperty(globalThis, 'WebSocket', {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      });
    });

    it('persists dock open/close and the active tab', async () => {
      await renderDetail({
        projectPath: '/Users/dev/code/nuncio',
        branch: 'nuncio/s1-fix-auth',
      });

      await userEvent.click(screen.getByRole('button', { name: /toggle panel/i }));
      await screen.findByText('Source Control');
      await waitFor(() => {
        const raw = JSON.parse(localStorage.getItem(INSPECTOR_PREFERENCE_STORAGE_KEY) ?? '{}');
        expect(raw).toMatchObject({ open: true, tool: 'scm' });
      });

      await userEvent.click(screen.getByRole('button', { name: /close panel/i }));
      await waitFor(() => {
        const raw = JSON.parse(localStorage.getItem(INSPECTOR_PREFERENCE_STORAGE_KEY) ?? '{}');
        expect(raw).toMatchObject({ open: false });
      });
    });

    it('falls back to an available tab when the persisted one is unavailable here', async () => {
      // Browser tab persisted on the desktop app, restored in the web app (no bridge).
      localStorage.setItem(
        INSPECTOR_PREFERENCE_STORAGE_KEY,
        JSON.stringify({ version: 1, open: true, tool: 'browser' }),
      );

      await renderDetail({
        projectPath: '/Users/dev/code/nuncio',
        branch: 'nuncio/s1-fix-auth',
      });

      expect(await screen.findByText('Source Control')).toBeInTheDocument();
      expect(screen.queryByTestId('browser-panel')).toBeNull();
    });
  });

  it('renders the pull request panel inside the Changes segment of the source control tab', async () => {
    await renderDetail({
      projectPath: '/Users/dev/code/nuncio',
      branch: 'nuncio/s1-fix-auth',
    });

    await userEvent.click(screen.getByRole('button', { name: /toggle panel/i }));
    await screen.findByText('Source Control');

    // Changes (default segment) stacks local changes and the session's PR.
    expect(screen.getByRole('button', { name: 'Changes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'PR' })).toBeInTheDocument(); // repo PR list segment
    expect(screen.getByText('Pull Request')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open pull request/i })).toBeInTheDocument();
  });

  it('shows repo and branch badges when workspace metadata is present', async () => {
    await renderDetail({
      projectPath: '/Users/dev/code/nuncio',
      branch: 'nuncio/s1-fix-auth',
    });
    expect(screen.getAllByText('nuncio').length).toBeGreaterThan(0);
    expect(screen.getAllByText('nuncio/s1-fix-auth').length).toBeGreaterThan(0);
  });

  it('renders repo and branch in the footer below the composer', async () => {
    await renderDetail({
      projectPath: '/Users/dev/code/nuncio',
      branch: 'nuncio/s1-fix-auth',
    });
    const footer = screen.getByTestId('session-footer');
    expect(footer).toBeInTheDocument();
    expect(footer).toHaveTextContent('nuncio');
    expect(footer).toHaveTextContent('nuncio/s1-fix-auth');
    expect(footer).toHaveTextContent('Local');
  });

  it('does not render repo or branch in the header', async () => {
    await renderDetail({
      projectPath: '/Users/dev/code/nuncio',
      branch: 'nuncio/s1-fix-auth',
    });
    const header = document.querySelector('header');
    expect(header).toBeTruthy();
    expect(header).not.toHaveTextContent('nuncio/s1-fix-auth');
  });

  it('shows the friendly model name from the provided providers catalog', async () => {
    const providers: ModelProvider[] = [
      {
        id: 'cursor',
        name: 'Cursor',
        groups: [
          {
            id: 'cursor',
            name: 'Cursor',
            models: [{ id: 'cursor:composer-2.5', name: 'Composer 2.5' }],
          },
        ],
      },
    ];
    await renderDetail({ provider: 'cursor', model: 'cursor:composer-2.5' }, NO_EVENTS, providers);
    expect(screen.getByText('Composer 2.5')).toBeInTheDocument();
    expect(screen.queryByText('cursor:composer-2.5')).toBeNull();
  });

  it('prettifies a raw cursor model slug into a readable name', async () => {
    const providers: ModelProvider[] = [
      {
        id: 'cursor',
        name: 'Cursor',
        groups: [
          {
            id: 'cursor',
            name: 'Cursor',
            models: [{ id: 'cursor:composer-2.5', name: 'composer-2.5' }],
          },
        ],
      },
    ];
    await renderDetail({ provider: 'cursor', model: 'cursor:composer-2.5' }, NO_EVENTS, providers);
    expect(screen.getByText('Composer 2.5')).toBeInTheDocument();
    expect(screen.queryByText('composer-2.5')).toBeNull();
  });

  it('falls back to the raw model id when the model is not in the catalog', async () => {
    await renderDetail({ model: 'unknown:model-x' }, NO_EVENTS, []);
    expect(screen.getByText('unknown:model-x')).toBeInTheDocument();
  });

  it('shows approval mode in the steer composer for Codex sessions only', async () => {
    const codexView = await renderDetail(
      { provider: 'codex', model: 'codex:gpt-5.5' },
      NO_EVENTS,
      [
        {
          id: 'codex',
          name: 'Codex',
          groups: [
            {
              id: 'codex',
              name: 'Codex',
              models: [{ id: 'codex:gpt-5.5', name: 'GPT 5.5' }],
            },
          ],
        },
      ],
      { approvalMode: 'full-access', onApprovalModeChange: vi.fn() },
    );
    const approval = screen.getByRole('button', { name: /approval mode: full access/i });
    expect(approval).toBeInTheDocument();
    expect(approval).toHaveAttribute('data-variant', 'ghost');
    expect(approval).not.toHaveClass('composer-picker-trigger');
    codexView.unmount();

    await renderDetail(
      { provider: 'cursor', model: 'cursor:composer-2.5' },
      NO_EVENTS,
      [
        {
          id: 'cursor',
          name: 'Cursor',
          groups: [
            {
              id: 'cursor',
              name: 'Cursor',
              models: [{ id: 'cursor:composer-2.5', name: 'Composer 2.5' }],
            },
          ],
        },
      ],
      { approvalMode: 'full-access', onApprovalModeChange: vi.fn() },
    );
    expect(screen.queryByRole('button', { name: /approval mode/i })).toBeNull();
  });

  describe('archived actions', () => {
    async function renderArchived(handlers: {
      onRestore?: (id: string) => void | Promise<void>;
      onDelete?: (id: string) => void | Promise<void>;
    } = {}) {
      const onSteer = vi.fn();
      const onPause = vi.fn();
      const onArchive = vi.fn();
      const onRestore = handlers.onRestore ?? vi.fn();
      const onDelete = handlers.onDelete ?? vi.fn();
      const view = render(
        <SessionDetail
          session={makeSession({ id: 's1', status: 'ARCHIVED' })}
          events={NO_EVENTS}
          onSteer={onSteer}
          onPause={onPause}
          onArchive={onArchive}
          onRestore={onRestore}
          onDelete={onDelete}
        />,
      );
      return { onSteer, onPause, onArchive, onRestore, onDelete, ...view };
    }

    it('shows a Restore button when the session is ARCHIVED', async () => {
      await renderArchived();
      await userEvent.click(screen.getByRole('button', { name: /session actions/i }));
      expect(screen.getByRole('menuitem', { name: /restore session/i })).toBeInTheDocument();
    });

    it('hides the archive button when the session is ARCHIVED', async () => {
      await renderArchived();
      expect(screen.queryByRole('button', { name: /archive session/i })).toBeNull();
    });

    it('calls onRestore with the session id when Restore is clicked', async () => {
      const { onRestore } = await renderArchived();
      await userEvent.click(screen.getByRole('button', { name: /session actions/i }));
      await userEvent.click(screen.getByRole('menuitem', { name: /restore session/i }));
      expect(onRestore).toHaveBeenCalledWith('s1');
    });

    it('shows a Delete button when the session is ARCHIVED', async () => {
      await renderArchived();
      await userEvent.click(screen.getByRole('button', { name: /session actions/i }));
      expect(screen.getByRole('menuitem', { name: /delete session/i })).toBeInTheDocument();
    });

    it('opens a confirmation dialog and only deletes after confirming', async () => {
      const { onDelete } = await renderArchived();
      await userEvent.click(screen.getByRole('button', { name: /session actions/i }));
      await userEvent.click(screen.getByRole('menuitem', { name: /delete session/i }));
      expect(onDelete).not.toHaveBeenCalled();
      expect(await screen.findByRole('heading', { name: /delete session/i })).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: /delete forever/i }));
      expect(onDelete).toHaveBeenCalledWith('s1');
    });

    it('cancel in the confirm dialog does not delete', async () => {
      const { onDelete } = await renderArchived();
      await userEvent.click(screen.getByRole('button', { name: /session actions/i }));
      await userEvent.click(screen.getByRole('menuitem', { name: /delete session/i }));
      await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
      expect(onDelete).not.toHaveBeenCalled();
    });

    it('does not render Restore / Delete when the session is not archived', async () => {
      const view = render(
        <SessionDetail
          session={makeSession({ status: 'IDLE' })}
          events={NO_EVENTS}
          onSteer={vi.fn()}
          onPause={vi.fn()}
          onArchive={vi.fn()}
          onRestore={vi.fn()}
          onDelete={vi.fn()}
        />,
      );
      expect(view.queryByRole('button', { name: /restore session/i })).toBeNull();
      expect(view.queryByRole('button', { name: /delete session/i })).toBeNull();
    });
  });
});

describe('SessionDetail throttled streaming', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reveals assistant deltas gradually while RUNNING', async () => {
    const longDelta = 'x'.repeat(120);
    const events: SessionEvent[] = [
      { seq: 1, type: 'assistant_delta', payload: { delta: longDelta }, createdAt: Date.now() },
    ];
    await renderDetail({ status: 'RUNNING' }, events);

    act(() => {
      vi.advanceTimersByTime(100);
    });

    const assistantBubble = screen.getByText(/^x{1,119}$/);
    expect(assistantBubble.textContent?.length).toBeLessThan(longDelta.length);

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    // Adaptive catch-up fully drains the backlog well within 2s.
    expect(assistantBubble.textContent?.length).toBe(longDelta.length);
  });

  it('flushes throttled text when assistant_message arrives', async () => {
    const full = 'Complete response text here';
    const events: SessionEvent[] = [
      { seq: 1, type: 'assistant_delta', payload: { delta: full }, createdAt: Date.now() },
      { seq: 2, type: 'assistant_message', payload: { text: full }, createdAt: Date.now() },
    ];
    await renderDetail({ status: 'IDLE' }, events);
    expect(screen.getByText(full)).toBeInTheDocument();
  });

  it('shows Continue on mobile for SDK Cursor sessions when handler provided', async () => {
    const onContinue = vi.fn();
    render(
      <SessionDetail
        session={makeSession({ provider: 'cursor', cursorBackend: 'sdk' })}
        events={NO_EVENTS}
        onSteer={vi.fn()}
        onPause={vi.fn()}
        onArchive={vi.fn()}
        onContinueOnMobile={onContinue}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /session actions/i }));
    const btn = screen.getByRole('menuitem', { name: /continue on mobile/i });
    expect(btn).toBeInTheDocument();
    await userEvent.click(btn);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('hides Continue on mobile for CLI handoff sessions', async () => {
    render(
      <SessionDetail
        session={makeSession({ provider: 'cursor', cursorBackend: 'cli' })}
        events={NO_EVENTS}
        onSteer={vi.fn()}
        onPause={vi.fn()}
        onArchive={vi.fn()}
        onContinueOnMobile={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /continue on mobile/i })).toBeNull();
  });

  it('shows Running on machine badge when machineActive', () => {
    render(
      <SessionDetail
        session={makeSession({ provider: 'cursor', cursorBackend: 'cli' })}
        events={NO_EVENTS}
        onSteer={vi.fn()}
        onPause={vi.fn()}
        onArchive={vi.fn()}
        machineActive
      />,
    );
    expect(screen.getByText('Running on machine')).toBeInTheDocument();
  });

  it('shows hint in composer while machineActive but keeps steer enabled', async () => {
    const onSteer = vi.fn();
    render(
      <SessionDetail
        session={makeSession({ provider: 'cursor', cursorBackend: 'cli', status: 'IDLE' })}
        events={NO_EVENTS}
        onSteer={onSteer}
        onPause={vi.fn()}
        onArchive={vi.fn()}
        machineActive
      />,
    );
    const textarea = screen.getByPlaceholderText(/cursor is running this chat/i);
    expect(textarea).toBeEnabled();
    await userEvent.type(textarea, 'try from phone');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(onSteer).toHaveBeenCalledWith('try from phone');
  });
});
