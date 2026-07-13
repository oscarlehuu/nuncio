import type { ComponentProps } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { SessionDetail } from './session-detail';
import { INSPECTOR_PREFERENCE_STORAGE_KEY } from '../lib/inspector-preference';
import {
  fetchSessionDiff,
  fetchChildTasks,
  fetchSessionLineage,
  startMultitask,
  startMultitaskFromQueue,
  markTaskReviewed,
  cancelTask,
  retryTask,
  updateTask,
  startTaskNow,
} from '../lib/api';
import type { Session, SessionEvent, TaskDto } from '../lib/api';
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

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}));

vi.mock('./file-explorer-panel', () => ({
  FileExplorerPanel: ({ root, openPath }: { root?: string; openPath?: string | null }) => (
    <div data-testid="file-explorer-panel">
      Files {root}
      {openPath ? ` open ${openPath}` : ''}
    </div>
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
    fetchSessionDiff: vi.fn(async () => ({
      files: [],
      truncated: false,
      omittedFiles: 0,
    })),
    postDiffComment: vi.fn(async () => ({})),
    fetchPullRequest: vi.fn(async () => null),
    commitSession: vi.fn(),
    pushSession: vi.fn(),
    openPullRequest: vi.fn(),
    fetchChildTasks: vi.fn(async () => []),
    fetchSessionLineage: vi.fn(async () => ({ ancestors: [], children: [] })),
    startMultitask: vi.fn(async () => ({ parentSessionId: 's1', tasks: [] })),
    startMultitaskFromQueue: vi.fn(async () => ({ parentSessionId: 's1', tasks: [] })),
    markTaskReviewed: vi.fn(async () => ({})),
    cancelTask: vi.fn(async () => ({})),
    retryTask: vi.fn(async () => ({})),
    updateTask: vi.fn(async () => ({})),
    startTaskNow: vi.fn(async () => ({})),
  };
});

vi.mock('../lib/usage-api', () => ({
  fetchProviderUsage: vi.fn(async () => []),
  fetchProviderUsageSnapshot: vi.fn(async () => {
    throw new Error('not mocked');
  }),
}));

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

function makeTask(overrides: Partial<TaskDto> = {}): TaskDto {
  return {
    id: 't1',
    prompt: 'Investigate the flaky test',
    status: 'RUNNING',
    provider: 'pi',
    model: 'claude-fable-5',
    modelOptions: null,
    projectPath: null,
    baseBranch: null,
    useWorktree: false,
    workspace: null,
    parentSessionId: 's1',
    role: 'subagent',
    cleanupPolicy: 'after-review',
    reviewState: null,
    sessionId: 'child-session-1',
    outcome: null,
    holdUntil: null,
    createdAt: Date.now() - 1000,
    updatedAt: Date.now(),
    startedAt: Date.now() - 500,
    finishedAt: null,
    ...overrides,
  };
}

const NO_EVENTS: SessionEvent[] = [];

function clipboardWithImage(): DataTransfer {
  const image = new File(['png'], 'screenshot.png', { type: 'image/png' });
  return { files: [image], items: [] } as unknown as DataTransfer;
}

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
    vi.clearAllMocks();
    vi.mocked(fetchSessionLineage).mockResolvedValue({ ancestors: [], children: [] });
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
    expect(onSteer).toHaveBeenCalledWith('Use the cache layer', undefined);
  });

  it('lands focus in the composer on open when autoFocusComposer is set (desktop pointer)', async () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('pointer: fine'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as typeof window.matchMedia;
    try {
      await renderDetail({}, NO_EVENTS, undefined, { autoFocusComposer: true });
      const textarea = screen.getByPlaceholderText(/steer the agent/i);
      await waitFor(() => expect(textarea).toHaveFocus());
    } finally {
      window.matchMedia = original;
    }
  });

  it('does not auto-focus the composer on a coarse (touch) pointer', async () => {
    // The default test matchMedia reports every query as non-matching → no fine pointer.
    await renderDetail({}, NO_EVENTS, undefined, { autoFocusComposer: true });
    expect(screen.getByPlaceholderText(/steer the agent/i)).not.toHaveFocus();
  });

  it('shows the attach-image control only when the provider supports images', async () => {
    const withImages = await renderDetail({ supportsImages: true });
    expect(withImages.queryByRole('button', { name: /attach image/i })).toBeInTheDocument();
    withImages.unmount();
    const withoutImages = await renderDetail({ supportsImages: false });
    expect(withoutImages.queryByRole('button', { name: /attach image/i })).toBeNull();
  });

  it('uses selected-model image metadata before the Pi provider-wide capability', async () => {
    const providers: ModelProvider[] = [
      {
        id: 'pi',
        name: 'Nuncio Engine',
        capabilities: { images: true },
        groups: [
          {
            id: 'registry',
            name: 'Registry',
            models: [
              { id: 'xai:grok', name: 'Grok', capabilities: { images: false } },
              { id: 'google:gemini', name: 'Gemini', capabilities: { images: true } },
            ],
          },
        ],
      },
    ];

    const grok = await renderDetail(
      { provider: 'pi', model: 'xai:grok', supportsImages: true },
      NO_EVENTS,
      providers,
    );
    expect(grok.queryByRole('button', { name: /attach image/i })).toBeNull();
    grok.unmount();

    const gemini = await renderDetail(
      { provider: 'pi', model: 'google:gemini', supportsImages: true },
      NO_EVENTS,
      providers,
    );
    expect(gemini.queryByRole('button', { name: /attach image/i })).toBeInTheDocument();
  });

  it('renders images the user attached to a prior message in the transcript', async () => {
    const events: SessionEvent[] = [
      {
        seq: 1,
        type: 'user_message',
        payload: { text: 'see this', images: [{ mimeType: 'image/png', id: 'abc123' }] },
        createdAt: 0,
      },
    ];
    // makeSession() uses id 's1'; the disk-referenced image resolves to its media URL.
    await renderDetail({ supportsImages: true }, events);
    const img = screen.getByRole('img', { name: /attached image/i });
    expect(img).toHaveAttribute('src', '/api/sessions/s1/media/abc123');
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

    expect(onSteer).toHaveBeenCalledWith('Use the cache layer', undefined);
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
    expect(onSteer).toHaveBeenCalledWith('change direction', undefined);
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

  it('keeps Crew-owned member sessions inspect-only while preserving the transcript', async () => {
    const crewOwner = { verifyOwner: 'crew' } as unknown as Partial<Session>;
    const events: SessionEvent[] = [
      {
        seq: 1,
        type: 'provider_request',
        payload: {
          requestId: 'req-crew',
          provider: 'codex',
          method: 'exec/approval',
          status: 'pending',
          params: { command: 'git status' },
        },
        createdAt: Date.now(),
      },
    ];

    await renderDetail(
      { ...crewOwner, status: 'RUNNING', provider: 'codex', model: 'codex:gpt-5.5' },
      events,
      undefined,
      {
        onRename: vi.fn(),
        onDelete: vi.fn(),
        onRestore: vi.fn(),
        onContinueOnMobile: vi.fn(),
        onRespondProviderRequest: vi.fn(),
      },
    );

    expect(screen.getByText('git status')).toBeInTheDocument();
    expect(screen.getByText(/managed by crew/i)).toBeInTheDocument();
    expect(screen.getByText(/inspect-only member session/i)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /send|stop session|session actions/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /approve request|approval mode/i })).toBeNull();
    await userEvent.click(screen.getByTestId('session-title'));
    expect(screen.queryByTestId('rename-input')).toBeNull();
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

  it('opens source control on the session diff surface without a duplicate commit composer', async () => {
    vi.mocked(fetchSessionDiff).mockResolvedValueOnce({
      files: [
        {
          path: 'src/app.ts',
          oldPath: null,
          status: 'modified',
          additions: 1,
          deletions: 0,
          hunks: [],
          collapsed: 'too-large',
        },
      ],
      truncated: false,
      omittedFiles: 0,
    });

    await renderDetail({
      title: 'Session title should not prefill commits',
      projectPath: '/Users/dev/code/nuncio',
      branch: 'nuncio/s1-fix-auth',
    });

    await userEvent.click(screen.getByRole('button', { name: /toggle panel/i }));
    expect(await screen.findByText('src/app.ts')).toBeInTheDocument();

    expect(fetchSessionDiff).toHaveBeenCalledWith('s1');
    expect(screen.queryByPlaceholderText(/commit message/i)).toBeNull();
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

  it('opens transcript source paths in the Files dock and web URLs externally', async () => {
    const externalOpen = vi.fn().mockResolvedValue(undefined);
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    (window as Window & { nuncioDesktop?: unknown }).nuncioDesktop = {
      external: { open: externalOpen },
    };
    const events: SessionEvent[] = [
      {
        seq: 1,
        type: 'assistant_delta',
        payload: {
          delta: 'See apps/web/src/components/session-detail.tsx and https://example.com/docs',
        },
        createdAt: Date.now(),
      },
    ];

    await renderDetail({ projectPath: '/Users/dev/code/nuncio' }, events);

    await userEvent.click(
      await screen.findByRole('link', {
        name: 'apps/web/src/components/session-detail.tsx',
      }),
    );
    expect(screen.getByText('Files')).toBeInTheDocument();
    expect(screen.getByTestId('file-explorer-panel')).toHaveTextContent(
      'Files /Users/dev/code/nuncio open apps/web/src/components/session-detail.tsx',
    );

    await userEvent.click(screen.getByRole('link', { name: 'https://example.com/docs' }));
    expect(externalOpen).toHaveBeenCalledWith('https://example.com/docs');
    expect(windowOpen).not.toHaveBeenCalled();
    windowOpen.mockRestore();
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

  it('does not expose a per-session permission picker for Codex', async () => {
    await renderDetail(
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

  describe('multitasking subagents', () => {
    it('queues normally by default when sending to a busy non-steer provider', async () => {
      const { onSteer } = await renderDetail({
        status: 'RUNNING',
        supportsSteerWhileRunning: false,
      });
      const textarea = screen.getByPlaceholderText(/your message will be queued/i);
      await userEvent.type(textarea, 'Look into the auth bug');
      await userEvent.click(screen.getByRole('button', { name: /send/i }));

      expect(onSteer).toHaveBeenCalledWith('Look into the auth bug', undefined);
      expect(startMultitask).not.toHaveBeenCalled();
    });

    it('surfaces queued steers in a panel above the composer, not inline', async () => {
      await renderDetail({ status: 'RUNNING', supportsSteerWhileRunning: false }, [
        { seq: 1, type: 'user_message', payload: { text: 'do the thing' }, createdAt: 1 },
        {
          seq: 2,
          type: 'steer_queued',
          payload: { text: 'then run the docs audit' },
          createdAt: 2,
        },
      ]);
      const panel = screen.getByTestId('queued-steers-panel');
      expect(panel).toHaveTextContent('1 Queued');
      expect(panel).toHaveTextContent('then run the docs audit');
    });

    it('has no queue panel when nothing is queued', async () => {
      await renderDetail({ status: 'RUNNING' });
      expect(screen.queryByTestId('queued-steers-panel')).not.toBeInTheDocument();
    });

    it('fans the queue out to subagents when Start Multitasking is clicked', async () => {
      const { onSteer } = await renderDetail(
        { status: 'RUNNING', supportsSteerWhileRunning: false },
        [
          { seq: 1, type: 'steer_queued', payload: { text: 'audit the docs' }, createdAt: 1 },
          { seq: 2, type: 'steer_queued', payload: { text: 'add token tabs' }, createdAt: 2 },
        ],
      );
      await userEvent.click(screen.getByRole('button', { name: /start multitasking/i }));

      await waitFor(() => expect(startMultitaskFromQueue).toHaveBeenCalledWith('s1'));
      expect(onSteer).not.toHaveBeenCalled();
    });

    it('supports /multitask as an explicit composer command', async () => {
      const { onSteer } = await renderDetail({
        status: 'RUNNING',
        supportsSteerWhileRunning: true,
      });
      const textarea = screen.getByPlaceholderText(/steer the live run/i);
      await userEvent.type(textarea, '/multitask check provider defaults');
      await userEvent.click(screen.getByRole('button', { name: /send/i }));

      await waitFor(() =>
        expect(startMultitask).toHaveBeenCalledWith(
          expect.objectContaining({ parentSessionId: 's1', prompts: ['check provider defaults'] }),
        ),
      );
      expect(onSteer).not.toHaveBeenCalled();
    });

    it('keeps image steers on the normal queue path instead of dropping attachments into multitasking', async () => {
      const { onSteer } = await renderDetail({
        status: 'RUNNING',
        supportsImages: true,
        supportsSteerWhileRunning: false,
      });
      const textarea = screen.getByPlaceholderText(/your message will be queued/i);
      fireEvent.paste(textarea, { clipboardData: clipboardWithImage() });
      await userEvent.type(textarea, 'Look at this screenshot');
      await userEvent.click(screen.getByRole('button', { name: /send/i }));

      await waitFor(() => expect(onSteer).toHaveBeenCalled());
      expect(startMultitask).not.toHaveBeenCalled();
    });

    it('renders child subagents fetched for the session', async () => {
      vi.mocked(fetchChildTasks).mockResolvedValueOnce([
        makeTask({ prompt: 'Investigate the flaky test', status: 'RUNNING' }),
      ]);
      await renderDetail({ status: 'RUNNING' });

      expect(await screen.findByTestId('subagents-panel')).toBeInTheDocument();
      expect(screen.getByText('Investigate the flaky test')).toBeInTheDocument();
      expect(screen.getByText('Running')).toBeInTheDocument();
    });

    it('shows a read-only handoff brief disclosure for child tasks', async () => {
      vi.mocked(fetchChildTasks).mockResolvedValueOnce([
        makeTask({
          prompt: 'Wire the digest UI',
          contextBrief: {
            goal: 'Ship the parent digest card',
            constraints: ['Reuse existing tokens'],
            decisions: ['Keep lineage flat'],
            files: ['apps/web/src/components/session-detail.tsx'],
            doneCriteria: ['Digest link opens the child session'],
            verifyCommand: 'bun run test:smoke-ui',
          },
        }),
      ]);
      await renderDetail({ status: 'RUNNING' });

      await screen.findByTestId('subagents-panel');
      await userEvent.click(screen.getByText('Handoff brief'));

      expect(screen.getByText('Ship the parent digest card')).toBeVisible();
      expect(screen.getByText('Reuse existing tokens')).toBeVisible();
      expect(screen.getByText('Keep lineage flat')).toBeVisible();
      expect(screen.getByText('apps/web/src/components/session-detail.tsx')).toBeVisible();
      expect(screen.getByText('Digest link opens the child session')).toBeVisible();
      expect(screen.getByText('bun run test:smoke-ui')).toBeVisible();
    });

    it('renders task completion digests with collapsed outcome and child navigation', async () => {
      const onOpenSession = vi.fn();
      await renderDetail(
        { status: 'IDLE' },
        [
          {
            seq: 1,
            type: 'task_completed',
            payload: {
              taskId: 'task-1',
              childSessionId: 'child-1',
              status: 'DONE',
              outcomeSummary: 'Digest finished cleanly',
              verify: { passed: true, output: 'ok' },
              workspace: null,
              childBranch: 'feat/delegation-digest',
            },
            createdAt: 1,
          },
        ],
        undefined,
        { onOpenSession },
      );

      expect(screen.getByTestId('task-digest-card')).toHaveTextContent('Done');
      expect(screen.getByLabelText('Checks passed')).toBeInTheDocument();
      expect(screen.getByText('feat/delegation-digest')).toBeInTheDocument();
      expect(screen.queryByText('Digest finished cleanly')).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: /show outcome/i }));
      expect(screen.getByText('Digest finished cleanly')).toBeVisible();

      await userEvent.click(screen.getByRole('link', { name: /open session/i }));
      expect(onOpenSession).toHaveBeenCalledWith('child-1');
    });

    it('renders flat lineage chips and opens related sessions', async () => {
      const onOpenSession = vi.fn();
      vi.mocked(fetchSessionLineage).mockResolvedValueOnce({
        ancestors: [{ id: 'parent-1', title: 'Parent task', status: 'IDLE', provider: 'pi' }],
        children: [
          { id: 'child-1', title: 'Child one', status: 'IDLE', provider: 'mock' },
          { id: 'child-2', title: 'Child two', status: 'RUNNING', provider: 'mock' },
        ],
      });
      await renderDetail(
        { id: 'child-current', parentSessionId: 'parent-1' },
        NO_EVENTS,
        undefined,
        { onOpenSession },
      );

      const parentChip = await screen.findByTestId('lineage-parent-chip');
      expect(parentChip).toHaveTextContent('from Parent task');
      await userEvent.click(parentChip);
      expect(onOpenSession).toHaveBeenCalledWith('parent-1');

      await userEvent.click(screen.getByTestId('lineage-children-chip'));
      expect(await screen.findByText('Child one')).toBeVisible();
      await userEvent.click(screen.getByText('Child two'));
      expect(onOpenSession).toHaveBeenCalledWith('child-2');
    });

    it('Review done marks the task reviewed and refreshes the list', async () => {
      vi.mocked(fetchChildTasks)
        .mockResolvedValueOnce([
          makeTask({ id: 't1', status: 'DONE', reviewState: 'awaiting_review' }),
        ])
        .mockResolvedValueOnce([
          makeTask({ id: 't1', status: 'DONE', reviewState: 'reviewed' }),
        ]);
      await renderDetail({ status: 'RUNNING' });

      await screen.findByTestId('subagents-panel');
      await userEvent.click(screen.getByRole('button', { name: /review done/i }));

      await waitFor(() => expect(markTaskReviewed).toHaveBeenCalledWith('t1'));
      // A second fetch refreshes the list after review.
      await waitFor(() => expect(fetchChildTasks).toHaveBeenCalledTimes(2));
      expect(await screen.findByText(/reviewed/i)).toBeInTheDocument();
    });

    it('polls for child tasks while one is RUNNING and stops when all are terminal', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        vi.mocked(fetchChildTasks)
          .mockResolvedValueOnce([makeTask({ id: 't1', status: 'RUNNING' })])
          .mockResolvedValueOnce([makeTask({ id: 't1', status: 'RUNNING' })])
          .mockResolvedValue([makeTask({ id: 't1', status: 'DONE', reviewState: 'reviewed' })]);
        await renderDetail({ status: 'RUNNING' });

        await waitFor(() => expect(fetchChildTasks).toHaveBeenCalledTimes(1));

        // Interval fires while the task is still RUNNING.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(4000);
        });
        await waitFor(() => expect(fetchChildTasks).toHaveBeenCalledTimes(2));

        // Next tick returns a terminal task, which tears the interval down.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(4000);
        });
        await waitFor(() => expect(fetchChildTasks).toHaveBeenCalledTimes(3));

        const afterTerminal = vi.mocked(fetchChildTasks).mock.calls.length;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(12000);
        });
        expect(vi.mocked(fetchChildTasks).mock.calls.length).toBe(afterTerminal);
      } finally {
        vi.useRealTimers();
      }
    });

    it('Cancel cancels a queued task and refreshes the list', async () => {
      vi.mocked(fetchChildTasks)
        .mockResolvedValueOnce([makeTask({ id: 't1', status: 'QUEUED', sessionId: null })])
        .mockResolvedValue([makeTask({ id: 't1', status: 'CANCELLED', sessionId: null })]);
      await renderDetail({ status: 'RUNNING' });

      await screen.findByTestId('subagents-panel');
      expect(screen.getByText('Queued')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: /cancel/i }));

      await waitFor(() => expect(cancelTask).toHaveBeenCalledWith('t1'));
      // The handler must refetch after cancelling — the row flips to Cancelled.
      expect(await screen.findByText('Cancelled')).toBeInTheDocument();
      expect(vi.mocked(fetchChildTasks).mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('Retry retries a terminal task and refreshes the list', async () => {
      vi.mocked(fetchChildTasks)
        .mockResolvedValueOnce([makeTask({ id: 't1', status: 'FAILED' })])
        .mockResolvedValue([makeTask({ id: 't1', status: 'RUNNING' })]);
      await renderDetail({ status: 'RUNNING' });

      await screen.findByTestId('subagents-panel');
      expect(screen.getByText('Failed')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: /retry/i }));

      await waitFor(() => expect(retryTask).toHaveBeenCalledWith('t1'));
      // The handler must refetch after retrying — the row flips back to Running.
      expect(await screen.findByText('Running')).toBeInTheDocument();
      expect(vi.mocked(fetchChildTasks).mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('Start now launches a held task and refreshes the list', async () => {
      const holdUntil = Date.now() + 12_000;
      vi.mocked(fetchChildTasks)
        .mockResolvedValueOnce([makeTask({ id: 't1', status: 'QUEUED', sessionId: null, holdUntil })])
        .mockResolvedValue([makeTask({ id: 't1', status: 'RUNNING' })]);
      await renderDetail({ status: 'RUNNING' });

      await screen.findByTestId('subagents-panel');
      expect(screen.getByTestId('subagent-countdown')).toHaveTextContent(/starts in \d+s/);
      await userEvent.click(screen.getByRole('button', { name: /start .* now/i }));

      await waitFor(() => expect(startTaskNow).toHaveBeenCalledWith('t1'));
      expect(vi.mocked(fetchChildTasks).mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('changing a held task model calls updateTask with provider, model and a re-arm', async () => {
      const holdUntil = Date.now() + 12_000;
      vi.mocked(fetchChildTasks).mockResolvedValue([
        makeTask({ id: 't1', status: 'QUEUED', sessionId: null, holdUntil, provider: 'pi', model: 'claude-fable-5' }),
      ]);
      await renderDetail(
        { status: 'RUNNING' },
        NO_EVENTS,
        [
          {
            id: 'pi',
            name: 'Nuncio Engine',
            groups: [
              {
                id: 'g',
                name: 'g',
                models: [
                  { id: 'claude-fable-5', name: 'Fable 5' },
                  { id: 'claude-opus-4-8', name: 'Opus 4.8' },
                ],
              },
            ],
          },
        ],
      );

      await screen.findByTestId('subagents-panel');
      // Open the flat model picker chip and choose a different model.
      await userEvent.click(screen.getByRole('button', { name: /fable 5/i }));
      await userEvent.click(await screen.findByText('Opus 4.8'));

      await waitFor(() =>
        expect(updateTask).toHaveBeenCalledWith(
          't1',
          expect.objectContaining({ provider: 'pi', model: 'claude-opus-4-8', holdSeconds: expect.any(Number) }),
        ),
      );
    });

    it('re-arm never shortens a window with more remaining than the default', async () => {
      // Task has ~50s left; opening the picker (server default may be 60s) must
      // NOT clamp the hold down to the 15s client default.
      const holdUntil = Date.now() + 50_000;
      vi.mocked(fetchChildTasks).mockResolvedValue([
        makeTask({ id: 't1', status: 'QUEUED', sessionId: null, holdUntil, provider: 'pi', model: 'claude-fable-5' }),
      ]);
      await renderDetail(
        { status: 'RUNNING' },
        NO_EVENTS,
        [
          {
            id: 'pi',
            name: 'Nuncio Engine',
            groups: [{ id: 'g', name: 'g', models: [{ id: 'claude-fable-5', name: 'Fable 5' }] }],
          },
        ],
      );

      await screen.findByTestId('subagents-panel');
      // Opening the picker re-arms; the chip label reflects the current model.
      await userEvent.click(screen.getByRole('button', { name: /fable 5/i }));

      await waitFor(() => expect(updateTask).toHaveBeenCalled());
      const [, patch] = vi.mocked(updateTask).mock.calls[0];
      expect(patch.holdSeconds).toBeGreaterThanOrEqual(50);
    });

    it('re-arm uses the default window when little time remains', async () => {
      const holdUntil = Date.now() + 3_000; // 3s left, below the 15s default
      vi.mocked(fetchChildTasks).mockResolvedValue([
        makeTask({ id: 't1', status: 'QUEUED', sessionId: null, holdUntil, provider: 'pi', model: 'claude-fable-5' }),
      ]);
      await renderDetail(
        { status: 'RUNNING' },
        NO_EVENTS,
        [
          {
            id: 'pi',
            name: 'Nuncio Engine',
            groups: [{ id: 'g', name: 'g', models: [{ id: 'claude-fable-5', name: 'Fable 5' }] }],
          },
        ],
      );

      await screen.findByTestId('subagents-panel');
      await userEvent.click(screen.getByRole('button', { name: /fable 5/i }));

      await waitFor(() => expect(updateTask).toHaveBeenCalled());
      const [, patch] = vi.mocked(updateTask).mock.calls[0];
      expect(patch.holdSeconds).toBe(15);
    });

    it('drops a stale child-tasks response from a previous session after switching', async () => {
      // Session A's fetch is slow; the user switches to B, whose fetch resolves
      // first. A's late response must NOT overwrite B's subagent list.
      let resolveA!: (tasks: TaskDto[]) => void;
      vi.mocked(fetchChildTasks)
        .mockImplementationOnce(
          () => new Promise<TaskDto[]>((resolve) => { resolveA = resolve; }),
        )
        .mockResolvedValueOnce([
          makeTask({ id: 't-b', prompt: "B's subagent", status: 'RUNNING', sessionId: null }),
        ]);

      const { rerender } = await renderDetail({ id: 's1', status: 'RUNNING' });

      // Switch to session B before A resolves; B's list renders.
      rerender(
        <SessionDetail
          session={makeSession({ id: 's2', status: 'RUNNING' })}
          events={NO_EVENTS}
          onSteer={vi.fn()}
          onPause={vi.fn()}
          onArchive={vi.fn()}
        />,
      );
      expect(await screen.findByText("B's subagent")).toBeInTheDocument();

      // Now A's stale response arrives — it must be dropped.
      await act(async () => {
        resolveA([
          makeTask({ id: 't-a', prompt: "A's subagent", status: 'RUNNING', sessionId: null }),
        ]);
      });

      expect(screen.getByText("B's subagent")).toBeInTheDocument();
      expect(screen.queryByText("A's subagent")).toBeNull();
    });

    it('does not leak a stale action refresh from a previous session into the new one', async () => {
      // On session A the user clicks Cancel; the cancel request is held open.
      // They switch to B (which loads its own list). When A's cancel finally
      // resolves, A's handler calls A's refreshChildTasks — bound to A's id.
      // That late refresh must NOT write A's tasks into B's view.
      let resolveCancel!: () => void;
      vi.mocked(cancelTask).mockImplementationOnce(
        () => new Promise((resolve) => { resolveCancel = () => resolve({} as TaskDto); }),
      );
      vi.mocked(fetchChildTasks)
        // A initial load: a queued task with a Cancel action.
        .mockResolvedValueOnce([makeTask({ id: 't-a', prompt: "A's subagent", status: 'QUEUED', sessionId: null })])
        // B load after the switch.
        .mockResolvedValueOnce([makeTask({ id: 't-b', prompt: "B's subagent", status: 'RUNNING', sessionId: null })])
        // A's post-cancel refresh (should be dropped).
        .mockResolvedValue([makeTask({ id: 't-a', prompt: "A's subagent", status: 'CANCELLED', sessionId: null })]);

      const { rerender } = await renderDetail({ id: 's1', status: 'RUNNING' });
      await screen.findByText("A's subagent");
      await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
      await waitFor(() => expect(cancelTask).toHaveBeenCalledWith('t-a'));

      // Switch to B before the cancel resolves; B's list renders.
      rerender(
        <SessionDetail
          session={makeSession({ id: 's2', status: 'RUNNING' })}
          events={NO_EVENTS}
          onSteer={vi.fn()}
          onPause={vi.fn()}
          onArchive={vi.fn()}
        />,
      );
      expect(await screen.findByText("B's subagent")).toBeInTheDocument();

      // A's cancel resolves late → A's handler refreshes A's list. Must be dropped.
      await act(async () => {
        resolveCancel();
      });

      expect(screen.getByText("B's subagent")).toBeInTheDocument();
      expect(screen.queryByText("A's subagent")).toBeNull();
    });

    it("commits B's own fetch even when a stale A action refresh fires first", async () => {
      // Liveness: B's mount fetch is in flight when A's late action-bound refresh
      // fires. That stale refresh must no-op WITHOUT claiming a sequence token —
      // otherwise it starves B's legitimate response and the panel stays empty.
      let resolveCancel!: () => void;
      let resolveB!: (tasks: TaskDto[]) => void;
      vi.mocked(cancelTask).mockImplementationOnce(
        () => new Promise((resolve) => { resolveCancel = () => resolve({} as TaskDto); }),
      );
      vi.mocked(fetchChildTasks)
        // A initial load.
        .mockResolvedValueOnce([makeTask({ id: 't-a', prompt: "A's subagent", status: 'QUEUED', sessionId: null })])
        // B's mount fetch — held open so A's late refresh can race ahead of it.
        .mockImplementationOnce(
          () => new Promise<TaskDto[]>((resolve) => { resolveB = resolve; }),
        )
        // Any A-bound refresh that slips through would fetch this — it must never commit.
        .mockResolvedValue([makeTask({ id: 't-a', prompt: "A's subagent", status: 'CANCELLED', sessionId: null })]);

      const { rerender } = await renderDetail({ id: 's1', status: 'RUNNING' });
      await screen.findByText("A's subagent");
      await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
      await waitFor(() => expect(cancelTask).toHaveBeenCalledWith('t-a'));

      // Switch to B; its mount fetch is now pending (resolveB not yet called).
      rerender(
        <SessionDetail
          session={makeSession({ id: 's2', status: 'RUNNING' })}
          events={NO_EVENTS}
          onSteer={vi.fn()}
          onPause={vi.fn()}
          onArchive={vi.fn()}
        />,
      );

      // A's cancel resolves → A's stale refresh fires while B's fetch is still open.
      await act(async () => {
        resolveCancel();
      });

      // Now B's own fetch resolves — it MUST commit, not be starved into emptiness.
      await act(async () => {
        resolveB([makeTask({ id: 't-b', prompt: "B's subagent", status: 'RUNNING', sessionId: null })]);
      });

      expect(await screen.findByText("B's subagent")).toBeInTheDocument();
      expect(screen.queryByText("A's subagent")).toBeNull();
    });

    it('opens a child session when its prompt is clicked', async () => {
      const onOpenSession = vi.fn();
      vi.mocked(fetchChildTasks).mockResolvedValueOnce([
        makeTask({ id: 't1', status: 'RUNNING', sessionId: 'child-session-1' }),
      ]);
      await renderDetail({ status: 'RUNNING' }, NO_EVENTS, undefined, { onOpenSession });

      await screen.findByTestId('subagents-panel');
      await userEvent.click(screen.getByRole('button', { name: /open subagent session/i }));
      expect(onOpenSession).toHaveBeenCalledWith('child-session-1');
    });
  });
});

describe('SessionDetail live streaming', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the complete received assistant delta immediately while RUNNING', async () => {
    const longDelta = 'x'.repeat(120);
    const events: SessionEvent[] = [
      { seq: 1, type: 'assistant_delta', payload: { delta: longDelta }, createdAt: Date.now() },
    ];
    await renderDetail({ status: 'RUNNING' }, events);

    expect(screen.getByText(longDelta)).toBeInTheDocument();
  });

  it('keeps the exact text when the terminal assistant_message arrives', async () => {
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
    expect(onSteer).toHaveBeenCalledWith('try from phone', undefined);
  });

  it('warns instead of silently ignoring pasted images when the session provider lacks image support', async () => {
    await renderDetail({
      provider: 'codex',
      model: 'codex:gpt-5.5',
      supportsImages: false,
    });

    fireEvent.paste(screen.getByPlaceholderText(/steer the agent/i), {
      clipboardData: clipboardWithImage(),
    });

    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/does not accept images/i));
  });
});
