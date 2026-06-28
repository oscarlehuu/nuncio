import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  createSession: vi.fn(),
  steerSession: vi.fn(),
  pauseSession: vi.fn(),
  archiveSession: vi.fn(),
  restoreSession: vi.fn(),
  deleteSession: vi.fn(),
  fetchModels: vi.fn(),
  fetchEvents: vi.fn().mockResolvedValue([]),
  statusLabel: (s: string) => s,
  relativeTime: () => 'now',
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
  fetchSessions,
  pauseSession,
  restoreSession,
  steerSession,
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
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

async function pinDesktopSidebar() {
  await userEvent.click(screen.getByTestId('desktop-nav-toggle'));
  await waitFor(() => expect(screen.getByTestId('desktop-sidebar-pinned')).toBeInTheDocument());
}

describe('App navigation', () => {
  it('opens the desktop flyout on hamburger hover and closes after pointer leave', async () => {
    render(
      <ThemeProvider defaultTheme="light">
        <App />
      </ThemeProvider>,
    );

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
    render(
      <ThemeProvider defaultTheme="light">
        <App />
      </ThemeProvider>,
    );

    await userEvent.click(screen.getByTestId('desktop-nav-toggle'));
    expect(screen.getByTestId('desktop-sidebar-pinned')).toBeInTheDocument();
    expect(screen.queryByTestId('desktop-sidebar-flyout')).not.toBeInTheDocument();
  });

  it('opens the mobile sidebar drawer via the menu button', async () => {
    render(
      <ThemeProvider defaultTheme="light">
        <App />
      </ThemeProvider>,
    );
    const menu = screen.getByRole('button', { name: /open navigation/i });
    await userEvent.click(menu);
    expect(await screen.findByText('Navigation')).toBeInTheDocument();
  });

  it('mobile drawer has no sheet close button and shows theme in footer', async () => {
    render(
      <ThemeProvider defaultTheme="light">
        <App />
      </ThemeProvider>,
    );
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

    render(
      <ThemeProvider defaultTheme="light">
        <App />
      </ThemeProvider>,
    );

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
    // App uses useSessionStream, which constructs an EventSource once a session
    // becomes active. jsdom has no EventSource, so stub a no-op one.
    vi.stubGlobal(
      'EventSource',
      class {
        onmessage: ((msg: { data: string }) => void) | null = null;
        close() {}
        constructor(_url: string) {}
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('handleCreate calls createSession with prompt + default model and refreshes', async () => {
    const session = fakeSession();
    vi.mocked(createSession).mockResolvedValue(session);
    vi.mocked(fetchSessions).mockResolvedValue([session]);

    render(
      <ThemeProvider defaultTheme="light">
        <App />
      </ThemeProvider>,
    );

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
    );
      expect(fetchSessions).toHaveBeenCalled();
  });
});

describe('App lifecycle', () => {
  const session = fakeSession({ id: 'new1', title: 'Build the thing', status: 'IDLE' });

  beforeEach(() => {
    vi.stubGlobal(
      'EventSource',
      class {
        onmessage: ((msg: { data: string }) => void) | null = null;
        close() {}
        constructor(_url: string) {}
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
    render(
      <ThemeProvider defaultTheme="light">
        <App />
      </ThemeProvider>,
    );
    await pinDesktopSidebar();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /open build the thing/i })).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('button', { name: /open build the thing/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /pause session/i })).toBeInTheDocument(),
    );
  }

  it('handlePause calls pauseSession with the active id', async () => {
    await openSession();
    await userEvent.click(screen.getByRole('button', { name: /pause session/i }));
    await waitFor(() => expect(pauseSession).toHaveBeenCalledWith('new1'));
  });

  it('handleArchive calls archiveSession with the active id', async () => {
    await openSession();
    await userEvent.click(screen.getByRole('button', { name: /archive session/i }));
    await waitFor(() => expect(archiveSession).toHaveBeenCalledWith('new1'));
  });

  it('sidebar hover-archive calls archiveSession with the row id (not the active id)', async () => {
    const other = fakeSession({ id: 'other1', title: 'Other task', status: 'IDLE' });
    vi.mocked(fetchSessions).mockResolvedValue([session, other]);
    render(
      <ThemeProvider defaultTheme="light">
        <App />
      </ThemeProvider>,
    );
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
    await waitFor(() => expect(steerSession).toHaveBeenCalledWith('new1', 'use the cache layer'));
  });
});

describe('App archived lifecycle', () => {
  const archived = fakeSession({
    id: 'arc1',
    title: 'Old archived task',
    status: 'ARCHIVED',
  });

  beforeEach(() => {
    vi.stubGlobal(
      'EventSource',
      class {
        onmessage: ((msg: { data: string }) => void) | null = null;
        close() {}
        constructor(_url: string) {}
      },
    );
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
    render(
      <ThemeProvider defaultTheme="light">
        <App />
      </ThemeProvider>,
    );
    await pinDesktopSidebar();
    await userEvent.click(screen.getByRole('tab', { name: /archived/i }));
    await waitFor(() => expect(screen.getByText('Old archived task')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /restore old archived task/i }));
    await waitFor(() => expect(restoreSession).toHaveBeenCalledWith('arc1'));
  });

  it('handleDelete opens the confirm dialog and only deletes after confirming', async () => {
    render(
      <ThemeProvider defaultTheme="light">
        <App />
      </ThemeProvider>,
    );
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
    render(
      <ThemeProvider defaultTheme="light">
        <App />
      </ThemeProvider>,
    );

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
