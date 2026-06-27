import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from './components/theme-provider';

vi.mock('./lib/api', () => ({
  fetchSessions: vi.fn().mockResolvedValue([]),
  createSession: vi.fn(),
  steerSession: vi.fn(),
  pauseSession: vi.fn(),
  archiveSession: vi.fn(),
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

import App from './App';
import {
  archiveSession,
  createSession,
  fetchModels,
  fetchSessions,
  pauseSession,
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
    prompt: 'build the thing',
    preview: null,
    projectPath: null,
    baseBranch: null,
    worktreePath: null,
    branch: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe('App navigation', () => {
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
    await userEvent.type(textarea, 'build the thing');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^send$/i })).not.toBeDisabled(),
    );
    await userEvent.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => expect(createSession).toHaveBeenCalled());
    expect(createSession).toHaveBeenCalledWith(
      'build the thing',
      'cursor:composer-2.5',
      'cursor',
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
    await waitFor(() => expect(screen.getByText('Build the thing')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Build the thing'));
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

  it('handleSteer calls steerSession with the active id and message', async () => {
    await openSession();
    const textarea = screen.getByPlaceholderText(/steer the agent/i);
    await userEvent.type(textarea, 'use the cache layer');
    await userEvent.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() => expect(steerSession).toHaveBeenCalledWith('new1', 'use the cache layer'));
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
