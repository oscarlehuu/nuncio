import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HomeView } from './home-view';

vi.mock('../lib/api', () => ({
  fetchModels: vi.fn().mockResolvedValue([]),
}));

vi.mock('./project-picker', () => ({
  ProjectPicker: ({ onChange }: { onChange: (path: string) => void }) => (
    <button type="button" onClick={() => onChange('/code/nuncio')}>
      Pick project
    </button>
  ),
}));

vi.mock('./branch-picker', () => ({
  BranchPicker: ({ onChange }: { onChange: (branch: string) => void }) => (
    <button type="button" onClick={() => onChange('main')}>
      Pick branch
    </button>
  ),
}));

describe('HomeView', () => {
  it('submits the prompt via the send button', async () => {
    const onSubmit = vi.fn();
    render(<HomeView sessionCount={0} onSubmit={onSubmit} />);
    const textarea = screen.getByPlaceholderText(/ask nuncio/i);
    await userEvent.type(textarea, 'Build a login page');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toBe('Build a login page');
  });

  it('send button is disabled when the prompt is empty', () => {
    const onSubmit = vi.fn();
    render(<HomeView sessionCount={0} onSubmit={onSubmit} />);
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });

  it('submits on Enter (without shift) and not on Shift+Enter', async () => {
    const onSubmit = vi.fn();
    render(<HomeView sessionCount={0} onSubmit={onSubmit} />);
    const textarea = screen.getByPlaceholderText(/ask nuncio/i);
    await userEvent.type(textarea, 'Fix the bug');
    await userEvent.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await userEvent.type(textarea, 'more');
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('shows the session count badge', () => {
    render(<HomeView sessionCount={3} onSubmit={vi.fn()} />);
    expect(screen.getByText(/3 sessions/i)).toBeInTheDocument();
  });

  it('shows a connected badge per available provider', () => {
    const providers = [
      { id: 'pi', name: 'Pi', groups: [] },
      { id: 'cursor', name: 'Cursor', groups: [] },
      { id: 'anthropic-direct', name: 'Anthropic', unavailable: true, groups: [] },
    ];
    render(<HomeView sessionCount={0} onSubmit={vi.fn()} providers={providers} />);
    expect(screen.getByText(/pi connected/i)).toBeInTheDocument();
    expect(screen.getByText(/cursor connected/i)).toBeInTheDocument();
    expect(screen.queryByText(/anthropic connected/i)).toBeNull();
  });

  it('stacks textarea above a single-row scrolling picker toolbar', () => {
    const { container } = render(<HomeView sessionCount={0} onSubmit={vi.fn()} />);
    const card = container.querySelector('.home-composer');
    const bar = container.querySelector('.home-composer-bar');
    const pickers = container.querySelector('.home-composer-pickers');

    expect(card).toHaveClass('flex', 'flex-col');
    expect(bar).toHaveClass('border-t');
    expect(pickers).toBeTruthy();
    expect(pickers).toHaveClass('overflow-x-auto');
    expect(pickers).not.toHaveClass('flex-wrap');
  });

  it('forwards project and branch selections on submit', async () => {
    const onSubmit = vi.fn();
    render(<HomeView sessionCount={0} onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole('button', { name: /pick project/i }));
    await userEvent.click(screen.getByRole('button', { name: /pick branch/i }));
    await userEvent.type(screen.getByPlaceholderText(/ask nuncio/i), 'Add workspace');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(onSubmit).toHaveBeenCalledWith('Add workspace', expect.any(String), 'cursor', '/code/nuncio', 'main');
  });
});
