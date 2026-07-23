import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { AttentionItemDto } from '../lib/api';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    fetchAttention: vi.fn(),
    approveDispatcherProposal: vi.fn(),
    resolveAttentionItem: vi.fn(),
    actChip: vi.fn(),
    dismissChip: vi.fn(),
    relativeTime: () => 'now',
  };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AttentionQueue } from './attention-queue';
import { fetchAttention, resolveAttentionItem } from '../lib/api';

function item(id: string, kind: string, title: string): AttentionItemDto {
  return {
    id,
    kind,
    subjectId: `${id}-subject`,
    projectPath: '/Users/me/nuncio',
    severity: 1,
    title,
    payload:
      kind === 'pr-review'
        ? { projectPath: '/Users/me/nuncio', number: Number(id.replace(/\D/g, '')) || 1 }
        : { sessionId: `${id}-session` },
    status: 'open',
    acknowledgedAt: null,
    createdAt: 1,
    updatedAt: 1,
    resolvedAt: null,
  };
}

function renderQueue(items: AttentionItemDto[]) {
  vi.mocked(fetchAttention).mockResolvedValue({
    items,
    counts: { total: items.length, unacked: items.length, bySeverity: {} },
  });
  return render(
    <MemoryRouter>
      <AttentionQueue />
    </MemoryRouter>,
  );
}

describe('AttentionQueue consecutive grouping', () => {
  beforeEach(() => {
    vi.mocked(fetchAttention).mockReset();
    vi.mocked(resolveAttentionItem).mockReset();
  });

  it('collapses two consecutive items of the same kind and expands to their normal rows', async () => {
    renderQueue([
      item('pr-1', 'pr-review', 'Review PR #1'),
      item('pr-2', 'pr-review', 'Review PR #2'),
    ]);

    const group = await screen.findByRole('button', { name: 'Show 2 PRs waiting for review' });
    expect(screen.queryByText('Review PR #1')).not.toBeInTheDocument();
    await userEvent.click(group);
    expect(screen.getByText('Review PR #1')).toBeInTheDocument();
    expect(screen.getByText('Review PR #2')).toBeInTheDocument();
  });

  it('keeps a singleton as a plain row', async () => {
    renderQueue([item('permission-1', 'permission', 'Answer the agent')]);

    expect(await screen.findByText('Answer the agent')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show 1 /i })).not.toBeInTheDocument();
  });

  it('never groups matching kinds across an intervening item', async () => {
    renderQueue([
      item('pr-1', 'pr-review', 'Review PR #1'),
      item('permission-1', 'permission', 'Answer the agent'),
      item('pr-2', 'pr-review', 'Review PR #2'),
    ]);

    await waitFor(() => expect(screen.getByText('Review PR #1')).toBeInTheDocument());
    expect(screen.getByText('Answer the agent')).toBeInTheDocument();
    expect(screen.getByText('Review PR #2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show 2 prs/i })).not.toBeInTheDocument();
  });

  it('keeps a kind expanded when an 8-second refresh changes its first member', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const initial = [
      item('pr-1', 'pr-review', 'Review PR #1'),
      item('pr-2', 'pr-review', 'Review PR #2'),
      item('pr-3', 'pr-review', 'Review PR #3'),
    ];
    const refreshed = initial.slice(1);
    vi.mocked(fetchAttention)
      .mockResolvedValueOnce({
        items: initial,
        counts: { total: 3, unacked: 3, bySeverity: {} },
      })
      .mockResolvedValueOnce({
        items: refreshed,
        counts: { total: 2, unacked: 2, bySeverity: {} },
      });
    try {
      render(
        <MemoryRouter>
          <AttentionQueue />
        </MemoryRouter>,
      );
      await act(async () => undefined);
      fireEvent.click(screen.getByRole('button', { name: 'Show 3 PRs waiting for review' }));
      expect(screen.getByText('Review PR #1')).toBeInTheDocument();

      await act(async () => vi.advanceTimersByTimeAsync(8000));

      expect(screen.getByRole('button', { name: 'Hide 2 PRs waiting for review' })).toBeInTheDocument();
      expect(screen.getByText('Review PR #2')).toBeInTheDocument();
      expect(screen.getByText('Review PR #3')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs an item action from inside an expanded group', async () => {
    const first = item('pr-1', 'pr-review', 'Review PR #1');
    const second = item('pr-2', 'pr-review', 'Review PR #2');
    renderQueue([first, second]);
    vi.mocked(resolveAttentionItem).mockResolvedValue(first);

    await userEvent.click(await screen.findByRole('button', { name: 'Show 2 PRs waiting for review' }));
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss "Review PR #1"' }));

    expect(resolveAttentionItem).toHaveBeenCalledWith('pr-1');
  });

  it('keeps every overlapping item action visibly busy until its own request settles', async () => {
    const first = item('permission-1', 'permission', 'Answer agent');
    const second = item('loop-1', 'tripped-breaker', 'Resume loop');
    renderQueue([first, second]);
    const pending = new Map<string, (value: AttentionItemDto) => void>();
    vi.mocked(resolveAttentionItem).mockImplementation((id) => new Promise((resolve) => {
      pending.set(id, resolve);
    }));

    const firstButton = await screen.findByRole('button', { name: 'Dismiss "Answer agent"' });
    const secondButton = screen.getByRole('button', { name: 'Dismiss "Resume loop"' });
    fireEvent.click(firstButton);
    fireEvent.click(secondButton);

    await waitFor(() => {
      expect(firstButton).toBeDisabled();
      expect(secondButton).toBeDisabled();
    });

    await act(async () => pending.get('permission-1')?.(first));
    await waitFor(() => {
      expect(firstButton).not.toBeDisabled();
      expect(secondButton).toBeDisabled();
    });
    await act(async () => pending.get('loop-1')?.(second));
  });

  it('renders acknowledged rows inside an expanded group as Seen', async () => {
    const seen = { ...item('pr-1', 'pr-review', 'Review PR #1'), acknowledgedAt: 42 };
    renderQueue([seen, item('pr-2', 'pr-review', 'Review PR #2')]);

    await userEvent.click(await screen.findByRole('button', { name: 'Show 2 PRs waiting for review' }));

    expect(screen.getByText('Seen')).toBeInTheDocument();
    expect(screen.getByText('Review PR #1').closest('li')).toHaveClass('opacity-65');
  });
});
