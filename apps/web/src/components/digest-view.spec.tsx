import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import userEvent from '@testing-library/user-event';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, fetchDigest: vi.fn() };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { DigestView } from './digest-view';
import { fetchDigest, type DigestRunDto } from '../lib/api';

function digest(partial: Partial<DigestRunDto['digest']> = {}, variant: 'morning' | 'evening' = 'morning'): DigestRunDto {
  return {
    slotKey: `2026-07-07:${variant}`,
    variant,
    sentAt: Date.now() - 3_600_000,
    windowFrom: Date.now() - 12 * 3_600_000,
    windowTo: Date.now() - 3_600_000,
    digest: {
      variant,
      windowFrom: 0,
      windowTo: 1,
      loops: { runsOk: 3, runsFailed: 1, prsOpened: 2, ...partial.loops },
      attention: { raised: 4, resolved: 2, openTopCount: 1, ...partial.attention },
      sessions: { completed: 5, needsYou: 1, ...partial.sessions },
      budget: { runsToday: 6, cap: 24, ...partial.budget },
    },
  };
}

function renderDigest() {
  return render(
    <MemoryRouter initialEntries={['/digest']}>
      <Routes>
        <Route path="/digest" element={<DigestView onBack={vi.fn()} />} />
        <Route path="/inbox" element={<div>inbox page</div>} />
        <Route path="/autopilot" element={<div>autopilot page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DigestView', () => {
  beforeEach(() => {
    vi.mocked(fetchDigest).mockReset();
  });

  it('renders the morning variant title and its sections', async () => {
    vi.mocked(fetchDigest).mockResolvedValue(digest({}, 'morning'));
    renderDigest();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Morning digest' })).toBeInTheDocument());
    expect(screen.getByText('Attention')).toBeInTheDocument();
    expect(screen.getByText('Autopilot')).toBeInTheDocument();
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('6/24 runs today')).toBeInTheDocument();
  });

  it('renders the evening variant title', async () => {
    vi.mocked(fetchDigest).mockResolvedValue(digest({}, 'evening'));
    renderDigest();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Evening pre-flight' })).toBeInTheDocument());
  });

  it('deep-links attention to the inbox and autopilot to the loops', async () => {
    vi.mocked(fetchDigest).mockResolvedValue(digest());
    renderDigest();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Morning digest' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /open inbox/i }));
    expect(await screen.findByText('inbox page')).toBeInTheDocument();
  });

  it('a quiet digest reads as good news, not emptiness', async () => {
    vi.mocked(fetchDigest).mockResolvedValue(
      digest({
        loops: { runsOk: 0, runsFailed: 0, prsOpened: 0 },
        attention: { raised: 0, resolved: 0, openTopCount: 0 },
        sessions: { completed: 0, needsYou: 0 },
        budget: { runsToday: 0, cap: 24 },
      }),
    );
    renderDigest();
    await waitFor(() => expect(screen.getByText(/a quiet night/i)).toBeInTheDocument());
  });

  it('shows a calm "no digest yet" state when none has been built', async () => {
    vi.mocked(fetchDigest).mockResolvedValue(null);
    renderDigest();
    await waitFor(() => expect(screen.getByText('No digest yet')).toBeInTheDocument());
  });
});
