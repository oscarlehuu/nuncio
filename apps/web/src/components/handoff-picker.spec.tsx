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
  fetchLocalCursorSessions: vi.fn(),
  handoffSession: vi.fn(),
  HandoffApiError: class HandoffApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

import { fetchLocalCursorSessions, handoffSession } from '../lib/handoff-api';
import { localDayKey } from '../lib/handoff-session-groups';

const mockSessions = [
  {
    chatId: 'chat-1',
    workspace: '/code/nuncio',
    projectSlug: 'code-nuncio',
    title: 'Fix login',
    preview: 'Continue the auth work',
    updatedAt: Date.now() - 60_000,
    messageCount: 5,
    alreadyImported: false,
  },
];

const importedSession = {
  ...mockSessions[0],
  chatId: 'chat-2',
  title: 'Already on Nuncio',
  alreadyImported: true,
  nuncioSessionId: 'sess-existing',
};

describe('HandoffPicker', () => {
  beforeEach(() => {
    vi.mocked(fetchLocalCursorSessions).mockResolvedValue(mockSessions);
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
      expect(fetchLocalCursorSessions).toHaveBeenCalledWith('/code/nuncio');
    });
    expect(screen.getByText('Fix login')).toBeInTheDocument();
  });

  it('imports the selected chat', async () => {
    const onImported = vi.fn();
    render(
      <HandoffPicker open onOpenChange={() => {}} onImported={onImported} />,
    );

    await userEvent.click(screen.getByRole('button', { name: /pick project|nuncio/i }));
    await waitFor(() => screen.getByText('Fix login'));

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

  it('shows Open for already-imported chats and skips handoff API', async () => {
    vi.mocked(fetchLocalCursorSessions).mockResolvedValue([importedSession]);
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
    vi.mocked(fetchLocalCursorSessions).mockResolvedValue([
      {
        ...mockSessions[0],
        chatId: 'today-1',
        title: 'Today chat',
        updatedAt: todayKey + 10 * 3_600_000,
      },
      {
        ...mockSessions[0],
        chatId: 'yesterday-1',
        title: 'Yesterday chat',
        updatedAt: todayKey - 14 * 3_600_000,
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
    vi.mocked(fetchLocalCursorSessions).mockResolvedValue([
      { ...mockSessions[0], chatId: 'a', title: 'Alpha task' },
      { ...mockSessions[0], chatId: 'b', title: 'Beta refactor' },
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
