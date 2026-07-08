import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { HomeSurface } from './home-surface';

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('../lib/api', () => ({
  fetchDigest: vi.fn().mockResolvedValue(null),
  fetchAttention: vi.fn().mockResolvedValue({
    items: [],
    counts: { total: 0, unacked: 0, bySeverity: {} },
  }),
  ackAttentionItem: vi.fn(),
  approveDispatcherProposal: vi.fn(),
  resolveAttentionItem: vi.fn(),
  relativeTime: () => 'now',
}));

describe('HomeSurface', () => {
  it('renders digest and attention queue without a fleet section', async () => {
    render(
      <MemoryRouter>
        <HomeSurface onNew={vi.fn()} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: /^home$/i })).toBeInTheDocument();
    expect(await screen.findByText('Nothing needs you')).toBeInTheDocument();
    expect(screen.queryByText(/^fleet$/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open .*fleet/i })).not.toBeInTheDocument();
  });

  it('keeps the new-agent action in the Home header', async () => {
    const onNew = vi.fn();
    render(
      <MemoryRouter>
        <HomeSurface onNew={onNew} />
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByRole('button', { name: /new agent/i }));
    await waitFor(() => expect(onNew).toHaveBeenCalledTimes(1));
  });
});
