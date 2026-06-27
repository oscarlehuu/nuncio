import { describe, it, expect, vi } from 'vitest';
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
    prompt: 'do the thing',
    preview: 'working on it',
    projectPath: null,
    baseBranch: null,
    worktreePath: null,
    branch: null,
    createdAt: Date.now() - 3_600_000,
    updatedAt: Date.now() - 120_000,
    ...overrides,
  };
}

describe('Sidebar', () => {
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

  it('shows the project name on the subtitle when projectPath is set', () => {
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
    expect(screen.getByText(/nuncio ·/i)).toBeInTheDocument();
  });
});
