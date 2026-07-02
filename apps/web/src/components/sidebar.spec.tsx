import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from './theme-provider';
import { Sidebar } from './sidebar';
import type { Session } from '../lib/api';

function renderWithTheme(ui: ReactElement) {
  return render(<ThemeProvider defaultTheme="light">{ui}</ThemeProvider>);
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    title: 'Build feature X',
    status: 'IDLE',
    provider: 'pi',
    model: 'pi/fable-5',
    modelOptions: null,
    prompt: 'do the thing',
    preview: 'working on it',
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

describe('Sidebar', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders session titles', () => {
    const sessions = [
      makeSession({ id: 's1', title: 'Build feature X' }),
      makeSession({ id: 's2', title: 'Fix bug Y' }),
    ];
    renderWithTheme(
      <Sidebar sessions={sessions} activeId={null} onSelect={() => {}} onNew={() => {}} />,
    );
    expect(screen.getByText('Build feature X')).toBeInTheDocument();
    expect(screen.getByText('Fix bug Y')).toBeInTheDocument();
  });

  it('calls onNew when the New button is clicked', async () => {
    const onNew = vi.fn();
    renderWithTheme(<Sidebar sessions={[]} activeId={null} onSelect={() => {}} onNew={onNew} />);
    await userEvent.click(screen.getByRole('button', { name: /new agent/i }));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('renders New Agent as a flat nav row, not a boxed button', () => {
    renderWithTheme(<Sidebar sessions={[]} activeId={null} onSelect={() => {}} onNew={() => {}} />);
    const newAgent = screen.getByRole('button', { name: /new agent/i });
    // Nav row: transparent until hover, no filled/boxed background utility.
    expect(newAgent.className).not.toMatch(/bg-(primary|secondary)\b/);
    expect(newAgent.className).toMatch(/hover:bg-sidebar-accent/);
  });

  it('renders each recent row as a title plus a metadata line', () => {
    const sessions = [
      makeSession({
        id: 's1',
        title: 'Fix auth',
        provider: 'pi',
        preview: 'reading middleware',
        status: 'IDLE',
      }),
    ];
    renderWithTheme(
      <Sidebar sessions={sessions} activeId={null} onSelect={() => {}} onNew={() => {}} />,
    );
    // Line one: the title. Line two: the provider indicator + status/preview meta.
    const row = screen.getByRole('button', { name: /open fix auth/i });
    expect(row).toHaveTextContent('Fix auth');
    expect(row).toContainElement(screen.getByLabelText(/pi provider/i));
    expect(row).toHaveTextContent(/reading middleware/i);
  });

  it('calls onSelect with the session id when a row is clicked', async () => {
    const onSelect = vi.fn();
    const sessions = [makeSession({ id: 's1', title: 'Build feature X' })];
    renderWithTheme(<Sidebar sessions={sessions} activeId={null} onSelect={onSelect} onNew={() => {}} />);
    await userEvent.click(screen.getByText('Build feature X'));
    expect(onSelect).toHaveBeenCalledWith('s1');
  });

  it('shows an empty state when there are no sessions', () => {
    renderWithTheme(<Sidebar sessions={[]} activeId={null} onSelect={() => {}} onNew={() => {}} />);
    expect(screen.getByText(/no sessions yet/i)).toBeInTheDocument();
  });

  it('shows the project name on the group header when projectPath is set', () => {
    const sessions = [
      makeSession({
        id: 's1',
        title: 'Fix auth',
        projectPath: '/Users/dev/code/nuncio',
        preview: 'Reading middleware',
      }),
    ];
    renderWithTheme(
      <Sidebar sessions={sessions} activeId={null} onSelect={() => {}} onNew={() => {}} />,
    );
    expect(screen.getByText('nuncio')).toBeInTheDocument();
  });

  it('shows a provider indicator per session', () => {
    const sessions = [
      makeSession({ id: 's1', title: 'Pi task', provider: 'pi' }),
      makeSession({ id: 's2', title: 'Cursor task', provider: 'cursor' }),
    ];
    renderWithTheme(
      <Sidebar sessions={sessions} activeId={null} onSelect={() => {}} onNew={() => {}} />,
    );
    expect(screen.getByLabelText(/pi provider/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/cursor provider/i)).toBeInTheDocument();
  });

  it('falls back to the provider id initial when the provider is unknown', () => {
    const sessions = [makeSession({ id: 's1', title: 'Weird task', provider: 'zebra' })];
    renderWithTheme(
      <Sidebar sessions={sessions} activeId={null} onSelect={() => {}} onNew={() => {}} />,
    );
    expect(screen.getByLabelText(/zebra provider/i)).toBeInTheDocument();
  });

  it('calls onSettings when the settings button is clicked', async () => {
    const onSettings = vi.fn();
    renderWithTheme(
      <Sidebar sessions={[]} activeId={null} onSelect={() => {}} onNew={() => {}} onSettings={onSettings} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /settings/i }));
    expect(onSettings).toHaveBeenCalledTimes(1);
  });

  it('does not render the settings button when onSettings is omitted', () => {
    renderWithTheme(<Sidebar sessions={[]} activeId={null} onSelect={() => {}} onNew={() => {}} />);
    expect(screen.queryByRole('button', { name: /settings/i })).not.toBeInTheDocument();
  });

  it('renders settings and theme toggle in the footer', () => {
    const { container } = renderWithTheme(
      <Sidebar sessions={[]} activeId={null} onSelect={() => {}} onNew={() => {}} onSettings={() => {}} />,
    );
    const footer = container.querySelector('[data-sidebar-footer]');
    expect(footer).toBeInTheDocument();
    expect(footer).toContainElement(screen.getByRole('button', { name: /settings/i }));
    expect(footer).toContainElement(screen.getByRole('button', { name: /toggle theme/i }));
  });

  it('does not render header actions for settings or theme', () => {
    const { container } = renderWithTheme(
      <Sidebar sessions={[]} activeId={null} onSelect={() => {}} onNew={() => {}} onSettings={() => {}} />,
    );
    expect(container.querySelector('[data-sidebar-header-actions]')).not.toBeInTheDocument();
  });

  describe('recent row hover archive', () => {
    it('renders an archive button per recent row when onArchive is provided', () => {
      const sessions = [makeSession({ id: 's1', title: 'Build feature X' })];
      renderWithTheme(
        <Sidebar
          sessions={sessions}
          activeId={null}
          onSelect={() => {}}
          onNew={() => {}}
          onArchive={() => {}}
        />,
      );
      expect(screen.getByRole('button', { name: /archive build feature x/i })).toBeInTheDocument();
    });

    it('does not render the per-row archive button when onArchive is omitted', () => {
      const sessions = [makeSession({ id: 's1', title: 'Build feature X' })];
      renderWithTheme(
        <Sidebar sessions={sessions} activeId={null} onSelect={() => {}} onNew={() => {}} />,
      );
      expect(screen.queryByRole('button', { name: /archive build feature x/i })).not.toBeInTheDocument();
    });

    it('calls onArchive with the row id when the archive button is clicked', async () => {
      const onArchive = vi.fn();
      const sessions = [makeSession({ id: 's1', title: 'Build feature X' })];
      renderWithTheme(
        <Sidebar
          sessions={sessions}
          activeId={null}
          onSelect={() => {}}
          onNew={() => {}}
          onArchive={onArchive}
        />,
      );
      await userEvent.click(screen.getByRole('button', { name: /archive build feature x/i }));
      expect(onArchive).toHaveBeenCalledWith('s1');
    });

    it('clicking the archive button does not trigger onSelect', async () => {
      const onSelect = vi.fn();
      const onArchive = vi.fn();
      const sessions = [makeSession({ id: 's1', title: 'Build feature X' })];
      renderWithTheme(
        <Sidebar
          sessions={sessions}
          activeId={null}
          onSelect={onSelect}
          onNew={() => {}}
          onArchive={onArchive}
        />,
      );
      await userEvent.click(screen.getByRole('button', { name: /archive build feature x/i }));
      expect(onArchive).toHaveBeenCalledWith('s1');
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('hides the archive button for RUNNING sessions (FSM blocks archive)', () => {
      const sessions = [makeSession({ id: 's1', title: 'Running task', status: 'RUNNING' })];
      renderWithTheme(
        <Sidebar
          sessions={sessions}
          activeId={null}
          onSelect={() => {}}
          onNew={() => {}}
          onArchive={() => {}}
        />,
      );
      expect(screen.queryByRole('button', { name: /archive running task/i })).not.toBeInTheDocument();
    });

    it('hides the archive button for CREATED sessions (FSM blocks archive)', () => {
      const sessions = [makeSession({ id: 's1', title: 'Just created', status: 'CREATED' })];
      renderWithTheme(
        <Sidebar
          sessions={sessions}
          activeId={null}
          onSelect={() => {}}
          onNew={() => {}}
          onArchive={() => {}}
        />,
      );
      expect(screen.queryByRole('button', { name: /archive just created/i })).not.toBeInTheDocument();
    });

    it('shows the archive button for IDLE, PAUSED, and ERROR sessions', () => {
      const sessions = [
        makeSession({ id: 'idle', title: 'Idle task', status: 'IDLE' }),
        makeSession({ id: 'paused', title: 'Paused task', status: 'PAUSED' }),
        makeSession({ id: 'error', title: 'Error task', status: 'ERROR' }),
      ];
      renderWithTheme(
        <Sidebar
          sessions={sessions}
          activeId={null}
          onSelect={() => {}}
          onNew={() => {}}
          onArchive={() => {}}
        />,
      );
      expect(screen.getByRole('button', { name: /archive idle task/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /archive paused task/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /archive error task/i })).toBeInTheDocument();
    });
  });

  describe('recent project grouping', () => {
    beforeEach(() => {
      localStorage.clear();
    });

    it('renders a Chat group header for sessions with no projectPath', () => {
      const sessions = [makeSession({ id: 's1', title: 'Build feature X', projectPath: null })];
      renderWithTheme(
        <Sidebar sessions={sessions} activeId={null} onSelect={() => {}} onNew={() => {}} />,
      );
      expect(screen.getAllByText('Chat').length).toBeGreaterThan(0);
    });

    it('groups sessions under their project header with a session count', () => {
      const sessions = [
        makeSession({ id: 's1', title: 'Fix auth', projectPath: '/Users/dev/code/nuncio' }),
        makeSession({ id: 's2', title: 'Add tests', projectPath: '/Users/dev/code/nuncio' }),
        makeSession({ id: 's3', title: 'Random chat', projectPath: null }),
      ];
      renderWithTheme(
        <Sidebar sessions={sessions} activeId={null} onSelect={() => {}} onNew={() => {}} />,
      );
      expect(screen.getByText('nuncio')).toBeInTheDocument();
      expect(screen.getAllByText('Chat').length).toBeGreaterThan(0);
      expect(screen.getByText('Fix auth')).toBeInTheDocument();
      expect(screen.getByText('Add tests')).toBeInTheDocument();
      expect(screen.getByText('Random chat')).toBeInTheDocument();
    });

    it('collapses a group and hides its sessions when the header is clicked', async () => {
      const sessions = [
        makeSession({ id: 's1', title: 'Fix auth', projectPath: '/Users/dev/code/nuncio' }),
      ];
      renderWithTheme(
        <Sidebar sessions={sessions} activeId={null} onSelect={() => {}} onNew={() => {}} />,
      );
      expect(screen.getByText('Fix auth')).toBeInTheDocument();
      await userEvent.click(screen.getByText('nuncio'));
      expect(screen.queryByText('Fix auth')).not.toBeInTheDocument();
      await userEvent.click(screen.getByText('nuncio'));
      expect(screen.getByText('Fix auth')).toBeInTheDocument();
    });

    it('renders a PROJECTS divider only when there are project-backed sessions', () => {
      const sessions = [
        makeSession({ id: 's1', title: 'Fix auth', projectPath: '/Users/dev/code/nuncio' }),
      ];
      renderWithTheme(
        <Sidebar sessions={sessions} activeId={null} onSelect={() => {}} onNew={() => {}} />,
      );
      expect(screen.getByTestId('recent-divider-projects')).toBeInTheDocument();
      expect(screen.queryByTestId('recent-divider-chat')).not.toBeInTheDocument();
    });

    it('renders a CHAT divider only when there are project-less sessions', () => {
      const sessions = [makeSession({ id: 's1', title: 'Random chat', projectPath: null })];
      renderWithTheme(
        <Sidebar sessions={sessions} activeId={null} onSelect={() => {}} onNew={() => {}} />,
      );
      expect(screen.getByTestId('recent-divider-chat')).toBeInTheDocument();
      expect(screen.queryByTestId('recent-divider-projects')).not.toBeInTheDocument();
    });

    it('always renders the Chat section last, after all project sections', () => {
      const sessions = [
        makeSession({ id: 's1', title: 'Chat only', projectPath: null, updatedAt: Date.now() }),
        makeSession({
          id: 's2',
          title: 'Older project work',
          projectPath: '/Users/dev/code/nuncio',
          updatedAt: Date.now() - 1_000_000,
        }),
      ];
      renderWithTheme(
        <Sidebar sessions={sessions} activeId={null} onSelect={() => {}} onNew={() => {}} />,
      );
      const projectsDivider = screen.getByTestId('recent-divider-projects');
      const chatDivider = screen.getByTestId('recent-divider-chat');
      expect(
        projectsDivider.compareDocumentPosition(chatDivider) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it('shows a FolderGit2 icon on project group headers and a MessageSquare icon on the Chat header', () => {
      const sessions = [
        makeSession({ id: 's1', title: 'Fix auth', projectPath: '/Users/dev/code/nuncio' }),
        makeSession({ id: 's2', title: 'Random chat', projectPath: null }),
      ];
      const { container } = renderWithTheme(
        <Sidebar sessions={sessions} activeId={null} onSelect={() => {}} onNew={() => {}} />,
      );
      expect(container.querySelector('.lucide-folder-git-2')).toBeInTheDocument();
      expect(container.querySelector('.lucide-message-square')).toBeInTheDocument();
    });

    it('renders chat sessions directly under the CHAT divider without a collapsible wrapper', () => {
      const sessions = [makeSession({ id: 's1', title: 'Random chat', projectPath: null })];
      renderWithTheme(
        <Sidebar sessions={sessions} activeId={null} onSelect={() => {}} onNew={() => {}} />,
      );
      expect(screen.getByText('Random chat')).toBeInTheDocument();
      const chatHeaders = screen.getAllByText('Chat');
      expect(chatHeaders.every((el) => !el.closest('button'))).toBe(true);
    });
  });

  describe('archived view', () => {
    it('renders a Recent | Archived tab control', () => {
      renderWithTheme(
        <Sidebar sessions={[]} archivedSessions={[]} activeId={null} onSelect={() => {}} onNew={() => {}} />,
      );
      expect(screen.getByRole('tab', { name: /recent/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /archived/i })).toBeInTheDocument();
    });

    it('shows recent sessions by default and hides the archived list', () => {
      const sessions = [makeSession({ id: 'r1', title: 'Recent task' })];
      const archived = [makeSession({ id: 'a1', title: 'Old task', status: 'ARCHIVED' })];
      renderWithTheme(
        <Sidebar
          sessions={sessions}
          archivedSessions={archived}
          activeId={null}
          onSelect={() => {}}
          onNew={() => {}}
        />,
      );
      expect(screen.getByText('Recent task')).toBeInTheDocument();
      expect(screen.queryByText('Old task')).not.toBeInTheDocument();
    });

    it('switches to the archived view when the Archived tab is clicked', async () => {
      const sessions = [makeSession({ id: 'r1', title: 'Recent task' })];
      const archived = [makeSession({ id: 'a1', title: 'Old task', status: 'ARCHIVED' })];
      renderWithTheme(
        <Sidebar
          sessions={sessions}
          archivedSessions={archived}
          activeId={null}
          onSelect={() => {}}
          onNew={() => {}}
        />,
      );
      await userEvent.click(screen.getByRole('tab', { name: /archived/i }));
      expect(screen.getByText('Old task')).toBeInTheDocument();
      expect(screen.queryByText('Recent task')).not.toBeInTheDocument();
    });

    it('shows an archived-specific empty state when there are no archived sessions', async () => {
      renderWithTheme(
        <Sidebar sessions={[]} archivedSessions={[]} activeId={null} onSelect={() => {}} onNew={() => {}} />,
      );
      await userEvent.click(screen.getByRole('tab', { name: /archived/i }));
      expect(screen.getByText(/no archived sessions/i)).toBeInTheDocument();
    });

    it('renders a search box only in the archived view', async () => {
      renderWithTheme(
        <Sidebar sessions={[]} archivedSessions={[]} activeId={null} onSelect={() => {}} onNew={() => {}} />,
      );
      expect(screen.queryByPlaceholderText(/search archived/i)).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('tab', { name: /archived/i }));
      expect(screen.getByPlaceholderText(/search archived/i)).toBeInTheDocument();
    });

    it('filters archived sessions by title and prompt', async () => {
      const archived = [
        makeSession({ id: 'a1', title: 'Fix auth', prompt: 'login broken', status: 'ARCHIVED' }),
        makeSession({ id: 'a2', title: 'Refactor DB', prompt: 'split repositories', status: 'ARCHIVED' }),
      ];
      renderWithTheme(
        <Sidebar
          sessions={[]}
          archivedSessions={archived}
          activeId={null}
          onSelect={() => {}}
          onNew={() => {}}
        />,
      );
      await userEvent.click(screen.getByRole('tab', { name: /archived/i }));
      await userEvent.type(screen.getByPlaceholderText(/search archived/i), 'auth');
      expect(screen.getByText('Fix auth')).toBeInTheDocument();
      expect(screen.queryByText('Refactor DB')).not.toBeInTheDocument();
    });

    it('renders a per-row Restore button that calls onRestore', async () => {
      const onRestore = vi.fn();
      const archived = [makeSession({ id: 'a1', title: 'Old task', status: 'ARCHIVED' })];
      renderWithTheme(
        <Sidebar
          sessions={[]}
          archivedSessions={archived}
          activeId={null}
          onSelect={() => {}}
          onNew={() => {}}
          onRestore={onRestore}
        />,
      );
      await userEvent.click(screen.getByRole('tab', { name: /archived/i }));
      await userEvent.click(screen.getByRole('button', { name: /restore old task/i }));
      expect(onRestore).toHaveBeenCalledWith('a1');
    });

    it('opens a confirm dialog and calls onDelete only after confirming', async () => {
      const onDelete = vi.fn();
      const archived = [makeSession({ id: 'a1', title: 'Old task', status: 'ARCHIVED' })];
      renderWithTheme(
        <Sidebar
          sessions={[]}
          archivedSessions={archived}
          activeId={null}
          onSelect={() => {}}
          onNew={() => {}}
          onDelete={onDelete}
        />,
      );
      await userEvent.click(screen.getByRole('tab', { name: /archived/i }));
      await userEvent.click(screen.getByRole('button', { name: /delete old task/i }));
      // Confirm dialog opens; delete should not have fired yet
      expect(onDelete).not.toHaveBeenCalled();
      expect(await screen.findByRole('heading', { name: /delete session/i })).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: /delete forever/i }));
      expect(onDelete).toHaveBeenCalledWith('a1');
    });

    it('cancel in the confirm dialog does not delete', async () => {
      const onDelete = vi.fn();
      const archived = [makeSession({ id: 'a1', title: 'Old task', status: 'ARCHIVED' })];
      renderWithTheme(
        <Sidebar
          sessions={[]}
          archivedSessions={archived}
          activeId={null}
          onSelect={() => {}}
          onNew={() => {}}
          onDelete={onDelete}
        />,
      );
      await userEvent.click(screen.getByRole('tab', { name: /archived/i }));
      await userEvent.click(screen.getByRole('button', { name: /delete old task/i }));
      await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
      expect(onDelete).not.toHaveBeenCalled();
    });
  });
});
