import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HomeSurface } from './home-surface';

const noopSubmit = vi.fn().mockResolvedValue(undefined);

function renderSurface(props: Partial<ComponentProps<typeof HomeSurface>> = {}) {
  return render(
    <MemoryRouter>
      <HomeSurface sessionCount={0} providers={[]} onSubmit={noopSubmit} {...props} />
    </MemoryRouter>,
  );
}

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
  it('renders composer, digest and attention queue without a fleet section', async () => {
    renderSurface();

    expect(screen.getByRole('heading', { name: /^home$/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Ask Nuncio/i)).toBeInTheDocument();
    expect(await screen.findByText('Nothing needs you')).toBeInTheDocument();
    expect(screen.queryByText(/^fleet$/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open .*fleet/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new agent/i })).not.toBeInTheDocument();
  });

  it('focuses the composer when the focus key advances', async () => {
    const { rerender } = renderSurface({ composerFocusKey: 0 });
    const composer = screen.getByPlaceholderText(/Ask Nuncio/i);
    expect(composer).not.toHaveFocus();

    rerender(
      <MemoryRouter>
        <HomeSurface sessionCount={0} providers={[]} onSubmit={noopSubmit} composerFocusKey={1} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(composer).toHaveFocus());
  });
});
