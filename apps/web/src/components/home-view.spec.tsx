import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HomeView } from './home-view';

vi.mock('../lib/api', () => ({
  fetchModels: vi.fn().mockResolvedValue([]),
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
});
