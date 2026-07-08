import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import userEvent from '@testing-library/user-event';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, fetchTimeline: vi.fn() };
});
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

import { TimelineView } from './timeline-view';
import { fetchTimeline, type TimelineEntryDto } from '../lib/api';

function entry(partial: Partial<TimelineEntryDto>): TimelineEntryDto {
  return {
    id: partial.id ?? 'session-completed:s1:10',
    ts: partial.ts ?? 10,
    at: partial.at ?? partial.ts ?? 10,
    kind: partial.kind ?? 'session-completed',
    title: partial.title ?? 'Session completed',
    projectPath: partial.projectPath ?? '/Users/me/nuncio',
    provider: partial.provider ?? 'codex',
    ...partial,
  };
}

function renderTimeline() {
  return render(
    <MemoryRouter initialEntries={['/timeline']}>
      <Routes>
        <Route path="/timeline" element={<TimelineView onBack={vi.fn()} />} />
        <Route path="/session/:id" element={<div>session page</div>} />
        <Route path="/autopilot/:id" element={<div>loop page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TimelineView', () => {
  beforeEach(() => {
    vi.mocked(fetchTimeline).mockReset();
  });

  it('renders entries in API order with compact kind glyphs', async () => {
    vi.mocked(fetchTimeline).mockResolvedValue({
      entries: [
        entry({ id: 'a', ts: 20, kind: 'attention-raised', title: 'Needs review' }),
        entry({ id: 'b', ts: 20, kind: 'session-completed', title: 'Task finished' }),
      ],
      nextBefore: null,
    });
    renderTimeline();
    await waitFor(() => expect(screen.getByText('Needs review')).toBeInTheDocument());
    expect(screen.getByLabelText('attention-raised')).toBeInTheDocument();
    expect(screen.getByLabelText('session-completed')).toBeInTheDocument();
    const titles = screen.getAllByText(/Needs review|Task finished/).map((n) => n.textContent);
    expect(titles).toEqual(['Needs review', 'Task finished']);
  });

  it('loads more with the tie-aware cursor from the server', async () => {
    vi.mocked(fetchTimeline)
      .mockResolvedValueOnce({ entries: [entry({ id: 'a', ts: 20, title: 'First page' })], nextBefore: 20 })
      .mockResolvedValueOnce({ entries: [entry({ id: 'b', ts: 20, title: 'Second page' })], nextBefore: null });
    renderTimeline();
    await waitFor(() => expect(screen.getByText('First page')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /load more/i }));
    expect(fetchTimeline).toHaveBeenLastCalledWith(expect.objectContaining({ before: 20 }));
    expect(await screen.findByText('Second page')).toBeInTheDocument();
  });

  it('deep-links timeline entries to their targets', async () => {
    vi.mocked(fetchTimeline).mockResolvedValue({
      entries: [entry({ id: 'a', sessionId: 's1', title: 'Task finished' })],
      nextBefore: null,
    });
    renderTimeline();
    await userEvent.click(await screen.findByRole('button', { name: /open task finished/i }));
    expect(await screen.findByText('session page')).toBeInTheDocument();
  });
});
