import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HandoffPicker } from './handoff-picker';

vi.mock('./project-picker', () => ({
  ProjectPicker: ({ value, onChange }: { value?: string; onChange: (path: string) => void }) => (
    <button type="button" onClick={() => onChange('/code/nuncio')}>
      {value ? value.split('/').pop() : 'Pick project'}
    </button>
  ),
}));

vi.mock('../lib/handoff-api', () => ({
  fetchAllLocalSessions: vi.fn(),
  handoffSession: vi.fn(),
  HandoffApiError: class HandoffApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

import { fetchAllLocalSessions, handoffSession } from '../lib/handoff-api';
import { localDayKey } from '../lib/handoff-session-groups';

const mockCursorSession = {
  source: 'cursor' as const,
  key: 'cursor:chat-1',
  title: 'Fix login',
  preview: 'Continue the auth work',
  updatedAt: Date.now() - 60_000,
  messageCount: 5,
  alreadyImported: false,
  workspace: '/code/nuncio',
  cursorChatId: 'chat-1',
};

const mockPiSession = {
  source: 'pi' as const,
  key: 'pi:/path/to/pi-session',
  title: 'Refactor DB',
  preview: 'Database refactoring work',
  updatedAt: Date.now() - 120_000,
  messageCount: 3,
  alreadyImported: false,
  workspace: '/code/nuncio',
  piSessionPath: '/path/to/pi-session',
};

const importedSession = {
  ...mockCursorSession,
  key: 'cursor:chat-2',
  title: 'Already on Nuncio',
  alreadyImported: true,
  nuncioSessionId: 'sess-existing',
  cursorChatId: 'chat-2',
};

describe('HandoffPicker', () => {
  beforeEach(() => {
    vi.mocked(fetchAllLocalSessions).mockResolvedValue([mockCursorSession, mockPiSession]);
    vi.mocked(handoffSession).mockReset();
    vi.mocked(handoffSession).mockResolvedValue({ id: 'imported-1' } as never);
  });

  it('loads sessions when opened with a workspace', async () => {
    const onImported = vi.fn();
    render(
      <HandoffPicker open onOpenChange={() => {}} onImported={onImported} />,
    );

    await userEvent.click(screen.getByRole('button', { name: /pick project|nuncio/i }));

    await waitFor(() => {
      expect(fetchAllLocalSessions).toHaveBeenCalledWith('/code/nuncio');
    });
    expect(screen.getByText('Fix login')).toBeInTheDocument();
    expect(screen.getByText('Refactor DB')).toBeInTheDocument();
  });

  it('imports the selected cursor chat', async () => {
    const onImported = vi.fn();
    render(
      <HandoffPicker open onOpenChange={() => {}} onImported={onImported} />,
    );

    await userEvent.click(screen.getByRole('button', { name: /pick project|nuncio/i }));
    await waitFor(() => screen.getByText('Fix login'));

    // Select the cursor chat (default selected is first item, which is 'Fix login')
    await userEvent.click(screen.getByRole('button', { name: /^import$/i }));

    await waitFor(() => {
      expect(handoffSession).toHaveBeenCalledWith({
        cursorChatId: 'chat-1',
        workspace: '/code/nuncio',
        title: 'Fix login',
      });
      expect(onImported).toHaveBeenCalledWith('imported-1');
    });
  });

  it('imports the selected pi session', async () => {
    const onImported = vi.fn();
    render(
      <HandoffPicker open onOpenChange={() => {}} onImported={onImported} />,
    );

    await userEvent.click(screen.getByRole('button', { name: /pick project|nuncio/i }));
    await waitFor(() => screen.getByText('Refactor DB'));

    // Click to select the Pi row
    await userEvent.click(screen.getByText('Refactor DB'));
    await userEvent.click(screen.getByRole('button', { name: /^import$/i }));

    await waitFor(() => {
      expect(handoffSession).toHaveBeenCalledWith({
        piSessionPath: '/path/to/pi-session',
        workspace: '/code/nuncio',
        title: 'Refactor DB',
      });
      expect(onImported).toHaveBeenCalledWith('imported-1');
    });
  });

  it('shows Open for already-imported chats and skips handoff API', async () => {
    vi.mocked(fetchAllLocalSessions).mockResolvedValue([importedSession]);
    const onImported = vi.fn();
    render(
      <HandoffPicker open onOpenChange={() => {}} onImported={onImported} />,
    );

    await userEvent.click(screen.getByRole('button', { name: /pick project|nuncio/i }));
    await waitFor(() => screen.getByText('Already on Nuncio'));
    expect(screen.getByText('On Nuncio')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^open$/i }));

    await waitFor(() => {
      expect(handoffSession).not.toHaveBeenCalled();
      expect(onImported).toHaveBeenCalledWith('sess-existing');
    });
  });

  it('groups sessions by day label in the list', async () => {
    const todayKey = localDayKey(Date.now());
    vi.mocked(fetchAllLocalSessions).mockResolvedValue([
      {
        ...mockCursorSession,
        key: 'cursor:today-1',
        title: 'Today chat',
        updatedAt: todayKey + 10 * 3_600_000,
        cursorChatId: 'today-1',
      },
      {
        ...mockCursorSession,
        key: 'cursor:yesterday-1',
        title: 'Yesterday chat',
        updatedAt: todayKey - 14 * 3_600_000,
        cursorChatId: 'yesterday-1',
      },
    ]);

    render(
      <HandoffPicker open onOpenChange={() => {}} onImported={vi.fn()} />,
    );

    await userEvent.click(screen.getByRole('button', { name: /pick project|nuncio/i }));

    await waitFor(() => {
      expect(screen.getByText('Today')).toBeInTheDocument();
      expect(screen.getByText('Yesterday')).toBeInTheDocument();
      expect(screen.getByText('Today chat')).toBeInTheDocument();
      expect(screen.getByText('Yesterday chat')).toBeInTheDocument();
    });
  });

  it('filters sessions by search query', async () => {
    vi.mocked(fetchAllLocalSessions).mockResolvedValue([
      { ...mockCursorSession, key: 'a', title: 'Alpha task' },
      { ...mockCursorSession, key: 'b', title: 'Beta refactor' },
    ]);

    render(
      <HandoffPicker open onOpenChange={() => {}} onImported={vi.fn()} />,
    );

    await userEvent.click(screen.getByRole('button', { name: /pick project|nuncio/i }));
    await waitFor(() => screen.getByText('Alpha task'));

    await userEvent.type(screen.getByRole('textbox', { name: /search chats/i }), 'beta');

    expect(screen.queryByText('Alpha task')).not.toBeInTheDocument();
    expect(screen.getByText('Beta refactor')).toBeInTheDocument();
  });
});
