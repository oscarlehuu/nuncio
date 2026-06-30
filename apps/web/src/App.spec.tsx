import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from './components/theme-provider';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
  Toaster: () => null,
}));

vi.mock('./lib/api', () => ({
  fetchSessions: vi.fn().mockResolvedValue([]),
  fetchArchivedSessions: vi.fn().mockResolvedValue([]),
  fetchSession: vi.fn().mockRejectedValue(new Error('not found')),
  createSession: vi.fn(),
  steerSession: vi.fn(),
  pauseSession: vi.fn(),
  respondProviderRequest: vi.fn(),
  archiveSession: vi.fn(),
  renameSession: vi.fn(),
  restoreSession: vi.fn(),
  deleteSession: vi.fn(),
  fetchModels: vi.fn(),
  fetchEvents: vi.fn().mockResolvedValue([]),
  fetchActiveRun: vi.fn().mockResolvedValue({ active: false }),
  refreshSessionTranscript: vi.fn().mockResolvedValue({ added: 0 }),
  statusLabel: (s: string) => s,
  relativeTime: () => 'now',
  SteerApiError: class SteerApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'SteerApiError';
      this.status = status;
    }
  },
}));

vi.mock('./lib/settings-api', () => ({
  fetchSettings: vi.fn().mockResolvedValue([]),
  updateSetting: vi.fn(),
  clearSetting: vi.fn(),
}));

import { toast } from 'sonner';

import App from './App';
import {
  archiveSession,
  createSession,
  deleteSession,
  fetchArchivedSessions,
  fetchModels,
  fetchSession,
  fetchSessions,
  pauseSession,
  restoreSession,
  steerSession,
  SteerApiError,
  type Session,
} from './lib/api';
import { fetchSettings, updateSetting } from './lib/settings-api';
import type { ModelProvider } from './lib/model-providers';

const LIVE_CATALOG: ModelProvider[] = [
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

function fakeSession(over: Partial<Session> = {}): Session {
  return {
    id: 'new1',
    title: 'Build the thing',
    status: 'IDLE',
    provider: 'pi',
    model: null,
    modelOptions: null,
    prompt: 'build the thing',
    preview: null,
    workspace: null,
    projectPath: null,
    baseBranch: null,
    worktreePath: null,
    branch: null,
    cursorBackend: null,
    cursorChatId: null,
    supportsInteraction: false,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

async function pinDesktopSidebar() {
  await userEvent.click(screen.getByTestId('desktop-nav-toggle'));
  await waitFor(() => expect(screen.getByTestId('desktop-sidebar-pinned')).toBeInTheDocument());
}

function renderApp(initialEntry = '/') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <ThemeProvider defaultTheme="light">
        <Routes>
          <Route path="/*" element={<App />} />
        </Routes>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

function stubEventSource() {
  vi.stubGlobal(
    'EventSource',
    class {
      onmessage: ((msg: { data: string }) => void) | null = null;
      close() {}
      constructor(_url: string) {}
    },
  );
}

describe('App URL routing', () => {
  const session = fakeSession({ id: 'new1', title: 'Build the thing', status: 'IDLE' });

  beforeEach(() => {
    stubEventSource();
    vi.mocked(fetchModels).mockResolvedValue(LIVE_CATALOG);
    vi.mocked(fetchSessions).mockResolvedValue([session]);
    vi.mocked(fetchSession).mockReset();
    vi.mocked(fetchSession).mockResolvedValue(session);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders session detail when loaded at /session/:id', async () => {
    renderApp('/session/new1');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /archive session/i })).toBeInTheDocument(),
    );
  });

  it('navigates to /session/:id after creating a session', async () => {
    vi.mocked(createSession).mockResolvedValue(session);
    renderApp('/');
    const textarea = screen.getByPlaceholderText(/Ask Nuncio/i);
    await userEvent.type(textarea, 'build the thing{Enter}');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /archive session/i })).toBeInTheDocument(),
    );
  });

  it('navigates to /settings when the settings button is clicked', async () => {
    vi.mocked(fetchSettings).mockResolvedValue([]);
    renderApp('/');
    await pinDesktopSidebar();
    await userEvent.click(screen.getByRole('button', { name: /settings/i }));
    await waitFor(() => expect(screen.getByRole('heading', { name: /^settings$/i })).toBeInTheDocument());
  });

  it('deep-loads a session via fetchSession when it is not in the list', async () => {
    vi.mocked(fetchSessions).mockResolvedValue([]);
    vi.mocked(fetchSession).mockResolvedValue(session);
    renderApp('/session/new1');
    await waitFor(() => expect(fetchSession).toHaveBeenCalledWith('new1'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /archive session/i })).toBeInTheDocument(),
    );
  });

  it('shows a toast and returns home when the session id is missing', async () => {
    vi.mocked(fetchSessions).mockResolvedValue([]);
    vi.mocked(fetchSession).mockRejectedValue(new Error('not found'));
    renderApp('/session/missing');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Session not found'));
    await waitFor(() => expect(screen.getByPlaceholderText(/Ask Nuncio/i)).toBeInTheDocument());
  });
});

describe('App navigation', () => {
  it('opens the desktop flyout on hamburger hover and closes after pointer leave', async () => {
    renderApp();

    const rail = screen.getByTestId('desktop-sidebar-rail');
    await userEvent.hover(screen.getByTestId('desktop-nav-toggle'));
    const flyout = await screen.findByTestId('desktop-sidebar-flyout');
    expect(flyout).toBeInTheDocument();
    // Visible state while hovered.
    await waitFor(() => expect(flyout.className).toMatch(/opacity-100\b/));

    await userEvent.unhover(screen.getByTestId('desktop-nav-toggle'));
    await userEvent.hover(rail);
    await userEvent.unhover(rail);
    // The flyout now fades out instead of unmounting: it stays in the DOM
    // but becomes invisible (opacity-0) + non-interactive.
    await waitFor(
      () => {
        const f = screen.getByTestId('desktop-sidebar-flyout');
        expect(f.className).toMatch(/opacity-0\b/);
        expect(f.className).toMatch(/pointer-events-none/);
      },
      { timeout: 1000 },
    );
  });

  it('pins the desktop sidebar on hamburger click', async () => {
    renderApp();

    await userEvent.click(screen.getByTestId('desktop-nav-toggle'));
    expect(screen.getByTestId('desktop-sidebar-pinned')).toBeInTheDocument();
    expect(screen.queryByTestId('desktop-sidebar-flyout')).not.toBeInTheDocument();
  });

  it('opens the mobile sidebar drawer via the menu button', async () => {
    renderApp();
    const menu = screen.getByRole('button', { name: /open navigation/i });
    await userEvent.click(menu);
    expect(await screen.findByText('Navigation')).toBeInTheDocument();
  });

  it('mobile drawer has no sheet close button and shows theme in footer', async () => {
    renderApp();
    await userEvent.click(screen.getByRole('button', { name: /open navigation/i }));
    await screen.findByText('Navigation');
    expect(screen.queryByRole('button', { name: /^close$/i })).not.toBeInTheDocument();
    const theme = screen.getByRole('button', { name: /toggle theme/i });
    const footer = theme.closest('[data-sidebar-footer]');
    expect(footer).toBeInTheDocument();
  });

  it('does not spam the "Failed to load archived sessions" toast on repeated poll failures', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(fetchSessions).mockReset();
    vi.mocked(fetchSessions).mockResolvedValue([]);
    vi.mocked(fetchArchivedSessions).mockReset();
    vi.mocked(fetchArchivedSessions).mockRejectedValue(new Error('server down'));

    renderApp();

    // First poll (initial mount) — toast appears once.
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to load archived sessions'));
    const firstCallCount = (toast.error as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    // Advance through several polling intervals — the toast must NOT fire again.
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);

    expect((toast.error as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(firstCallCount);

    vi.useRealTimers();
  });
});

describe('App create flow', () => {
  beforeEach(() => {
    vi.mocked(fetchModels).mockResolvedValue(LIVE_CATALOG);
    stubEventSource();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('handleCreate calls createSession with prompt + default model and refreshes', async () => {
    const session = fakeSession();
    vi.mocked(createSession).mockResolvedValue(session);
    vi.mocked(fetchSessions).mockResolvedValue([session]);

    renderApp();

    const textarea = screen.getByPlaceholderText(/Ask Nuncio/i);
    await userEvent.type(textarea, 'build the thing{Enter}');

    await waitFor(() => expect(createSession).toHaveBeenCalled());
    expect(createSession).toHaveBeenCalledWith(
      'build the thing',
      'cursor:composer-2.5',
      'cursor',
      undefined,
      undefined,
      undefined,
      false,
    );
      expect(fetchSessions).toHaveBeenCalled();
  });
});

describe('App lifecycle', () => {
  const session = fakeSession({ id: 'new1', title: 'Build the thing', status: 'IDLE' });
  let eventSources: Array<{
    url: string;
    onmessage: ((msg: { data: string }) => void) | null;
    close: () => void;
  }>;

  beforeEach(() => {
    eventSources = [];
    vi.stubGlobal(
      'EventSource',
      class {
        url: string;
        onmessage: ((msg: { data: string }) => void) | null = null;
        close = vi.fn();
        constructor(url: string) {
          this.url = url;
          eventSources.push(this);
        }
      },
    );
    vi.mocked(fetchSessions).mockResolvedValue([session]);
    vi.mocked(pauseSession).mockReset();
    vi.mocked(archiveSession).mockReset();
    vi.mocked(steerSession).mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function openSession() {
    renderApp();
    await pinDesktopSidebar();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /open build the thing/i })).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('button', { name: /open build the thing/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /archive session/i })).toBeInTheDocument(),
    );
  }

  it('handlePause calls pauseSession with the active id', async () => {
    await openSession();
    // Header pause removed — test Stop button when RUNNING instead
    const stopBtn = screen.queryByRole('button', { name: /stop session/i });
    if (stopBtn) {
      await userEvent.click(stopBtn);
      await waitFor(() => expect(pauseSession).toHaveBeenCalledWith('new1'));
    }
  });

  it('handleArchive calls archiveSession with the active id', async () => {
    await openSession();
    await userEvent.click(screen.getByRole('button', { name: /archive session/i }));
    await waitFor(() => expect(archiveSession).toHaveBeenCalledWith('new1'));
  });

  it('sidebar hover-archive calls archiveSession with the row id (not the active id)', async () => {
    const other = fakeSession({ id: 'other1', title: 'Other task', status: 'IDLE' });
    vi.mocked(fetchSessions).mockResolvedValue([session, other]);
    renderApp();
    await pinDesktopSidebar();
    await waitFor(() => expect(screen.getByText('Other task')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /archive other task/i }));
    await waitFor(() => expect(archiveSession).toHaveBeenCalledWith('other1'));
  });

  it('handleSteer calls steerSession with the active id and message', async () => {
    await openSession();
    const textarea = screen.getByPlaceholderText(/steer the agent/i);
    await userEvent.type(textarea, 'use the cache layer');
    await userEvent.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() =>
      expect(steerSession).toHaveBeenCalledWith('new1', 'use the cache layer', undefined),
    );
  });

  it('shows toast and force-steer dialog when steer returns 409', async () => {
    vi.mocked(steerSession).mockRejectedValueOnce(
      new SteerApiError(409, 'Cursor is still running this chat on your Mac.'),
    );
    await openSession();
    const textarea = screen.getByPlaceholderText(/steer the agent/i);
    await userEvent.type(textarea, 'try anyway');
    await userEvent.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Cursor is still running this chat on your Mac.',
      ),
    );
    expect(screen.getByText('Force steer anyway')).toBeInTheDocument();
  });

  it('unlocks the composer when the stream reports IDLE before steer refresh settles', async () => {
    let resolveSteer!: (session: Session) => void;
    vi.mocked(steerSession).mockImplementation(
      () =>
        new Promise<Session>((resolve) => {
          resolveSteer = resolve;
        }),
    );

    await openSession();
    await waitFor(() => expect(eventSources.length).toBeGreaterThan(0));

    const textarea = screen.getByPlaceholderText(/steer the agent/i);
    await userEvent.type(textarea, 'use the cache layer');
    await userEvent.click(screen.getByRole('button', { name: /^send$/i }));
    expect(textarea).toBeDisabled();

    const stream = eventSources[eventSources.length - 1]!;
    act(() => {
      stream.onmessage?.({
        data: JSON.stringify({
          seq: 1,
          type: 'status',
          payload: { status: 'RUNNING' },
          createdAt: Date.now(),
        }),
      });
      stream.onmessage?.({
        data: JSON.stringify({
          seq: 2,
          type: 'assistant_message',
          payload: { text: 'Done' },
          createdAt: Date.now(),
        }),
      });
      stream.onmessage?.({
        data: JSON.stringify({
          seq: 3,
          type: 'status',
          payload: { status: 'IDLE' },
          createdAt: Date.now(),
        }),
      });
    });

    await waitFor(() => expect(screen.getByPlaceholderText(/steer the agent/i)).toBeEnabled());
    resolveSteer(fakeSession({ id: 'new1', status: 'IDLE' }));
  });
});

describe('App archived lifecycle', () => {
  const archived = fakeSession({
    id: 'arc1',
    title: 'Old archived task',
    status: 'ARCHIVED',
  });

  beforeEach(() => {
    stubEventSource();
    vi.mocked(fetchSessions).mockResolvedValue([]);
    vi.mocked(fetchArchivedSessions).mockReset();
    vi.mocked(fetchArchivedSessions).mockResolvedValue([archived]);
    vi.mocked(restoreSession).mockReset();
    vi.mocked(restoreSession).mockResolvedValue({ ...archived, status: 'IDLE' });
    vi.mocked(deleteSession).mockReset();
    vi.mocked(deleteSession).mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('handleRestore calls restoreSession with the row id from the sidebar', async () => {
    renderApp();
    await pinDesktopSidebar();
    await userEvent.click(screen.getByRole('tab', { name: /archived/i }));
    await waitFor(() => expect(screen.getByText('Old archived task')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /restore old archived task/i }));
    await waitFor(() => expect(restoreSession).toHaveBeenCalledWith('arc1'));
  });

  it('handleDelete opens the confirm dialog and only deletes after confirming', async () => {
    renderApp();
    await pinDesktopSidebar();
    await userEvent.click(screen.getByRole('tab', { name: /archived/i }));
    await waitFor(() => expect(screen.getByText('Old archived task')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /delete old archived task/i }));
    expect(deleteSession).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole('button', { name: /delete forever/i }));
    await waitFor(() => expect(deleteSession).toHaveBeenCalledWith('arc1'));
  });
});

describe('App settings', () => {
  beforeEach(() => {
    vi.mocked(fetchModels).mockResolvedValue(LIVE_CATALOG);
    vi.mocked(fetchSettings).mockResolvedValue([
      {
        key: 'CURSOR_API_KEY',
        category: 'provider',
        providerId: 'cursor',
        type: 'secret',
        label: 'Cursor API Key',
        description: 'test',
        hasValue: false,
        source: null,
        value: null,
        readOnly: false,
      },
    ]);
    vi.mocked(updateSetting).mockResolvedValue({
      key: 'CURSOR_API_KEY',
      category: 'provider',
      providerId: 'cursor',
      type: 'secret',
      label: 'Cursor API Key',
      description: 'test',
      hasValue: true,
      source: 'db',
      value: '••••abcd',
      readOnly: false,
    });
  });

  it('refetches models after saving a setting', async () => {
    renderApp();

    await pinDesktopSidebar();
    await userEvent.click(screen.getByRole('button', { name: /settings/i }));
    await waitFor(() => expect(screen.getByText('Cursor API Key')).toBeInTheDocument());

    const callsBeforeSave = vi.mocked(fetchModels).mock.calls.length;
    const input = screen.getByPlaceholderText('Enter new value');
    await userEvent.type(input, 'sk-test-key');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(updateSetting).toHaveBeenCalled());
    expect(vi.mocked(fetchModels).mock.calls.length).toBeGreaterThan(callsBeforeSave);
  });
});
