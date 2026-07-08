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
      highlights: partial.highlights ?? [],
      projectLines: partial.projectLines ?? [],
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
        <Route path="/timeline" element={<div>timeline page</div>} />
        <Route path="/session/:id" element={<div>session page</div>} />
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

  it('renders digest highlights with deep-links and a full timeline entry point', async () => {
    vi.mocked(fetchDigest).mockResolvedValue(
      digest({
        highlights: [
          {
            id: 'session-completed:s1:10',
            ts: 10,
            kind: 'session-completed',
            title: 'Docs task completed',
            projectPath: '/Users/me/nuncio',
            provider: 'codex',
            sessionId: 's1',
          },
        ],
      }),
    );
    renderDigest();
    await waitFor(() => expect(screen.getByText('Highlights')).toBeInTheDocument());
    expect(screen.getByText('Docs task completed')).toBeInTheDocument();
    expect(screen.getByText('nuncio')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /open docs task completed/i }));
    expect(await screen.findByText('session page')).toBeInTheDocument();
  });

  it('renders digest project lines as quiet rows', async () => {
    vi.mocked(fetchDigest).mockResolvedValue(
      digest({
        projectLines: [
          { projectPath: '/Users/me/nuncio', title: 'nuncio: 2 tasks settled, 1 needs you' },
          { projectPath: null, title: 'Unscoped: no project activity' },
        ],
      }),
    );
    renderDigest();
    await waitFor(() => expect(screen.getByText('Project lines')).toBeInTheDocument());
    expect(screen.getByText('nuncio: 2 tasks settled, 1 needs you')).toBeInTheDocument();
    expect(screen.getByText('Unscoped: no project activity')).toBeInTheDocument();
  });

  it('tolerates absent highlight and project line sections', async () => {
    const legacy = digest();
    delete (legacy.digest as Partial<DigestRunDto['digest']>).highlights;
    delete (legacy.digest as Partial<DigestRunDto['digest']>).projectLines;
    vi.mocked(fetchDigest).mockResolvedValue(legacy);
    renderDigest();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Morning digest' })).toBeInTheDocument());
    expect(screen.queryByText('Highlights')).not.toBeInTheDocument();
    expect(screen.queryByText('Project lines')).not.toBeInTheDocument();
  });

  it('opens the full timeline from the digest', async () => {
    vi.mocked(fetchDigest).mockResolvedValue(digest());
    renderDigest();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Morning digest' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /see full timeline/i }));
    expect(await screen.findByText('timeline page')).toBeInTheDocument();
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
