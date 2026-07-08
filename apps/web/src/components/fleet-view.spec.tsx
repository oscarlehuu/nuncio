import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import userEvent from '@testing-library/user-event';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, fetchFleet: vi.fn() };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { FleetView } from './fleet-view';
import { fetchFleet, type FleetRow } from '../lib/api';

function row(partial: Partial<FleetRow>): FleetRow {
  return {
    path: partial.path ?? '/Users/me/nuncio',
    name: partial.name ?? 'nuncio',
    weight: partial.weight ?? 1,
    health: partial.health ?? 'green',
    reasons: partial.reasons ?? [],
    topItem: partial.topItem ?? null,
    counts: {
      openAttention: 0,
      runningSessions: 0,
      activeLoops: 0,
      openPRs: 0,
      ...partial.counts,
    },
    lastActivityAt: partial.lastActivityAt ?? null,
  };
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

function renderFleet(onNew = vi.fn()) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<><FleetView onNew={onNew} /><LocationProbe /></>} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('FleetView', () => {
  beforeEach(() => {
    vi.mocked(fetchFleet).mockReset();
  });

  it('shows the warm empty state when no projects exist', async () => {
    vi.mocked(fetchFleet).mockResolvedValue([]);
    renderFleet();
    await waitFor(() => expect(screen.getByText('Your fleet is empty')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /start your first agent/i })).toBeInTheDocument();
  });

  it('renders rows in the order the server returned (red first, no re-sort)', async () => {
    vi.mocked(fetchFleet).mockResolvedValue([
      row({ path: '/a', name: 'alpha', health: 'red', reasons: ['1 need you'] }),
      row({ path: '/b', name: 'bravo', health: 'green' }),
    ]);
    renderFleet();
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
    const names = screen.getAllByText(/alpha|bravo/).map((n) => n.textContent);
    expect(names).toEqual(['alpha', 'bravo']);
  });

  it('shows the top item title as the summary line', async () => {
    vi.mocked(fetchFleet).mockResolvedValue([
      row({
        name: 'nuncio',
        health: 'red',
        reasons: ['1 need you'],
        topItem: {
          id: 'i1', kind: 'permission', subjectId: 's1', projectPath: '/Users/me/nuncio',
          severity: 5, title: 'Agent needs approval', payload: { sessionId: 's1' },
          status: 'open', acknowledgedAt: null, createdAt: 0, updatedAt: 0, resolvedAt: null,
        },
      }),
    ]);
    renderFleet();
    await waitFor(() => expect(screen.getByText('Agent needs approval')).toBeInTheDocument());
  });

  it('taps a row through to the project-scoped workbench', async () => {
    vi.mocked(fetchFleet).mockResolvedValue([row({ path: '/Users/me/nuncio', name: 'nuncio' })]);
    renderFleet();
    await waitFor(() => expect(screen.getByText('nuncio')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Open nuncio' }));
    expect(screen.getByTestId('loc').textContent).toBe('/grid?project=%2FUsers%2Fme%2Fnuncio');
  });

  it('a red row surfaces the top item Open action, deep-linking to the subject', async () => {
    vi.mocked(fetchFleet).mockResolvedValue([
      row({
        name: 'nuncio',
        health: 'red',
        reasons: ['1 need you'],
        topItem: {
          id: 'i1', kind: 'tripped-breaker', subjectId: 'loop-9', projectPath: '/Users/me/nuncio',
          severity: 4, title: 'Loop paused', payload: { loopId: 'loop-9' },
          status: 'open', acknowledgedAt: null, createdAt: 0, updatedAt: 0, resolvedAt: null,
        },
      }),
    ]);
    renderFleet();
    await waitFor(() => expect(screen.getByText('Loop paused')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Open Loop paused' }));
    expect(screen.getByTestId('loc').textContent).toBe('/autopilot/loop-9');
  });

  it('New agent triggers onNew (the composer moved off home)', async () => {
    vi.mocked(fetchFleet).mockResolvedValue([row({})]);
    const onNew = vi.fn();
    renderFleet(onNew);
    await waitFor(() => expect(screen.getByText('nuncio')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /new agent/i }));
    expect(onNew).toHaveBeenCalled();
  });
});
