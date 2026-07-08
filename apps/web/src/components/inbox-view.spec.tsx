import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import userEvent from '@testing-library/user-event';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    fetchAttention: vi.fn(),
    ackAttentionItem: vi.fn(),
    approveDispatcherProposal: vi.fn(),
    resolveAttentionItem: vi.fn(),
    // The DigestCard at the top of the Inbox fetches this — keep it inert here.
    fetchDigest: vi.fn().mockResolvedValue(null),
  };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { InboxView } from './inbox-view';
import {
  ackAttentionItem,
  approveDispatcherProposal,
  fetchAttention,
  resolveAttentionItem,
  type AttentionItemDto,
} from '../lib/api';

function item(partial: Partial<AttentionItemDto>): AttentionItemDto {
  return {
    id: partial.id ?? 'i1',
    kind: partial.kind ?? 'permission',
    subjectId: partial.subjectId ?? 's1',
    projectPath: partial.projectPath ?? '/Users/me/nuncio',
    severity: partial.severity ?? 5,
    title: partial.title ?? 'Agent needs approval to run a command',
    payload: partial.payload ?? { sessionId: 's1' },
    status: 'open',
    acknowledgedAt: partial.acknowledgedAt ?? null,
    createdAt: partial.createdAt ?? Date.now() - 60_000,
    updatedAt: 0,
    resolvedAt: null,
  };
}

function renderInbox() {
  return render(
    <MemoryRouter initialEntries={['/inbox']}>
      <Routes>
        <Route path="/inbox" element={<InboxView onBack={vi.fn()} />} />
        <Route path="/session/:id" element={<div>session page</div>} />
        <Route path="/autopilot/:loopId" element={<div>loop page</div>} />
        <Route path="/forge/pr" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{location.pathname + location.search}</div>;
}

describe('InboxView', () => {
  beforeEach(() => {
    vi.mocked(fetchAttention).mockReset();
    vi.mocked(ackAttentionItem).mockReset().mockResolvedValue(item({ acknowledgedAt: 1 }));
    vi.mocked(approveDispatcherProposal).mockReset().mockResolvedValue({ proposalId: 'a', taskIds: ['t1', 't2'] });
    vi.mocked(resolveAttentionItem).mockReset().mockResolvedValue(item({ status: 'resolved' } as never));
  });

  it('shows the calm empty state when nothing needs the founder', async () => {
    vi.mocked(fetchAttention).mockResolvedValue({ items: [], counts: { total: 0, unacked: 0, bySeverity: {} } });
    renderInbox();
    await waitFor(() => expect(screen.getByText('Nothing needs you')).toBeInTheDocument());
  });

  it('renders items in the order the server returned (no re-sort)', async () => {
    vi.mocked(fetchAttention).mockResolvedValue({
      items: [
        item({ id: 'a', kind: 'permission', title: 'Approve command' }),
        item({ id: 'b', kind: 'pr-review', title: 'Review PR #42', payload: { url: 'https://ex/pr/42' } }),
      ],
      counts: { total: 2, unacked: 2, bySeverity: {} },
    });
    renderInbox();
    await waitFor(() => expect(screen.getByText('Approve command')).toBeInTheDocument());
    const titles = screen.getAllByText(/Approve command|Review PR #42/).map((n) => n.textContent);
    expect(titles).toEqual(['Approve command', 'Review PR #42']);
  });

  it('renders an unknown kind without crashing (humanized chip)', async () => {
    vi.mocked(fetchAttention).mockResolvedValue({
      items: [item({ id: 'x', kind: 'brand-new-signal', title: 'Something novel', payload: null })],
      counts: { total: 1, unacked: 1, bySeverity: {} },
    });
    renderInbox();
    await waitFor(() => expect(screen.getByText('Something novel')).toBeInTheDocument());
    expect(screen.getByText('Brand new signal')).toBeInTheDocument();
  });

  it('acks an item ("Seen")', async () => {
    vi.mocked(fetchAttention).mockResolvedValue({
      items: [item({ id: 'a' })],
      counts: { total: 1, unacked: 1, bySeverity: {} },
    });
    renderInbox();
    await waitFor(() => expect(screen.getByRole('button', { name: /mark .* seen/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /mark .* seen/i }));
    expect(ackAttentionItem).toHaveBeenCalledWith('a');
  });

  it('dismisses (resolves) an item', async () => {
    vi.mocked(fetchAttention).mockResolvedValue({
      items: [item({ id: 'a' })],
      counts: { total: 1, unacked: 1, bySeverity: {} },
    });
    renderInbox();
    await waitFor(() => expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(resolveAttentionItem).toHaveBeenCalledWith('a');
  });

  it('Open deep-links a permission item to its session', async () => {
    vi.mocked(fetchAttention).mockResolvedValue({
      items: [item({ id: 'a', kind: 'permission', payload: { sessionId: 'sess-9' } })],
      counts: { total: 1, unacked: 1, bySeverity: {} },
    });
    renderInbox();
    await waitFor(() => expect(screen.getByRole('button', { name: /^open/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /open/i }));
    expect(await screen.findByText('session page')).toBeInTheDocument();
  });

  it('Open deep-links a tripped-breaker to its loop', async () => {
    vi.mocked(fetchAttention).mockResolvedValue({
      items: [item({ id: 'a', kind: 'tripped-breaker', title: 'Nightly deps stopped after 3 fails', payload: { loopId: 'loop-3' } })],
      counts: { total: 1, unacked: 1, bySeverity: {} },
    });
    renderInbox();
    await waitFor(() => expect(screen.getByText('Nightly deps stopped after 3 fails')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /open/i }));
    expect(await screen.findByText('loop page')).toBeInTheDocument();
  });

  it('Open deep-links a pr-review item to the in-app PR view', async () => {
    vi.mocked(fetchAttention).mockResolvedValue({
      items: [
        item({
          id: 'a',
          kind: 'pr-review',
          title: 'Review PR #42',
          projectPath: '/Users/me/nuncio',
          payload: { projectPath: '/Users/me/nuncio', number: 42, url: 'https://github.com/o/r/pull/42' },
        }),
      ],
      counts: { total: 1, unacked: 1, bySeverity: {} },
    });
    renderInbox();
    await waitFor(() => expect(screen.getByText('Review PR #42')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /^open "review pr #42"$/i }));
    expect(screen.getByTestId('loc').textContent).toBe('/forge/pr?path=%2FUsers%2Fme%2Fnuncio&number=42');
  });

  it('does not render the redundant external-link action for pr-review rows', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    vi.mocked(fetchAttention).mockResolvedValue({
      items: [
        item({
          id: 'a',
          kind: 'pr-review',
          title: 'Review PR #42',
          projectPath: '/Users/me/nuncio',
          payload: { projectPath: '/Users/me/nuncio', number: 42, url: 'https://github.com/o/r/pull/42' },
        }),
      ],
      counts: { total: 1, unacked: 1, bySeverity: {} },
    });
    renderInbox();
    await waitFor(() => expect(screen.getByText('Review PR #42')).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: /open "review pr #42" on github\/gitlab/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^open "review pr #42"$/i }));

    expect(open).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('acked items render muted (Seen) inline, not re-sorted', async () => {
    vi.mocked(fetchAttention).mockResolvedValue({
      items: [item({ id: 'a', acknowledgedAt: Date.now(), title: 'Already seen' })],
      counts: { total: 1, unacked: 0, bySeverity: {} },
    });
    renderInbox();
    await waitFor(() => expect(screen.getByText('Already seen')).toBeInTheDocument());
    expect(screen.getByText('Seen')).toBeInTheDocument();
    // An acked item exposes no "Seen" action button (already seen).
    expect(screen.queryByRole('button', { name: /mark .* seen/i })).not.toBeInTheDocument();
  });

  it('renders dispatcher proposals as a distinct expandable row', async () => {
    vi.mocked(fetchAttention).mockResolvedValue({
      items: [
        item({
          id: 'a',
          kind: 'dispatcher-proposal',
          projectPath: null,
          title: 'Dispatcher proposal for 2026-07-09',
          payload: {
            proposals: [
              { title: 'Fix flaky tests', prompt: 'fix', projectPath: '/Users/me/nuncio', rationale: 'source: failing verify' },
              { title: 'Review PR', prompt: 'review', projectPath: '/Users/me/api', rationale: 'source: open pr-review item' },
            ],
          },
        }),
      ],
      counts: { total: 1, unacked: 1, bySeverity: {} },
    });
    renderInbox();
    await waitFor(() => expect(screen.getByText("Tomorrow's plan - 2 proposals")).toBeInTheDocument());
    expect(screen.queryByText('Fix flaky tests')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /show dispatcher proposals/i }));
    expect(screen.getByText('Fix flaky tests')).toBeInTheDocument();
    expect(screen.getByText('nuncio')).toBeInTheDocument();
    expect(screen.getByText('source: failing verify')).toBeInTheDocument();
  });

  it('approves dispatcher proposals once and reports queued tasks', async () => {
    vi.mocked(approveDispatcherProposal).mockResolvedValue({ proposalId: 'a', taskIds: ['t1'] });
    vi.mocked(fetchAttention)
      .mockResolvedValueOnce({
        items: [
          item({
            id: 'a',
            kind: 'dispatcher-proposal',
            payload: { proposals: [{ title: 'Fix flaky tests', prompt: 'fix', projectPath: '/Users/me/nuncio', rationale: 'source: failing verify' }] },
          }),
        ],
        counts: { total: 1, unacked: 1, bySeverity: {} },
      })
      .mockResolvedValue({ items: [], counts: { total: 0, unacked: 0, bySeverity: {} } });
    renderInbox();
    const approve = await screen.findByRole('button', { name: /approve/i });
    await userEvent.dblClick(approve);
    expect(approveDispatcherProposal).toHaveBeenCalledTimes(1);
    expect(approveDispatcherProposal).toHaveBeenCalledWith('a');
    expect(await screen.findByText('Nothing needs you')).toBeInTheDocument();
    const { toast } = await import('sonner');
    expect(toast.success).toHaveBeenCalledWith('1 task queued');
  });

  it('shows approved dispatcher proposals as done if refetched before resolve', async () => {
    vi.mocked(fetchAttention).mockResolvedValue({
      items: [
        item({
          id: 'a',
          kind: 'dispatcher-proposal',
          payload: {
            approvedAt: 1,
            taskIds: ['t1', 't2'],
            proposals: [
              { title: 'Fix flaky tests', prompt: 'fix', projectPath: '/Users/me/nuncio', rationale: 'source: failing verify' },
              { title: 'Review PR', prompt: 'review', projectPath: '/Users/me/api', rationale: 'source: open pr-review item' },
            ],
          },
        }),
      ],
      counts: { total: 1, unacked: 1, bySeverity: {} },
    });
    renderInbox();
    await waitFor(() => expect(screen.getByText('Done - 2 tasks queued')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
  });

  it('keeps the dispatcher row open and shows an error toast when approve fails', async () => {
    vi.mocked(approveDispatcherProposal).mockRejectedValue(new Error('Dispatcher offline'));
    vi.mocked(fetchAttention).mockResolvedValue({
      items: [
        item({
          id: 'a',
          kind: 'dispatcher-proposal',
          payload: { proposals: [{ title: 'Fix flaky tests', prompt: 'fix', projectPath: '/Users/me/nuncio', rationale: 'source: failing verify' }] },
        }),
      ],
      counts: { total: 1, unacked: 1, bySeverity: {} },
    });
    renderInbox();
    await userEvent.click(await screen.findByRole('button', { name: /approve/i }));
    const { toast } = await import('sonner');
    expect(toast.error).toHaveBeenCalledWith('Dispatcher offline');
    expect(screen.getByText("Tomorrow's plan - 1 proposal")).toBeInTheDocument();
  });
});
