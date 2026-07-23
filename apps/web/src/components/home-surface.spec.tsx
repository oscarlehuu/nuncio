import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { HomeSurface } from './home-surface';
import { fetchDigest, type DigestRunDto } from '../lib/api';

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
  beforeEach(() => {
    vi.mocked(fetchDigest).mockReset().mockResolvedValue(null);
  });

  it('renders composer, digest and attention queue without a fleet section', async () => {
    renderSurface();

    expect(screen.getByRole('heading', { name: /^home$/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Ask Nuncio/i)).toBeInTheDocument();
    expect(await screen.findByText('Nothing needs you')).toBeInTheDocument();
    expect(screen.queryByText(/^fleet$/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open .*fleet/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new agent/i })).not.toBeInTheDocument();
  });

  it('renders the latest digest as one non-interactive narrative line', async () => {
    vi.mocked(fetchDigest).mockResolvedValue(digest({
      variant: 'morning',
      loops: { runsOk: 5, runsFailed: 1, prsOpened: 2 },
      attention: { raised: 0, resolved: 0, openTopCount: 2 },
      sessions: { completed: 5, needsYou: 1 },
    }));
    renderSurface();

    const line = await screen.findByText('Overnight: 6 runs, 5 green, 2 PRs opened — 3 things need you.');
    expect(line.closest('button, a')).toBeNull();
  });

  it('keeps Timeline reachable from Home and navigates to it', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route
            path="/"
            element={<HomeSurface sessionCount={0} providers={[]} onSubmit={noopSubmit} />}
          />
          <Route path="/timeline" element={<div>timeline-page</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByRole('link', { name: 'Timeline' }));
    expect(await screen.findByText('timeline-page')).toBeInTheDocument();
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

function digest(overrides: Partial<DigestRunDto['digest']>): DigestRunDto {
  return {
    slotKey: '2026-07-23:morning',
    variant: overrides.variant ?? 'morning',
    sentAt: 1,
    windowFrom: 0,
    windowTo: 1,
    digest: {
      variant: overrides.variant ?? 'morning',
      windowFrom: 0,
      windowTo: 1,
      loops: overrides.loops ?? { runsOk: 0, runsFailed: 0, prsOpened: 0 },
      attention: overrides.attention ?? { raised: 0, resolved: 0, openTopCount: 0 },
      sessions: overrides.sessions ?? { completed: 0, needsYou: 0 },
      budget: { runsToday: 0, cap: 24 },
      highlights: [],
      projectLines: [],
    },
  };
}
